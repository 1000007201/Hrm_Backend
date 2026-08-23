import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { isSameUtcCalendarDay } from "../../shared/workingDays.js";
import {
  approveLeaveRequest,
  cancelLeaveRequest,
  rejectLeaveRequest,
  submitLeaveRequest,
} from "./leaveRequests.service.js";

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
    const body = createLeaveRequestSchema.parse(request.body);

    const leaveRequest = await submitLeaveRequest(prisma, { organizationId, employeeId, ...body });

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

  app.post("/leave/requests/:id/cancel", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const leaveRequest = await cancelLeaveRequest(prisma, { id, organizationId, employeeId });
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

  app.post("/leave/requests/:id/approve", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const leaveRequest = await approveLeaveRequest(prisma, { id, organizationId, approverEmployeeId, decisionNote });
    return ok({ leaveRequest });
  });

  app.post("/leave/requests/:id/reject", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const leaveRequest = await rejectLeaveRequest(prisma, { id, organizationId, approverEmployeeId, decisionNote });
    return ok({ leaveRequest });
  });
};
