import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { AttendanceStatus } from "../../generated/prisma/client.js";
import { checkIn, checkOut } from "./attendance.service.js";
import { AppError } from "../../core/errors.js";

// These paths previously had no automated coverage: they were reachable only
// over HTTP, and only on a day that happened to be a working day. Extracting
// them out of the route handler made `now` injectable, so the whole
// check-in -> check-out -> workedMinutes -> status chain is testable against
// a fixed date. Disposable org, cleaned up via cascade delete.

const WEDNESDAY_9AM = new Date("2026-03-04T09:00:00.000Z");
const WEDNESDAY_6PM = new Date("2026-03-04T18:00:00.000Z");
const WEDNESDAY_11AM = new Date("2026-03-04T11:00:00.000Z");
const SATURDAY = new Date("2026-03-07T09:00:00.000Z");

const withOrg = async (run: (organizationId: string, employeeId: string) => Promise<void>) => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Attendance Svc Co", slug: `attendance-svc-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: `attendance-svc-${randomUUID()}@example.com`,
        role: "EMPLOYEE",
      },
    });
    await run(organization.id, employee.id);
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
};

test("check-in then check-out produces one record with worked minutes and PRESENT", async () => {
  await withOrg(async (organizationId, employeeId) => {
    await checkIn(prisma, { organizationId, employeeId, now: WEDNESDAY_9AM });
    const record = await checkOut(prisma, { employeeId, now: WEDNESDAY_6PM });

    assert.equal(record.workedMinutes, 540, "09:00 -> 18:00 is 9 hours");
    assert.equal(record.status, AttendanceStatus.PRESENT, "540 min is over the 240 threshold");
    assert.equal(record.source, "SELF");

    const all = await prisma.attendanceRecord.findMany({ where: { employeeId } });
    assert.equal(all.length, 1, "one record per day, not two");
  });
});

test("a short day checks out as HALF_DAY", async () => {
  await withOrg(async (organizationId, employeeId) => {
    await checkIn(prisma, { organizationId, employeeId, now: WEDNESDAY_9AM });
    const record = await checkOut(prisma, { employeeId, now: WEDNESDAY_11AM });

    assert.equal(record.workedMinutes, 120);
    assert.equal(record.status, AttendanceStatus.HALF_DAY, "120 min is under the 240 threshold");
  });
});

test("double check-in is rejected", async () => {
  await withOrg(async (organizationId, employeeId) => {
    await checkIn(prisma, { organizationId, employeeId, now: WEDNESDAY_9AM });
    await assert.rejects(
      () => checkIn(prisma, { organizationId, employeeId, now: WEDNESDAY_11AM }),
      (err: unknown) => err instanceof AppError && err.statusCode === 409,
    );
  });
});

test("check-out without a check-in is rejected", async () => {
  await withOrg(async (_organizationId, employeeId) => {
    await assert.rejects(
      () => checkOut(prisma, { employeeId, now: WEDNESDAY_6PM }),
      (err: unknown) => err instanceof AppError && err.statusCode === 409,
    );
  });
});

test("check-in on a weekend is rejected", async () => {
  await withOrg(async (organizationId, employeeId) => {
    await assert.rejects(
      () => checkIn(prisma, { organizationId, employeeId, now: SATURDAY }),
      (err: unknown) => err instanceof AppError && err.statusCode === 409 && /week off/i.test(err.message),
    );
  });
});

test("check-in on a company holiday is rejected", async () => {
  await withOrg(async (organizationId, employeeId) => {
    await prisma.holiday.create({
      data: { organizationId, date: new Date("2026-03-04T00:00:00.000Z"), name: "Test Holiday", year: 2026 },
    });
    await assert.rejects(
      () => checkIn(prisma, { organizationId, employeeId, now: WEDNESDAY_9AM }),
      (err: unknown) => err instanceof AppError && err.statusCode === 409 && /holiday/i.test(err.message),
    );
  });
});
