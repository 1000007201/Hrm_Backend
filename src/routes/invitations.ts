import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromNodeHeaders } from "better-auth/node";
import { APIError } from "better-auth";
import { auth } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { authorizeEmployeeManager, isAuthError } from "../lib/authorizeEmployeeManager.js";
import { toOrgRole, getInvitationAcceptUrl } from "../lib/invitations.js";

const idParamSchema = z.object({ id: z.string().min(1) });

export const invitationRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees/:id/invite", async (request, reply) => {
    const authContext = await authorizeEmployeeManager(request);
    if (isAuthError(authContext)) {
      reply.status(authContext.status);
      return { error: authContext.error };
    }
    const { organizationId } = authContext;

    const paramsParsed = idParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(paramsParsed.error) };
    }

    const employee = await prisma.employee.findFirst({
      where: { id: paramsParsed.data.id, organizationId },
    });
    if (!employee) {
      reply.status(404);
      return { error: "Employee not found" };
    }
    if (employee.userId) {
      reply.status(409);
      return { error: "This employee already has portal login" };
    }

    try {
      const invitation = await auth.api.createInvitation({
        headers: fromNodeHeaders(request.headers),
        body: { email: employee.email, role: toOrgRole(employee.role), organizationId },
      });

      await prisma.employee.update({ where: { id: employee.id }, data: { invitedAt: new Date() } });

      reply.status(201);
      return { invitation };
    } catch (err) {
      if (err instanceof APIError) {
        reply.status(err.statusCode);
        return { error: err.body?.message ?? "Invitation failed" };
      }
      throw err;
    }
  });

  app.get("/api/employees/:id/invite-link", async (request, reply) => {
    const authContext = await authorizeEmployeeManager(request);
    if (isAuthError(authContext)) {
      reply.status(authContext.status);
      return { error: authContext.error };
    }
    const { organizationId } = authContext;

    const paramsParsed = idParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(paramsParsed.error) };
    }

    const employee = await prisma.employee.findFirst({
      where: { id: paramsParsed.data.id, organizationId },
    });
    if (!employee) {
      reply.status(404);
      return { error: "Employee not found" };
    }

    const invitation = await prisma.invitation.findFirst({
      where: { organizationId, email: employee.email, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    if (!invitation) {
      reply.status(404);
      return { error: "No pending invitation for this employee — invite them first" };
    }

    return {
      url: getInvitationAcceptUrl(invitation.id),
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
    };
  });

  app.get("/api/invitations", async (request, reply) => {
    const authContext = await authorizeEmployeeManager(request);
    if (isAuthError(authContext)) {
      reply.status(authContext.status);
      return { error: authContext.error };
    }
    const { organizationId } = authContext;

    const invitations = await prisma.invitation.findMany({
      where: { organizationId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });

    return { invitations };
  });

  app.post("/api/invitations/:id/cancel", async (request, reply) => {
    const authContext = await authorizeEmployeeManager(request);
    if (isAuthError(authContext)) {
      reply.status(authContext.status);
      return { error: authContext.error };
    }
    const { organizationId } = authContext;

    const paramsParsed = idParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.status(400);
      return { error: z.prettifyError(paramsParsed.error) };
    }

    const invitation = await prisma.invitation.findFirst({
      where: { id: paramsParsed.data.id, organizationId },
    });
    if (!invitation) {
      reply.status(404);
      return { error: "Invitation not found" };
    }

    try {
      const canceled = await auth.api.cancelInvitation({
        headers: fromNodeHeaders(request.headers),
        body: { invitationId: invitation.id },
      });
      return { invitation: canceled };
    } catch (err) {
      if (err instanceof APIError) {
        reply.status(err.statusCode);
        return { error: err.body?.message ?? "Cancel failed" };
      }
      throw err;
    }
  });
};
