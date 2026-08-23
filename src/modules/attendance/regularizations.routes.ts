import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { AttendanceStatus, EmployeeRole, RegularizationType } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { isSameUtcCalendarDay } from "../../shared/workingDays.js";
import {
  approveRegularization,
  cancelRegularization,
  listPendingRegularizations,
  rejectRegularization,
  submitRegularization,
} from "./regularizations.service.js";

const APPROVER_ROLES = [EmployeeRole.MANAGER, EmployeeRole.HR, EmployeeRole.ADMIN];

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

export const regularizationRoutes = async (app: FastifyInstance) => {
  app.post("/attendance/regularizations", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId } = request.auth;
    const body = createRegularizationSchema.parse(request.body);

    const regularization = await submitRegularization(prisma, { organizationId, employeeId, ...body });

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

    const regularization = await cancelRegularization(prisma, { id, organizationId, employeeId });
    return ok({ regularization });
  });

  app.get("/attendance/regularizations/pending", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const regularizations = await listPendingRegularizations(prisma, organizationId);
    return ok({ regularizations });
  });

  app.post("/attendance/regularizations/:id/approve", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    return ok(await approveRegularization(prisma, { id, organizationId, approverEmployeeId, decisionNote }));
  });

  app.post("/attendance/regularizations/:id/reject", { preHandler: app.requireRole(APPROVER_ROLES) }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const regularization = await rejectRegularization(prisma, { id, organizationId, approverEmployeeId, decisionNote });
    return ok({ regularization });
  });
};
