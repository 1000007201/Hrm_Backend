import { prisma } from "./prisma.js";

// Reasonable Indian SME defaults: Casual, Sick, Earned leave. `code` is the
// per-org unique key (LeaveType.organizationId_code) — ensureDefaultLeaveTypes
// upserts on it, so re-running (or calling it for an org that already has
// these) never duplicates or overwrites an admin's later edits.
const DEFAULT_LEAVE_TYPES = [
  { code: "CL", name: "Casual Leave", accrualPerMonth: "1", annualCap: 12 },
  { code: "SL", name: "Sick Leave", accrualPerMonth: "1", annualCap: 12 },
  { code: "EL", name: "Earned Leave", accrualPerMonth: "1.5", annualCap: 18 },
] as const;

// Called once at company registration so every new org starts with CL/SL/EL.
// Safe to call again for an existing org — upsert's `update: {}` is a no-op
// when the row already exists, so it never clobbers an admin's edits
// (renamed type, changed cap, etc).
export const ensureDefaultLeaveTypes = async (organizationId: string): Promise<void> => {
  await Promise.all(
    DEFAULT_LEAVE_TYPES.map((leaveType) =>
      prisma.leaveType.upsert({
        where: { organizationId_code: { organizationId, code: leaveType.code } },
        create: { organizationId, ...leaveType },
        update: {},
      }),
    ),
  );
};
