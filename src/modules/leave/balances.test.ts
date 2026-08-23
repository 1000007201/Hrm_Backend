import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { getEffectiveAvailableDays } from "./balances.js";

// Balance-critical reservation math — real dev DB, disposable data cleaned
// up via cascade delete on the org.
test("effective available = accrued - used - this employee's own pending reservations for the same type/year", async () => {
  const organization = await prisma.organization.create({
    data: {
      id: randomUUID(),
      name: "Leave Request Test Co",
      slug: `leave-request-test-${randomUUID()}`,
      createdAt: new Date(),
    },
  });

  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: "leave-request-test@example.com",
        role: "EMPLOYEE",
      },
    });
    const leaveType = await prisma.leaveType.create({
      data: { organizationId: organization.id, name: "Casual Leave", code: "CL", accrualPerMonth: "1", annualCap: 12 },
    });
    const year = 2026;
    const params = { organizationId: organization.id, employeeId: employee.id, leaveTypeId: leaveType.id, year };

    await prisma.leaveBalance.create({
      data: { organizationId: organization.id, employeeId: employee.id, leaveTypeId: leaveType.id, year, accruedDays: "5", usedDays: "1" },
    });

    assert.equal((await getEffectiveAvailableDays(prisma, params)).toNumber(), 4); // 5 accrued - 1 used - 0 pending

    await prisma.leaveRequest.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: new Date(Date.UTC(year, 2, 2)),
        endDate: new Date(Date.UTC(year, 2, 3)),
        workingDays: "2",
        status: "PENDING",
      },
    });
    assert.equal((await getEffectiveAvailableDays(prisma, params)).toNumber(), 2, "a pending request reserves against the balance");

    // A PENDING request dated in a different year must not reserve against this year's balance.
    await prisma.leaveRequest.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: new Date(Date.UTC(year + 1, 0, 5)),
        endDate: new Date(Date.UTC(year + 1, 0, 6)),
        workingDays: "2",
        status: "PENDING",
      },
    });
    assert.equal((await getEffectiveAvailableDays(prisma, params)).toNumber(), 2, "next year's pending request must not affect this year");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
