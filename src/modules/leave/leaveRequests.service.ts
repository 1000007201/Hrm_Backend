import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { countWorkingDays } from "../../shared/workingDays.js";
import { getHolidayDateKeys } from "../holidays/holidays.js";
import { getEffectiveAvailableDays } from "./balances.js";

// Business operations for the leave-request lifecycle. Routes parse input,
// authorize, and call one of these — all the multi-step and transactional
// work lives here, so it can be unit-tested and reused (a cron or an admin
// script can call these without going through HTTP).

const leaveTypeSummarySelect = { leaveType: { select: { id: true, name: true, code: true } } } as const;

export interface SubmitLeaveRequestParams {
  organizationId: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  isHalfDay: boolean;
  reason?: string;
}

export const submitLeaveRequest = async (prisma: PrismaClient, params: SubmitLeaveRequestParams) => {
  const { organizationId, employeeId, leaveTypeId, startDate, endDate, isHalfDay, reason } = params;

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
    throw new AppError(
      400,
      "VALIDATION",
      "The selected date range has no working days (weekends and company holidays don't count)",
    );
  }

  const year = startDate.getUTCFullYear();

  // Serializable: submission does a read (overlap + reservation check)
  // followed by a conditional insert, which under the default READ
  // COMMITTED isolation two concurrent submits could both pass (neither
  // sees the other's uncommitted reservation). Serializable makes Postgres
  // abort one of two conflicting concurrent submits instead — surfaced by
  // the central error handler as 409 CONFLICT (Prisma P2034).
  return prisma.$transaction(
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
};

// A pending request never touched usedDays, so cancelling just frees the
// reservation — no balance mutation, no transaction needed.
export const cancelLeaveRequest = async (
  prisma: PrismaClient,
  params: { id: string; organizationId: string; employeeId: string },
) => {
  const { id, organizationId, employeeId } = params;

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

  return prisma.leaveRequest.findUniqueOrThrow({ where: { id }, include: leaveTypeSummarySelect });
};

export interface DecideLeaveRequestParams {
  id: string;
  organizationId: string;
  approverEmployeeId: string;
  decisionNote?: string;
}

// Self-approval is allowed: any MANAGER/HR/ADMIN in the org can approve any
// pending request, including their own (flexible routing per the locked
// decision, not strict manager-of-record).
// TODO: revisit whether self-approval should be disallowed once approval
// routing gets stricter than "any approver-role employee in the org".
export const approveLeaveRequest = async (prisma: PrismaClient, params: DecideLeaveRequestParams) => {
  const { id, organizationId, approverEmployeeId, decisionNote } = params;

  // Serializable for the same reason as submission: re-checking the balance
  // and then incrementing usedDays is a read-then-write that two concurrent
  // approvals (of two different pending requests against the same balance
  // row) could otherwise both pass under READ COMMITTED.
  return prisma.$transaction(
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
};

// No balance change on reject — the request was only ever reserved
// (subtracted in the effective-available formula), never deducted from
// usedDays, so rejecting just frees the reservation like cancel does.
export const rejectLeaveRequest = async (prisma: PrismaClient, params: DecideLeaveRequestParams) => {
  const { id, organizationId, approverEmployeeId, decisionNote } = params;

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

  return prisma.leaveRequest.findUniqueOrThrow({ where: { id }, include: leaveTypeSummarySelect });
};
