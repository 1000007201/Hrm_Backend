import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { accrueForOrg } from "./accrual.js";

// Hits the real dev DB with disposable data (cleaned up via cascade delete on
// the org) — this is the money/balance-critical path CLAUDE.md calls out for
// transactions, so it gets a real runnable check rather than a pure-function
// unit test.
test("accrual credits once per month, caps at annualCap, and re-running is a no-op", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Accrual Test Co", slug: `accrual-test-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: "accrual-test@example.com",
        role: "EMPLOYEE",
      },
    });
    const leaveType = await prisma.leaveType.create({
      data: { organizationId: organization.id, name: "Casual Leave", code: "CL", accrualPerMonth: "1", annualCap: 2 },
    });
    const year = 2026;

    const january = await accrueForOrg(organization.id, year, 1);
    assert.equal(january.balancesCredited, 1);
    assert.equal(january.balancesSkipped, 0);

    const rerunJanuary = await accrueForOrg(organization.id, year, 1);
    assert.equal(rerunJanuary.balancesCredited, 0, "re-running the same month must not credit again");
    assert.equal(rerunJanuary.balancesSkipped, 1);

    await accrueForOrg(organization.id, year, 2); // accruedDays now at the annualCap (2)
    await accrueForOrg(organization.id, year, 3); // would be 3 — must stay capped at 2

    const balance = await prisma.leaveBalance.findUniqueOrThrow({
      where: { employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: leaveType.id, year } },
    });
    assert.equal(balance.accruedDays.toNumber(), 2);
    assert.equal(balance.lastAccruedMonth, 3);
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
