import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { getHolidayDateKeys, toHolidayYear } from "./holidays.js";
import { countWorkingDays } from "./workingDays.js";

const utcDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

// Round-trips real rows through Postgres `@db.Date`: the keys coming back
// have to match what countWorkingDays looks up, or holidays silently stop
// being excluded. Disposable org, cleaned up via cascade delete.
test("holidays stored in the DB round-trip into keys countWorkingDays actually excludes", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Holiday Test Co", slug: `holiday-test-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const holiday = utcDate("2026-03-04"); // a Wednesday
    await prisma.holiday.create({
      data: { organizationId: organization.id, date: holiday, name: "Test Holiday", year: toHolidayYear(holiday) },
    });

    const weekStart = utcDate("2026-03-02");
    const weekEnd = utcDate("2026-03-06");
    const holidayKeys = await getHolidayDateKeys(prisma, organization.id, weekStart, weekEnd);

    assert.deepEqual([...holidayKeys], ["2026-03-04"], "DB date must key to its own UTC calendar day");
    assert.equal(countWorkingDays(weekStart, weekEnd, false, holidayKeys), 4, "Mon-Fri minus one holiday");

    // Tenant scoping: another org's range query must not see this holiday.
    const otherOrgKeys = await getHolidayDateKeys(prisma, randomUUID(), weekStart, weekEnd);
    assert.equal(otherOrgKeys.size, 0);

    // Range scoping: a window that excludes the holiday returns nothing.
    const laterKeys = await getHolidayDateKeys(prisma, organization.id, utcDate("2026-03-05"), weekEnd);
    assert.equal(laterKeys.size, 0);
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});

test("re-upserting the same holiday date does not create a duplicate", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Holiday Upsert Co", slug: `holiday-upsert-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const date = utcDate("2026-01-26");
    const upsert = (name: string) =>
      prisma.holiday.upsert({
        where: { organizationId_date: { organizationId: organization.id, date } },
        create: { organizationId: organization.id, date, name, year: toHolidayYear(date) },
        update: { name },
      });

    await upsert("Republic Day");
    await upsert("Republic Day");
    await upsert("Republic Day (observed)");

    const holidays = await prisma.holiday.findMany({ where: { organizationId: organization.id } });
    assert.equal(holidays.length, 1, "same date upserts in place rather than duplicating");
    assert.equal(holidays[0]!.name, "Republic Day (observed)", "a changed name updates the existing row");
    assert.equal(holidays[0]!.year, 2026, "year is derived from the date");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
