import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  AttendanceSource,
  AttendanceStatus,
  EmployeeRole,
  Prisma,
  RegularizationType,
} from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { env } from "../env.js";
import { isSameUtcCalendarDay, toUtcDateKey, utcMidnight } from "../lib/workingDays.js";
import { deriveDailyStatus, loadAttendanceContext, statusFromWorkedMinutes, toWorkedMinutes } from "../lib/attendance.js";

const APPROVER_ROLES = [EmployeeRole.MANAGER, EmployeeRole.HR, EmployeeRole.ADMIN];
const HALF_DAY_THRESHOLD_MINUTES = env.ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES;

const idParamSchema = z.object({ id: z.string().min(1) });

const listMineQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
});

const decisionBodySchema = z.object({
  decisionNote: z.string().trim().min(1).max(500).optional(),
});

const createRegularizationSchema = z
  .object({
    date: z.coerce.date(),
    type: z.enum(RegularizationType),
    requestedCheckInAt: z.coerce.date().optional(),
    requestedCheckOutAt: z.coerce.date().optional(),
    requestedStatus: z.enum(AttendanceStatus).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine(
    (data) =>
      data.requestedCheckInAt !== undefined ||
      data.requestedCheckOutAt !== undefined ||
      data.requestedStatus !== undefined,
    { message: "Provide at least one of requestedCheckInAt, requestedCheckOutAt or requestedStatus" },
  )
  .refine((data) => !data.requestedCheckInAt || isSameUtcCalendarDay(data.requestedCheckInAt, data.date), {
    message: "requestedCheckInAt must fall on the date being regularized",
    path: ["requestedCheckInAt"],
  })
  // Not required to be the same day: an overnight shift legitimately checks
  // out after midnight. It just has to be after the check-in.
  .refine(
    (data) =>
      !data.requestedCheckInAt || !data.requestedCheckOutAt || data.requestedCheckOutAt > data.requestedCheckInAt,
    { message: "requestedCheckOutAt must be after requestedCheckInAt", path: ["requestedCheckOutAt"] },
  );

const requesterSelect = { employee: { select: { id: true, fullName: true } } } as const;

export const regularizationRoutes = async (app: FastifyInstance) => {
  app.post("/attendance/regularizations", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId } = request.auth;
    const body = createRegularizationSchema.parse(request.body);
    const date = utcMidnight(body.date);
    const today = utcMidnight(new Date());

    if (date > today) {
      throw new AppError(400, "VALIDATION", "Cannot regularize a future date");
    }

    // Reuse the same reconciliation every attendance view uses, rather than
    // re-deriving "is this a working day" here.
    const context = await loadAttendanceContext(prisma, organizationId, [employeeId], date, date);
    const derived = deriveDailyStatus({
      date,
      today,
      holidayDateKeys: context.holidayDateKeys,
      approvedLeaveDateKeys: context.approvedLeaveDateKeysByEmployeeId.get(employeeId) ?? new Set(),
      record: null,
      halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
    });
    if (derived === AttendanceStatus.WEEK_OFF) {
      throw new AppError(409, "CONFLICT", "That date is a week off — there is nothing to regularize");
    }
    if (derived === AttendanceStatus.HOLIDAY) {
      throw new AppError(409, "CONFLICT", "That date is a company holiday — there is nothing to regularize");
    }

    const existingPending = await prisma.regularizationRequest.findFirst({
      where: { employeeId, date, status: "PENDING" },
      select: { id: true },
    });
    if (existingPending) {
      throw new AppError(409, "CONFLICT", "You already have a pending regularization for that date");
    }

    // The check above loses a race between two concurrent submits; the
    // partial unique index (see prisma/schema.prisma) is the real guarantee
    // and surfaces as 409 CONFLICT via the central P2002 mapping.
    // Fields listed explicitly, not spread from `body` — spreading would
    // re-introduce the raw parsed `date` and undo the utcMidnight
    // normalization above.
    const regularization = await prisma.regularizationRequest.create({
      data: {
        organizationId,
        employeeId,
        date,
        type: body.type,
        requestedCheckInAt: body.requestedCheckInAt,
        requestedCheckOutAt: body.requestedCheckOutAt,
        requestedStatus: body.requestedStatus,
        reason: body.reason,
      },
      include: requesterSelect,
    });

    reply.status(201);
    return ok({ regularization });
  });

  app.get("/attendance/regularizations/me", { preHandler: app.requireAuth }, async (request) => {
    const { employeeId } = request.auth;
    const { status } = listMineQuerySchema.parse(request.query);

    const regularizations = await prisma.regularizationRequest.findMany({
      where: { employeeId, ...(status ? { status } : {}) },
      orderBy: { date: "desc" },
    });

    return ok({ regularizations });
  });

  app.post("/attendance/regularizations/:id/cancel", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const { count } = await prisma.regularizationRequest.updateMany({
      where: { id, organizationId, employeeId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    if (count === 0) {
      const existing = await prisma.regularizationRequest.findFirst({ where: { id, organizationId, employeeId } });
      if (!existing) {
        throw new AppError(404, "NOT_FOUND", "Regularization request not found");
      }
      throw new AppError(409, "CONFLICT", "Only a pending request can be cancelled");
    }

    const regularization = await prisma.regularizationRequest.findUniqueOrThrow({ where: { id } });
    return ok({ regularization });
  });

  // Approver queue, with the CURRENT derived status for each request's date
  // so the approver sees before (currentStatus) vs after (what's requested).
  app.get("/attendance/regularizations/pending", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const pending = await prisma.regularizationRequest.findMany({
      where: { organizationId, status: "PENDING" },
      include: requesterSelect,
      orderBy: { createdAt: "asc" },
    });
    if (pending.length === 0) {
      return ok({ regularizations: [] });
    }

    // One bulk context spanning every requested date, so the before/after
    // column costs the same 3 queries whether the queue holds 1 row or 500.
    const dates = pending.map((item) => item.date.getTime());
    const context = await loadAttendanceContext(
      prisma,
      organizationId,
      [...new Set(pending.map((item) => item.employeeId))],
      new Date(Math.min(...dates)),
      new Date(Math.max(...dates)),
    );
    const today = utcMidnight(new Date());

    const regularizations = pending.map((item) => {
      const dateKey = toUtcDateKey(item.date);
      const record = context.recordsByEmployeeAndDateKey.get(`${item.employeeId}|${dateKey}`) ?? null;

      return {
        ...item,
        current: {
          status: deriveDailyStatus({
            date: item.date,
            today,
            holidayDateKeys: context.holidayDateKeys,
            approvedLeaveDateKeys: context.approvedLeaveDateKeysByEmployeeId.get(item.employeeId) ?? new Set(),
            record,
            halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
          }),
          checkInAt: record?.checkInAt ?? null,
          checkOutAt: record?.checkOutAt ?? null,
          workedMinutes: record?.workedMinutes ?? null,
        },
      };
    });

    return ok({ regularizations });
  });

  // Any MANAGER/HR/ADMIN in the org can decide — same flexible routing as
  // leave approvals, not strict manager-of-record.
  // TODO: self-approval is allowed (an approver-role employee can approve
  // their own regularization). Revisit as a policy option alongside the same
  // TODO on leave approvals in src/routes/leaveRequests.ts.
  app.post("/attendance/regularizations/:id/approve", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    // Serializable: re-reading the request and the attendance record then
    // writing both is a read-then-write two approvers could otherwise race.
    const result = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.regularizationRequest.findFirst({ where: { id, organizationId } });
        if (!existing) {
          throw new AppError(404, "NOT_FOUND", "Regularization request not found");
        }
        if (existing.status !== "PENDING") {
          throw new AppError(409, "CONFLICT", "This request is no longer pending");
        }

        const record = await tx.attendanceRecord.findUnique({
          where: { employeeId_date: { employeeId: existing.employeeId, date: existing.date } },
        });

        // A null requested field means "leave it alone", so merge onto what's
        // already stored rather than blanking it.
        const checkInAt = existing.requestedCheckInAt ?? record?.checkInAt ?? null;
        const checkOutAt = existing.requestedCheckOutAt ?? record?.checkOutAt ?? null;
        const workedMinutes = checkInAt && checkOutAt ? toWorkedMinutes(checkInAt, checkOutAt) : null;
        // An explicitly requested status wins; otherwise fall back to the
        // shared worked-time rule so a pure missing-punch fix lands on the
        // same PRESENT/HALF_DAY split a self check-out would have produced.
        const status = existing.requestedStatus ?? statusFromWorkedMinutes(workedMinutes, HALF_DAY_THRESHOLD_MINUTES);

        const data = {
          checkInAt,
          checkOutAt,
          workedMinutes,
          status,
          source: AttendanceSource.REGULARIZED,
          note: existing.reason,
        } as const;

        const attendanceRecord = await tx.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId: existing.employeeId, date: existing.date } },
          create: { organizationId, employeeId: existing.employeeId, date: existing.date, ...data },
          update: data,
        });

        const regularization = await tx.regularizationRequest.update({
          where: { id },
          data: {
            status: "APPROVED",
            decidedByEmployeeId: approverEmployeeId,
            decidedAt: new Date(),
            decisionNote,
          },
        });

        return { regularization, attendanceRecord };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return ok(result);
  });

  // No attendance change on reject — the request only ever described a
  // proposed correction; nothing was applied while it was pending.
  app.post("/attendance/regularizations/:id/reject", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const { count } = await prisma.regularizationRequest.updateMany({
      where: { id, organizationId, status: "PENDING" },
      data: { status: "REJECTED", decidedByEmployeeId: approverEmployeeId, decidedAt: new Date(), decisionNote },
    });
    if (count === 0) {
      const existing = await prisma.regularizationRequest.findFirst({ where: { id, organizationId } });
      if (!existing) {
        throw new AppError(404, "NOT_FOUND", "Regularization request not found");
      }
      throw new AppError(409, "CONFLICT", "This request is no longer pending");
    }

    const regularization = await prisma.regularizationRequest.findUniqueOrThrow({ where: { id } });
    return ok({ regularization });
  });
};
