import type { FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";

const MANAGER_ROLES = new Set(["ADMIN", "HR"]);

export interface EmployeeAuthContext {
  organizationId: string;
}

export interface EmployeeAuthError {
  error: string;
  status: number;
}

// Resolves the caller's own Employee record (by session userId) and checks
// it's ADMIN/HR within the session's active org. Shared by every
// employee/invitation route, since they all have the same gate.
export const authorizeEmployeeManager = async (
  request: FastifyRequest,
): Promise<EmployeeAuthContext | EmployeeAuthError> => {
  const session = await request.getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    return { error: "No active organization on session", status: 400 };
  }

  const callerEmployee = await prisma.employee.findUnique({ where: { userId: session.user.id } });
  if (!callerEmployee || callerEmployee.organizationId !== organizationId || !MANAGER_ROLES.has(callerEmployee.role)) {
    return { error: "Forbidden", status: 403 };
  }

  return { organizationId };
};

export const isAuthError = (
  result: EmployeeAuthContext | EmployeeAuthError,
): result is EmployeeAuthError => "error" in result;
