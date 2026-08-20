import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { EmployeeRole, Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { countWorkingDays, isSameUtcCalendarDay } from "../lib/workingDays.js";
import { getHolidayDateKeys } from "../lib/holidays.js";
import { getEffectiveAvailableDays } from "../lib/leaveRequests.js";

const APPROVER_ROLES = [EmployeeRole.MANAGER, EmployeeRole.HR, EmployeeRole.ADMIN];

const leaveTypeSummarySelect = { leaveType: { select: { id: true, name: true, code: true } } } as const;

const idParamSchema = z.object({ id: z.string().min(1) });

const statusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

const createLeaveRequestSchema = z
  .object({
    leaveTypeId: z.string().min(1),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    isHalfDay: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "endDate must be on or after startDate",
    path: ["endDate"],
  })
  .refine((data) => !data.isHalfDay || isSameUtcCalendarDay(data.startDate, data.endDate), {
    message: "isHalfDay is only valid for a single-day request",
    path: ["isHalfDay"],
  });

const listMyRequestsQuerySchema = z.object({ status: statusSchema.optional() });

const decisionBodySchema = z.object({
  decisionNote: z.string().trim().min(1).max(500).optional(),
});

export const leaveRequestRoutes = async (app: FastifyInstance) => {
  app.post("/leave/requests", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId } = request.auth;
    const { leaveTypeId, startDate, endDate, isHalfDay, reason } = createLeaveRequestSchema.parse(request.body);

    const leaveType = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, organizationId, isActive: true } });
    if (!leaveType) {
      throw new AppError(400, "VALIDATION", "leaveTypeId must reference an active leave type in your organization");
    }
    if (isHalfDay && !leaveType.allowHalfDay) {
      throw new AppError(400, "VALIDATION", "This leave type does not allow half-day requests");
    }

    // Company holidays are excluded alongside weekends, so leave spanning a
    // holiday costs the employee fewer days. Only NEW submissions are
    // affected — already-submitted requests keep the workingDays they were
    // stored with; editing the calendar never retroactively recomputes them.
    const holidayDateKeys = await getHolidayDateKeys(prisma, organizationId, startDate, endDate);
    const workingDays = countWorkingDays(startDate, endDate, isHalfDay, holidayDateKeys);
    if (workingDays <= 0) {
      throw new AppError(400, "VALIDATION", "The selected date range has no working days (weekends and company holidays don't count)");
    }

    const year = startDate.getUTCFullYear();

    // Serializable: submission does a read (overlap + reservation check)
    // followed by a conditional insert, which under the default READ
    // COMMITTED isolation two concurrent submits could both pass (neither
    // sees the other's uncommitted reservation). Serializable makes Postgres
    // abort one of two conflicting concurrent submits instead — surfaced by
    // the central error handler as 409 CONFLICT (Prisma P2034).
    const leaveRequest = await prisma.$transaction(
      async (tx) => {
        const overlapping = await tx.leaveRequest.findFirst({
          where: {
            employeeId,
            status: { in: ["PENDING", "APPROVED"] },
            startDate: { lte: endDate },
            endDate: { gte: startDate },
          },
        });
        if (overlapping) {
          throw new AppError(409, "CONFLICT", "You already have a leave request that overlaps these dates");
        }

        const effectiveAvailable = await getEffectiveAvailableDays(tx, { organizationId, employeeId, leaveTypeId, year });
        if (new Prisma.Decimal(workingDays).greaterThan(effectiveAvailable)) {
          throw new AppError(409, "CONFLICT", "Insufficient leave balance for the requested dates");
        }

        return tx.leaveRequest.create({
          data: { organizationId, employeeId, leaveTypeId, startDate, endDate, isHalfDay, reason, workingDays },
          include: leaveTypeSummarySelect,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    reply.status(201);
    return ok({ leaveRequest });
  });

  app.get("/leave/requests/me", { preHandler: app.requireAuth }, async (request) => {
    const { employeeId } = request.auth;
    const { status } = listMyRequestsQuerySchema.parse(request.query);

    const leaveRequests = await prisma.leaveRequest.findMany({
      where: { employeeId, ...(status ? { status } : {}) },
      include: leaveTypeSummarySelect,
      orderBy: { startDate: "desc" },
    });

    return ok({ leaveRequests });
  });

  // Requester cancels their OWN request — PENDING only for now (kept simple;
  // cancelling an already-APPROVED-but-future request is a possible later
  // extension). A pending request never touched usedDays, so cancelling just
  // frees the reservation — no balance mutation, no transaction needed.
  app.post("/leave/requests/:id/cancel", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const { count } = await prisma.leaveRequest.updateMany({
      where: { id, organizationId, employeeId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    if (count === 0) {
      const existing = await prisma.leaveRequest.findFirst({ where: { id, organizationId, employeeId } });
      if (!existing) {
        throw new AppError(404, "NOT_FOUND", "Leave request not found");
      }
      throw new AppError(409, "CONFLICT", "Only a pending request can be cancelled");
    }

    const leaveRequest = await prisma.leaveRequest.findUniqueOrThrow({ where: { id }, include: leaveTypeSummarySelect });
    return ok({ leaveRequest });
  });

  app.get("/leave/requests/pending", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const leaveRequests = await prisma.leaveRequest.findMany({
      where: { organizationId, status: "PENDING" },
      include: {
        employee: { select: { id: true, fullName: true } },
        ...leaveTypeSummarySelect,
      },
      orderBy: { createdAt: "asc" },
    });

    return ok({ leaveRequests });
  });

  // Any MANAGER/HR/ADMIN in the org can approve — flexible routing per the
  // locked decision, not strict manager-of-record. That includes approving
  // one's own request (self-approval isn't blocked here).
  // TODO: revisit whether self-approval should be disallowed once approval
  // routing gets stricter than "any approver-role employee in the org".
  app.post("/leave/requests/:id/approve", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    // Serializable for the same reason as submission: re-checking the
    // balance and then incrementing usedDays is a read-then-write that two
    // concurrent approvals (of two different pending requests against the
    // same balance row) could otherwise both pass under READ COMMITTED.
    const leaveRequest = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.leaveRequest.findFirst({ where: { id, organizationId } });
        if (!existing) {
          throw new AppError(404, "NOT_FOUND", "Leave request not found");
        }
        if (existing.status !== "PENDING") {
          throw new AppError(409, "CONFLICT", "This request is no longer pending");
        }

        // Deliberately NOT getEffectiveAvailableDays here: that formula
        // subtracts every PENDING request (including this one), which would
        // always fail. Approval only cares about the real, already-deducted
        // balance (accrued - used) — other still-pending requests are each
        // judged independently when their own turn comes.
        const year = existing.startDate.getUTCFullYear();
        const balance = await tx.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: { employeeId: existing.employeeId, leaveTypeId: existing.leaveTypeId, year },
          },
        });
        if (!balance || existing.workingDays.greaterThan(balance.accruedDays.minus(balance.usedDays))) {
          throw new AppError(409, "CONFLICT", "Insufficient leave balance to approve this request");
        }

        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { usedDays: { increment: existing.workingDays } },
        });

        return tx.leaveRequest.update({
          where: { id },
          data: { status: "APPROVED", decidedByEmployeeId: approverEmployeeId, decidedAt: new Date(), decisionNote },
          include: leaveTypeSummarySelect,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return ok({ leaveRequest });
  });

  // No balance change on reject — the request was only ever reserved
  // (subtracted in the effective-available formula), never deducted from
  // usedDays, so rejecting just frees the reservation like cancel does.
  app.post("/leave/requests/:id/reject", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const { count } = await prisma.leaveRequest.updateMany({
      where: { id, organizationId, status: "PENDING" },
      data: { status: "REJECTED", decidedByEmployeeId: approverEmployeeId, decidedAt: new Date(), decisionNote },
    });

    if (count === 0) {
      const existing = await prisma.leaveRequest.findFirst({ where: { id, organizationId } });
      if (!existing) {
        throw new AppError(404, "NOT_FOUND", "Leave request not found");
      }
      throw new AppError(409, "CONFLICT", "This request is no longer pending");
    }

    const leaveRequest = await prisma.leaveRequest.findUniqueOrThrow({ where: { id }, include: leaveTypeSummarySelect });
    return ok({ leaveRequest });
  });
};
