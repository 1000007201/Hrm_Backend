import {
  AttendanceSource,
  AttendanceStatus,
  Prisma,
  type PrismaClient,
  type RegularizationType,
} from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { env } from "../../env.js";
import { toUtcDateKey, utcMidnight } from "../../shared/workingDays.js";
import { deriveDailyStatus, loadAttendanceContext, statusFromWorkedMinutes, toWorkedMinutes } from "./derivation.js";

// Business operations for employee-initiated attendance corrections.
// Approving is the only path that writes to AttendanceRecord; the request row
// is kept either way as the audit trail.
const HALF_DAY_THRESHOLD_MINUTES = env.ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES;

const requesterSelect = { employee: { select: { id: true, fullName: true } } } as const;

export interface SubmitRegularizationParams {
  organizationId: string;
  employeeId: string;
  date: Date;
  type: RegularizationType;
  requestedCheckInAt?: Date;
  requestedCheckOutAt?: Date;
  requestedStatus?: AttendanceStatus;
  reason: string;
}

export const submitRegularization = async (prisma: PrismaClient, params: SubmitRegularizationParams) => {
  const { organizationId, employeeId, type, requestedCheckInAt, requestedCheckOutAt, requestedStatus, reason } = params;
  const date = utcMidnight(params.date);
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

  // The check above loses a race between two concurrent submits; the partial
  // unique index (see prisma/schema.prisma) is the real guarantee and
  // surfaces as 409 CONFLICT via the central P2002 mapping.
  return prisma.regularizationRequest.create({
    data: { organizationId, employeeId, date, type, requestedCheckInAt, requestedCheckOutAt, requestedStatus, reason },
    include: requesterSelect,
  });
};

export const cancelRegularization = async (
  prisma: PrismaClient,
  params: { id: string; organizationId: string; employeeId: string },
) => {
  const { id, organizationId, employeeId } = params;

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

  return prisma.regularizationRequest.findUniqueOrThrow({ where: { id } });
};

// The approver queue, each row carrying the CURRENT derived status for its
// date so the approver sees before (current) vs after (what's requested).
// One bulk context spanning every queued date keeps this at a constant
// number of queries whether the queue holds 1 row or 500.
export const listPendingRegularizations = async (prisma: PrismaClient, organizationId: string) => {
  const pending = await prisma.regularizationRequest.findMany({
    where: { organizationId, status: "PENDING" },
    include: requesterSelect,
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) {
    return [];
  }

  const dates = pending.map((item) => item.date.getTime());
  const context = await loadAttendanceContext(
    prisma,
    organizationId,
    [...new Set(pending.map((item) => item.employeeId))],
    new Date(Math.min(...dates)),
    new Date(Math.max(...dates)),
  );
  const today = utcMidnight(new Date());

  return pending.map((item) => {
    const record = context.recordsByEmployeeAndDateKey.get(`${item.employeeId}|${toUtcDateKey(item.date)}`) ?? null;

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
};

export interface DecideRegularizationParams {
  id: string;
  organizationId: string;
  approverEmployeeId: string;
  decisionNote?: string;
}

// Self-approval is allowed: any MANAGER/HR/ADMIN in the org can decide any
// pending request, including their own.
// TODO: revisit as a policy option alongside the same open question on leave
// approvals in src/modules/leave/leaveRequests.service.ts.
export const approveRegularization = async (prisma: PrismaClient, params: DecideRegularizationParams) => {
  const { id, organizationId, approverEmployeeId, decisionNote } = params;

  // Serializable: re-reading the request and the attendance record then
  // writing both is a read-then-write two approvers could otherwise race.
  return prisma.$transaction(
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
      // shared worked-time rule so a pure missing-punch fix lands on the same
      // PRESENT/HALF_DAY split a self check-out would have produced.
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
        data: { status: "APPROVED", decidedByEmployeeId: approverEmployeeId, decidedAt: new Date(), decisionNote },
      });

      return { regularization, attendanceRecord };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

// No attendance change on reject — the request only ever described a
// proposed correction; nothing was applied while it was pending.
export const rejectRegularization = async (prisma: PrismaClient, params: DecideRegularizationParams) => {
  const { id, organizationId, approverEmployeeId, decisionNote } = params;

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

  return prisma.regularizationRequest.findUniqueOrThrow({ where: { id } });
};
