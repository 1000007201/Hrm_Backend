import { prisma } from "./prisma.js";
import { env } from "../env.js";

const EMPLOYEE_ROLES = ["ADMIN", "HR", "MANAGER", "EMPLOYEE"] as const;
type EmployeeRoleValue = (typeof EMPLOYEE_ROLES)[number];

// Better Auth org roles are lowercase; EmployeeRole is uppercase. The two
// are kept in 1:1 correspondence (see the custom roles in src/lib/auth.ts).
// A literal-union return type (not `string`) so it satisfies Better Auth's
// inferred invitation `role` type at the createInvitation call site.
const ORG_ROLE_BY_EMPLOYEE_ROLE = {
  ADMIN: "admin",
  HR: "hr",
  MANAGER: "manager",
  EMPLOYEE: "employee",
} as const;

export const toOrgRole = (employeeRole: EmployeeRoleValue): (typeof ORG_ROLE_BY_EMPLOYEE_ROLE)[EmployeeRoleValue] =>
  ORG_ROLE_BY_EMPLOYEE_ROLE[employeeRole];

const toEmployeeRole = (orgRole: string): EmployeeRoleValue => {
  const candidate = orgRole.split(",")[0]?.trim().toUpperCase();
  return (EMPLOYEE_ROLES as readonly string[]).includes(candidate ?? "")
    ? (candidate as EmployeeRoleValue)
    : "EMPLOYEE";
};

export const getInvitationAcceptUrl = (invitationId: string): string =>
  `${env.FRONTEND_ORIGIN}/accept-invitation/${invitationId}`;

interface AcceptedInvitationData {
  organization: { id: string };
  user: { id: string; name: string; email: string };
  member: { role: string };
}

// Runs from organizationHooks.afterAcceptInvitation. Links the newly-created
// User to the pre-existing Employee record (by org + email) instead of ever
// creating a second Employee for the same person.
export const linkEmployeeOnAcceptInvitation = async ({
  organization,
  user,
  member,
}: AcceptedInvitationData): Promise<void> => {
  // Belt-and-suspenders: Better Auth's own acceptInvitation already sets
  // activeOrganizationId on the accepting session, but there are known cases
  // where that doesn't stick — force it here too. A User maps to at most one
  // Employee/org in this system, so it's safe to apply to all of their
  // sessions unconditionally.
  await prisma.session.updateMany({
    where: { userId: user.id },
    data: { activeOrganizationId: organization.id },
  });

  const employee = await prisma.employee.findUnique({
    where: { organizationId_email: { organizationId: organization.id, email: user.email } },
  });

  if (employee) {
    if (employee.userId === null) {
      await prisma.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
    } else if (employee.userId !== user.id) {
      console.warn(
        `[invitations] Employee ${employee.id} (${user.email}) already linked to a different userId=${employee.userId}; accepting user=${user.id} was not linked.`,
      );
    }
    // else: already linked to this same user — no-op, idempotent.
    return;
  }

  console.warn(
    `[invitations] No pre-existing Employee found for org=${organization.id} email=${user.email} on invitation accept — creating a fallback record. Investigate how this invite was sent without one.`,
  );
  await prisma.employee.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      fullName: user.name,
      email: user.email,
      role: toEmployeeRole(member.role),
    },
  });
};
