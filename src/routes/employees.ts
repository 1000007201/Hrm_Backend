import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authorizeEmployeeManager, isAuthError } from "../lib/authorizeEmployeeManager.js";

const managerSelect = { manager: { select: { id: true, fullName: true } } } as const;

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

// managerId must reference an existing Employee in the same org; returns a
// 400-shaped error string on failure, or null when it's fine to proceed.
const validateManagerId = async (
  managerId: string,
  organizationId: string,
  selfId?: string,
): Promise<string | null> => {
  if (managerId === selfId) {
    return "An employee cannot be their own manager";
  }
  const manager = await prisma.employee.findFirst({ where: { id: managerId, organizationId } });
  if (!manager) {
    return "managerId must reference an employee in your organization";
  }
  return null;
};

export const employeeRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees", async (request, reply) => {
    const auth = await authorizeEmployeeManager(request);
    if (isAuthError(auth)) {
      reply.status(auth.status);
      return { error: auth.error };
    }

    const parsed = createEmployeeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: z.prettifyError(parsed.error) };
    }
    const { fullName, email, role, designation, managerId } = parsed.data;
    const { organizationId } = auth;

    if (managerId) {
      const managerError = await validateManagerId(managerId, organizationId);
      if (managerError) {
        reply.status(400);
        return { error: managerError };
      }
    }

    const existing = await prisma.employee.findUnique({
      where: { organizationId_email: { organizationId, email } },
    });
    if (existing) {
      reply.status(409);
      return { error: "An employee with this email already exists in your organization" };
    }

    const employee = await prisma.employee.create({
      data: { organizationId, fullName, email, role, designation, managerId },
      include: managerSelect,
    });

    reply.status(201);
    return { employee };
  });

  app.patch("/api/employees/:id", async (request, reply) => {
    const auth = await authorizeEmployeeManager(request);
    if (isAuthError(auth)) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    const { organizationId } = auth;

    const paramsParsed = idParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(paramsParsed.error) };
    }
    const { id } = paramsParsed.data;

    const bodyParsed = updateEmployeeSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(bodyParsed.error) };
    }
    const { managerId, email } = bodyParsed.data;

    const existing = await prisma.employee.findFirst({ where: { id, organizationId } });
    if (!existing) {
      reply.status(404);
      return { error: "Employee not found" };
    }

    if (managerId) {
      const managerError = await validateManagerId(managerId, organizationId, id);
      if (managerError) {
        reply.status(400);
        return { error: managerError };
      }
    }

    if (email && email !== existing.email) {
      const emailOwner = await prisma.employee.findUnique({
        where: { organizationId_email: { organizationId, email } },
      });
      if (emailOwner) {
        reply.status(409);
        return { error: "An employee with this email already exists in your organization" };
      }
    }

    const employee = await prisma.employee.update({
      where: { id },
      data: bodyParsed.data,
      include: managerSelect,
    });

    return { employee };
  });

  app.get("/api/employees", async (request, reply) => {
    const auth = await authorizeEmployeeManager(request);
    if (isAuthError(auth)) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    const { organizationId } = auth;

    const queryParsed = listQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(queryParsed.error) };
    }
    const { page, pageSize } = queryParsed.data;

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

    return { employees, page, pageSize, total };
  });

  app.get("/api/employees/:id", async (request, reply) => {
    const auth = await authorizeEmployeeManager(request);
    if (isAuthError(auth)) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    const { organizationId } = auth;

    const paramsParsed = idParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(paramsParsed.error) };
    }

    const employee = await prisma.employee.findFirst({
      where: { id: paramsParsed.data.id, organizationId },
      include: managerSelect,
    });
    if (!employee) {
      reply.status(404);
      return { error: "Employee not found" };
    }

    return { employee };
  });
};
