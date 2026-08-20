import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { AttendanceStatus } from "../generated/prisma/client.js";
import {
  buildMonthlyAttendance,
  deriveDailyStatus,
  statusFromWorkedMinutes,
  type AttendanceRecordFacts,
} from "./attendance.js";

const utcDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

const THRESHOLD = 240;
// March 2026: Mon 2nd .. Fri 6th is a work week; 7th/8th are Sat/Sun.
const TODAY = utcDate("2026-03-20");

const derive = (overrides: {
  date: Date;
  today?: Date;
  holidays?: string[];
  leaves?: string[];
  record?: AttendanceRecordFacts | null;
}) =>
  deriveDailyStatus({
    date: overrides.date,
    today: overrides.today ?? TODAY,
    holidayDateKeys: new Set(overrides.holidays ?? []),
    approvedLeaveDateKeys: new Set(overrides.leaves ?? []),
    record: overrides.record ?? null,
    halfDayThresholdMinutes: THRESHOLD,
  });

const selfRecord = (workedMinutes: number | null): AttendanceRecordFacts => ({
  checkInAt: new Date(),
  checkOutAt: workedMinutes === null ? null : new Date(),
  workedMinutes,
  status: AttendanceStatus.PRESENT,
  source: "SELF",
});

test("weekend wins over everything, including a record", () => {
  assert.equal(derive({ date: utcDate("2026-03-07") }), AttendanceStatus.WEEK_OFF);
  assert.equal(
    derive({ date: utcDate("2026-03-07"), holidays: ["2026-03-07"], leaves: ["2026-03-07"], record: selfRecord(480) }),
    AttendanceStatus.WEEK_OFF,
  );
});

test("holiday beats leave and attendance on a weekday", () => {
  assert.equal(
    derive({ date: utcDate("2026-03-04"), holidays: ["2026-03-04"], leaves: ["2026-03-04"], record: selfRecord(480) }),
    AttendanceStatus.HOLIDAY,
  );
});

test("approved leave beats attendance on an ordinary working day", () => {
  assert.equal(
    derive({ date: utcDate("2026-03-04"), leaves: ["2026-03-04"], record: selfRecord(480) }),
    AttendanceStatus.ON_LEAVE,
  );
});

test("a full day worked is PRESENT, a short day is HALF_DAY", () => {
  assert.equal(derive({ date: utcDate("2026-03-04"), record: selfRecord(480) }), AttendanceStatus.PRESENT);
  assert.equal(derive({ date: utcDate("2026-03-04"), record: selfRecord(THRESHOLD) }), AttendanceStatus.PRESENT);
  assert.equal(derive({ date: utcDate("2026-03-04"), record: selfRecord(THRESHOLD - 1) }), AttendanceStatus.HALF_DAY);
});

test("checked in but not out yet counts as PRESENT, not a half day", () => {
  assert.equal(derive({ date: utcDate("2026-03-04"), record: selfRecord(null) }), AttendanceStatus.PRESENT);
  assert.equal(statusFromWorkedMinutes(null, THRESHOLD), AttendanceStatus.PRESENT);
});

test("an HR correction overrides what the clock times would say", () => {
  const hrMarked: AttendanceRecordFacts = {
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: 480,
    status: AttendanceStatus.ABSENT,
    source: "HR_MARKED",
  };
  assert.equal(derive({ date: utcDate("2026-03-04"), record: hrMarked }), AttendanceStatus.ABSENT);
});

test("an approved regularization overrides clock times the same way HR marking does", () => {
  // Regression guard: REGULARIZED must count as an explicit human decision.
  // If it falls through to statusFromWorkedMinutes, a WFH day with no punches
  // silently becomes HALF_DAY and an approved correction is lost.
  const wfhNoPunches: AttendanceRecordFacts = {
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: null,
    status: AttendanceStatus.PRESENT,
    source: "REGULARIZED",
  };
  assert.equal(derive({ date: utcDate("2026-03-04"), record: wfhNoPunches }), AttendanceStatus.PRESENT);

  const forcedHalfDay: AttendanceRecordFacts = {
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: 480, // a full day by the clock...
    status: AttendanceStatus.HALF_DAY, // ...but the approver said half day
    source: "REGULARIZED",
  };
  assert.equal(derive({ date: utcDate("2026-03-04"), record: forcedHalfDay }), AttendanceStatus.HALF_DAY);
});

test("a SELF record is still recomputed from worked time, not trusted blindly", () => {
  const staleStatus: AttendanceRecordFacts = {
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: 60, // well under the 240 threshold
    status: AttendanceStatus.PRESENT, // stale/optimistic value on the row
    source: "SELF",
  };
  assert.equal(derive({ date: utcDate("2026-03-04"), record: staleStatus }), AttendanceStatus.HALF_DAY);
});

test("a past working day with no record is ABSENT", () => {
  assert.equal(derive({ date: utcDate("2026-03-04") }), AttendanceStatus.ABSENT);
});

test("today and future working days with no record have no status yet", () => {
  assert.equal(derive({ date: TODAY }), null, "today isn't an absence — the day isn't over");
  assert.equal(derive({ date: utcDate("2026-03-25") }), null);
});

// Exercises the bulk loader against real rows: holidays, an approved leave
// range spanning several days, and an attendance record must all land on the
// right days of the built month.
test("the month builder reconciles holidays, approved leave and records across a real month", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Attendance Test Co", slug: `attendance-test-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: "attendance-test@example.com",
        role: "EMPLOYEE",
      },
    });
    const leaveType = await prisma.leaveType.create({
      data: { organizationId: organization.id, name: "Casual Leave", code: "CL", accrualPerMonth: "1", annualCap: 12 },
    });

    // Wed Mar 4: company holiday.
    await prisma.holiday.create({
      data: { organizationId: organization.id, date: utcDate("2026-03-04"), name: "Test Holiday", year: 2026 },
    });
    // Thu Mar 5 -> Fri Mar 6: approved leave (a range, to prove expansion works).
    await prisma.leaveRequest.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: utcDate("2026-03-05"),
        endDate: utcDate("2026-03-06"),
        workingDays: "2",
        status: "APPROVED",
      },
    });
    // Mon Mar 2: worked a short day.
    await prisma.attendanceRecord.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        date: utcDate("2026-03-02"),
        checkInAt: new Date("2026-03-02T09:00:00.000Z"),
        checkOutAt: new Date("2026-03-02T12:00:00.000Z"),
        workedMinutes: 180,
        status: AttendanceStatus.HALF_DAY,
        source: "SELF",
      },
    });

    const days = await buildMonthlyAttendance(prisma, {
      organizationId: organization.id,
      employeeId: employee.id,
      year: 2026,
      month: 3,
      today: TODAY,
      halfDayThresholdMinutes: THRESHOLD,
    });

    assert.equal(days.length, 31, "March has 31 days and every one is represented");
    const statusOn = (dateKey: string) => days.find((day) => day.date === dateKey)?.status;

    assert.equal(statusOn("2026-03-02"), AttendanceStatus.HALF_DAY, "180 min < 240 threshold");
    assert.equal(statusOn("2026-03-03"), AttendanceStatus.ABSENT, "past working day, nothing recorded");
    assert.equal(statusOn("2026-03-04"), AttendanceStatus.HOLIDAY);
    assert.equal(statusOn("2026-03-05"), AttendanceStatus.ON_LEAVE, "first day of the approved range");
    assert.equal(statusOn("2026-03-06"), AttendanceStatus.ON_LEAVE, "last day of the approved range");
    assert.equal(statusOn("2026-03-07"), AttendanceStatus.WEEK_OFF);
    assert.equal(statusOn("2026-03-08"), AttendanceStatus.WEEK_OFF);
    assert.equal(statusOn("2026-03-25"), null, "after `today` — not yet determined");

    const workedDay = days.find((day) => day.date === "2026-03-02");
    assert.equal(workedDay?.workedMinutes, 180, "record details ride along with the derived status");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
