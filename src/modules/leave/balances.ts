import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface EffectiveAvailableParams {
  organizationId: string;
  employeeId: string;
  leaveTypeId: string;
  year: number;
}

// Reservation rule (submission-time only): what's actually available to
// spend right now is what's been accrued, minus what's already been
// deducted (usedDays), minus what this employee has already reserved via
// their own PENDING requests for the same type/year. That reservation term
// is what stops two overlapping/oversized pending submits from both fitting
// under the same balance.
//
// Approval does NOT use this — by the time a request is being approved, the
// only thing that matters is whether the real balance (accrued - used)
// still covers it; other still-pending requests are each independently
// judged on their own later, so they shouldn't block *this* approval. See
// the comment at POST /leave/requests/:id/approve in src/modules/leave/leaveRequests.service.ts.
export const getEffectiveAvailableDays = async (
  db: Db,
  { organizationId, employeeId, leaveTypeId, year }: EffectiveAvailableParams,
): Promise<Prisma.Decimal> => {
  const [balance, pendingRequests] = await Promise.all([
    db.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    }),
    db.leaveRequest.findMany({
      where: {
        organizationId,
        employeeId,
        leaveTypeId,
        status: "PENDING",
        startDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
      },
      select: { workingDays: true },
    }),
  ]);

  const accruedDays = balance?.accruedDays ?? new Prisma.Decimal(0);
  const usedDays = balance?.usedDays ?? new Prisma.Decimal(0);
  const pendingDays = pendingRequests.reduce((total, request) => total.plus(request.workingDays), new Prisma.Decimal(0));

  return accruedDays.minus(usedDays).minus(pendingDays);
};
