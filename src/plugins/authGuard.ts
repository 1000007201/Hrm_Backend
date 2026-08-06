import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { EmployeeRole } from "../generated/prisma/client.js";

export interface RequestAuthContext {
  userId: string;
  organizationId: string;
  employeeId: string;
  role: EmployeeRole;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuthContext;
  }
  interface FastifyInstance {
    requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireRole(roles: EmployeeRole[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// Session -> active org -> the caller's own Employee row for that org. Every
// guarded route reads tenant/role off request.auth afterwards — never off the
// request body/query, which the caller controls.
const resolveAuth = async (request: FastifyRequest): Promise<RequestAuthContext> => {
  const session = await request.getSession();
  if (!session) {
    throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
  }

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new AppError(403, "FORBIDDEN", "No active organization on session");
  }

  const employee = await prisma.employee.findUnique({ where: { userId: session.user.id } });
  if (!employee || employee.organizationId !== organizationId) {
    throw new AppError(403, "FORBIDDEN", "Not a member of this organization");
  }

  return { userId: session.user.id, organizationId, employeeId: employee.id, role: employee.role };
};

const authGuardPlugin = async (app: FastifyInstance) => {
  app.decorate("requireAuth", async (request: FastifyRequest) => {
    request.auth = await resolveAuth(request);
  });

  app.decorate("requireRole", (roles: EmployeeRole[]) => async (request: FastifyRequest) => {
    request.auth = await resolveAuth(request);
    if (!roles.includes(request.auth.role)) {
      throw new AppError(403, "FORBIDDEN", "Forbidden");
    }
  });
};

export default fp(authGuardPlugin, { name: "auth-guard-plugin" });
