import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromNodeHeaders } from "better-auth/node";
import { APIError } from "better-auth";
import { auth } from "../../core/auth.js";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { toOrgRole, getInvitationAcceptUrl } from "./invitations.js";

const idParamSchema = z.object({ id: z.string().min(1) });
const MANAGER_ROLES = [EmployeeRole.ADMIN, EmployeeRole.HR];

export const invitationRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees/:id/invite", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const employee = await prisma.employee.findFirst({ where: { id, organizationId } });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }
    if (employee.userId) {
      throw new AppError(409, "CONFLICT", "This employee already has portal login");
    }

    try {
      const invitation = await auth.api.createInvitation({
        headers: fromNodeHeaders(request.headers),
        body: { email: employee.email, role: toOrgRole(employee.role), organizationId },
      });

      await prisma.employee.update({ where: { id: employee.id }, data: { invitedAt: new Date() } });

      reply.status(201);
      return ok({ invitation });
    } catch (err) {
      if (err instanceof APIError) {
        throw AppError.fromBetterAuthError(err);
      }
      throw err;
    }
  });

  app.get(
    "/api/employees/:id/invite-link",
    { preHandler: app.requireRole(MANAGER_ROLES) },
    async (request) => {
      const { organizationId } = request.auth;
      const { id } = idParamSchema.parse(request.params);

      const employee = await prisma.employee.findFirst({ where: { id, organizationId } });
      if (!employee) {
        throw new AppError(404, "NOT_FOUND", "Employee not found");
      }

      const invitation = await prisma.invitation.findFirst({
        where: { organizationId, email: employee.email, status: "pending" },
        orderBy: { createdAt: "desc" },
      });
      if (!invitation) {
        throw new AppError(404, "NOT_FOUND", "No pending invitation for this employee — invite them first");
      }

      return ok({
        url: getInvitationAcceptUrl(invitation.id),
        invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
      });
    },
  );

  app.get("/api/invitations", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const invitations = await prisma.invitation.findMany({
      where: { organizationId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });

    return ok({ invitations });
  });

  app.post(
    "/api/invitations/:id/cancel",
    { preHandler: app.requireRole(MANAGER_ROLES) },
    async (request) => {
      const { organizationId } = request.auth;
      const { id } = idParamSchema.parse(request.params);

      const invitation = await prisma.invitation.findFirst({ where: { id, organizationId } });
      if (!invitation) {
        throw new AppError(404, "NOT_FOUND", "Invitation not found");
      }

      try {
        const canceled = await auth.api.cancelInvitation({
          headers: fromNodeHeaders(request.headers),
          body: { invitationId: invitation.id },
        });
        return ok({ invitation: canceled });
      } catch (err) {
        if (err instanceof APIError) {
          throw AppError.fromBetterAuthError(err);
        }
        throw err;
      }
    },
  );
};
