import { prisma } from "./prisma.js";
import { Prisma } from "../generated/prisma/client.js";

export interface AccrualRunResult {
  year: number;
  month: number;
  employeesProcessed: number;
  employeesFailed: number;
  balancesCredited: number;
  balancesSkipped: number;
}

// Last instant of `month` (1-12) in `year`, local time — used only to decide
// "has this employee joined by this accrual month yet", not for day counting.
const endOfMonth = (year: number, month: number): Date => new Date(year, month, 0, 23, 59, 59, 999);

// Runs monthly accrual for one org. For each employee eligible by joiningDate
// and each active, accruing LeaveType, ensures a LeaveBalance(employee,
// leaveType, year) row exists and credits accrualPerMonth — capped at
// annualCap — UNLESS that month was already applied (lastAccruedMonth >=
// month), which is what makes re-running the same month a no-op and lets a
// missed month be applied later regardless of the current calendar month.
//
// All of one employee's balance updates for this run are wrapped in a single
// transaction, so a failure partway through (e.g. one leave type's update
// throws) rolls back that employee's whole batch instead of leaving them with
// some types credited and others not — accrual for other employees continues
// either way, and the failure is reported back in `employeesFailed`.
export const accrueForOrg = async (organizationId: string, year: number, month: number): Promise<AccrualRunResult> => {
  const [employees, leaveTypes] = await Promise.all([
    prisma.employee.findMany({
      where: { organizationId },
      select: { id: true, joiningDate: true },
    }),
    prisma.leaveType.findMany({
      where: { organizationId, isActive: true, accrualPerMonth: { gt: 0 } },
    }),
  ]);

  const cutoff = endOfMonth(year, month);
  const result: AccrualRunResult = {
    year,
    month,
    employeesProcessed: 0,
    employeesFailed: 0,
    balancesCredited: 0,
    balancesSkipped: 0,
  };

  if (leaveTypes.length === 0) {
    return result;
  }

  for (const employee of employees) {
    // Not yet joined as of this accrual month — joiningDate null means
    // "always eligible" (pre-existing employees with no recorded date).
    if (employee.joiningDate && employee.joiningDate > cutoff) {
      continue;
    }
    result.employeesProcessed += 1;

    try {
      const { credited, skipped } = await prisma.$transaction(async (tx) => {
        let credited = 0;
        let skipped = 0;

        for (const leaveType of leaveTypes) {
          const balance = await tx.leaveBalance.upsert({
            where: { employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: leaveType.id, year } },
            create: { organizationId, employeeId: employee.id, leaveTypeId: leaveType.id, year },
            update: {},
          });

          if (balance.lastAccruedMonth !== null && balance.lastAccruedMonth >= month) {
            skipped += 1;
            continue;
          }

          const remaining = Prisma.Decimal.max(new Prisma.Decimal(leaveType.annualCap).minus(balance.accruedDays), 0);
          const increment = Prisma.Decimal.min(leaveType.accrualPerMonth, remaining);

          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: { accruedDays: { increment }, lastAccruedMonth: month },
          });
          credited += 1;
        }

        return { credited, skipped };
      });

      result.balancesCredited += credited;
      result.balancesSkipped += skipped;
    } catch (err) {
      result.employeesFailed += 1;
      console.error(`[leaveAccrual] accrual failed for employee=${employee.id} org=${organizationId} ${year}-${month}`, err);
    }
  }

  return result;
};

// Runs accrueForOrg for every org, for the given (or current) month — this is
// what the shared-secret system endpoint / monthly cron calls.
export const accrueForAllOrgs = async (year: number, month: number): Promise<AccrualRunResult[]> => {
  const organizations = await prisma.organization.findMany({ select: { id: true } });
  const results: AccrualRunResult[] = [];
  for (const organization of organizations) {
    results.push(await accrueForOrg(organization.id, year, month));
  }
  return results;
};
