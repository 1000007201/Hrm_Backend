import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { EmployeeRole, Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { accrueForOrg } from "../lib/leaveAccrual.js";

const MANAGER_ROLES = [EmployeeRole.ADMIN, EmployeeRole.HR];

const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });

const accrualRunBodySchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
});

// Every active leave type for the org, joined in memory with any existing
// LeaveBalance row for (employee, year) — a type with no row yet (accrual
// hasn't run this year) still shows up, at zero, instead of being omitted.
const getEmployeeLeaveBalances = async (organizationId: string, employeeId: string, year: number) => {
  const [leaveTypes, balances] = await Promise.all([
    prisma.leaveType.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.leaveBalance.findMany({ where: { organizationId, employeeId, year } }),
  ]);

  const balanceByLeaveTypeId = new Map(balances.map((balance) => [balance.leaveTypeId, balance]));
  const zero = new Prisma.Decimal(0);

  return leaveTypes.map((leaveType) => {
    const balance = balanceByLeaveTypeId.get(leaveType.id);
    const accruedDays = balance?.accruedDays ?? zero;
    const usedDays = balance?.usedDays ?? zero;
    return {
      leaveTypeId: leaveType.id,
      code: leaveType.code,
      name: leaveType.name,
      accruedDays,
      usedDays,
      availableDays: accruedDays.minus(usedDays),
    };
  });
};

export const leaveRoutes = async (app: FastifyInstance) => {
  app.get("/leave/types", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    const leaveTypes = await prisma.leaveType.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        code: true,
        accrualPerMonth: true,
        annualCap: true,
        isPaid: true,
        allowHalfDay: true,
      },
      orderBy: { code: "asc" },
    });

    return ok({ leaveTypes });
  });

  app.get("/leave/balances/me", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const year = new Date().getFullYear();

    const balances = await getEmployeeLeaveBalances(organizationId, employeeId, year);
    return ok({ year, balances });
  });

  app.get("/leave/balances/:employeeId", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { employeeId } = employeeIdParamSchema.parse(request.params);

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId }, select: { id: true } });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const year = new Date().getFullYear();
    const balances = await getEmployeeLeaveBalances(organizationId, employeeId, year);
    return ok({ year, balances });
  });

  // ADMIN only (not HR) — this credits real balances, so it's kept narrower
  // than the HR-inclusive read/CRUD gate used elsewhere.
  app.post("/admin/leave/accrual/run", { preHandler: app.requireRole([EmployeeRole.ADMIN]) }, async (request) => {
    const { organizationId } = request.auth;
    const now = new Date();
    const { year = now.getFullYear(), month = now.getMonth() + 1 } = accrualRunBodySchema.parse(request.body ?? {});

    const result = await accrueForOrg(organizationId, year, month);
    return ok(result);
  });
};
