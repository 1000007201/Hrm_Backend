import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { EmployeeRole } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { buildOrgChartTree } from "../lib/orgChart.js";

const managerSelect = { manager: { select: { id: true, fullName: true } } } as const;
const MANAGER_ROLES = [EmployeeRole.ADMIN, EmployeeRole.HR];

// Lightweight, non-sensitive projection used by both org-chart endpoints —
// no email, no organizationId, nothing beyond what's needed to render a tree.
const lightweightEmployeeSelect = {
  id: true,
  fullName: true,
  role: true,
  designation: true,
  userId: true,
} as const;

const creatableRoleSchema = z.enum(["HR", "MANAGER", "EMPLOYEE"]);
const emailSchema = z.email().trim().toLowerCase();

const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: emailSchema,
  role: creatableRoleSchema,
  designation: z.string().trim().min(1).max(200).optional(),
  managerId: z.string().min(1).optional(),
});

const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: emailSchema.optional(),
  role: creatableRoleSchema.optional(),
  designation: z.string().trim().min(1).max(200).nullable().optional(),
  managerId: z.string().min(1).nullable().optional(),
});

const idParamSchema = z.object({ id: z.string().min(1) });

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// managerId must reference an existing Employee in the same org — not
// something a DB constraint can enforce (the FK is to Employee.id globally),
// so it stays a manual check. Throws AppError on failure.
const validateManagerId = async (managerId: string, organizationId: string, selfId?: string): Promise<void> => {
  if (managerId === selfId) {
    throw new AppError(400, "VALIDATION", "An employee cannot be their own manager");
  }
  const manager = await prisma.employee.findFirst({ where: { id: managerId, organizationId } });
  if (!manager) {
    throw new AppError(400, "VALIDATION", "managerId must reference an employee in your organization");
  }
};

export const employeeRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request, reply) => {
    const { fullName, email, role, designation, managerId } = createEmployeeSchema.parse(request.body);
    const { organizationId } = request.auth;

    if (managerId) {
      await validateManagerId(managerId, organizationId);
    }

    // Duplicate email in-org is caught by the organizationId_email unique
    // constraint and mapped to 409 CONFLICT centrally — no pre-check needed.
    const employee = await prisma.employee.create({
      data: { organizationId, fullName, email, role, designation, managerId },
      include: managerSelect,
    });

    reply.status(201);
    return ok({ employee });
  });

  app.patch("/api/employees/:id", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const body = updateEmployeeSchema.parse(request.body);
    const { managerId } = body;

    const existing = await prisma.employee.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    if (managerId) {
      await validateManagerId(managerId, organizationId, id);
    }

    const employee = await prisma.employee.update({
      where: { id },
      data: body,
      include: managerSelect,
    });

    return ok({ employee });
  });

  app.get("/api/employees", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { page, pageSize } = listQuerySchema.parse(request.query);

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where: { organizationId },
        include: managerSelect,
        orderBy: { fullName: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.employee.count({ where: { organizationId } }),
    ]);

    return ok({ employees, page, pageSize, total });
  });

  app.get("/api/employees/:id", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const employee = await prisma.employee.findFirst({
      where: { id, organizationId },
      include: managerSelect,
    });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    return ok({ employee });
  });

  // Any authenticated org member can view the chart — it's read-only and
  // carries no sensitive fields (no email), unlike the ADMIN/HR-gated CRUD
  // above.
  app.get("/api/employees/org-chart", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    // Single query for the whole org; the tree is assembled in memory by
    // buildOrgChartTree (src/lib/orgChart.ts) — no per-node recursion into
    // the DB.
    const employees = await prisma.employee.findMany({
      where: { organizationId },
      select: { ...lightweightEmployeeSelect, managerId: true },
    });

    const tree = buildOrgChartTree(employees, (message) => request.log.warn(message));
    return ok({ tree });
  });

  app.get("/api/employees/:id/reports", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const manager = await prisma.employee.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!manager) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const reports = await prisma.employee.findMany({
      where: { organizationId, managerId: id },
      select: lightweightEmployeeSelect,
      orderBy: { fullName: "asc" },
    });

    return ok({
      reports: reports.map(({ userId, ...employee }) => ({ ...employee, hasPortalAccess: userId !== null })),
    });
  });
};
