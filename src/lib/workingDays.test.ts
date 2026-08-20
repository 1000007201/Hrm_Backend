import { test } from "node:test";
import assert from "node:assert/strict";
import { countWorkingDays, isSameUtcCalendarDay, toUtcDateKey } from "./workingDays.js";

const utcDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

test("counts a Mon-Fri work week as 5 days", () => {
  assert.equal(countWorkingDays(utcDate("2026-03-02"), utcDate("2026-03-06"), false), 5);
});

test("a Sat-Sun-only range has zero working days", () => {
  assert.equal(countWorkingDays(utcDate("2026-03-07"), utcDate("2026-03-08"), false), 0);
});

test("a range spanning a weekend excludes just the weekend", () => {
  // Fri Mar 6 -> Mon Mar 9: Fri, Mon = 2 working days (Sat/Sun excluded)
  assert.equal(countWorkingDays(utcDate("2026-03-06"), utcDate("2026-03-09"), false), 2);
});

test("half-day on a weekday is 0.5", () => {
  assert.equal(countWorkingDays(utcDate("2026-03-04"), utcDate("2026-03-04"), true), 0.5);
});

test("half-day on a weekend is 0", () => {
  assert.equal(countWorkingDays(utcDate("2026-03-07"), utcDate("2026-03-07"), true), 0);
});

test("isSameUtcCalendarDay compares by UTC calendar date, not instant", () => {
  assert.ok(isSameUtcCalendarDay(utcDate("2026-03-04"), utcDate("2026-03-04")));
  assert.ok(!isSameUtcCalendarDay(utcDate("2026-03-04"), utcDate("2026-03-05")));
});

test("a holiday inside the range is excluded alongside weekends", () => {
  // Mon Mar 2 -> Fri Mar 6 is 5 working days; making Wed Mar 4 a holiday leaves 4.
  const holidays = new Set([toUtcDateKey(utcDate("2026-03-04"))]);
  assert.equal(countWorkingDays(utcDate("2026-03-02"), utcDate("2026-03-06"), false, holidays), 4);
});

test("a holiday falling on a weekend doesn't double-subtract", () => {
  // Sat Mar 7 is already excluded as a weekend — flagging it a holiday too
  // must not take the Fri-Mon count below 2.
  const holidays = new Set([toUtcDateKey(utcDate("2026-03-07"))]);
  assert.equal(countWorkingDays(utcDate("2026-03-06"), utcDate("2026-03-09"), false, holidays), 2);
});

test("a range that is entirely weekend + holidays has zero working days", () => {
  // Fri Mar 6 (holiday) -> Mon Mar 9 (holiday), with Sat/Sun between.
  const holidays = new Set([toUtcDateKey(utcDate("2026-03-06")), toUtcDateKey(utcDate("2026-03-09"))]);
  assert.equal(countWorkingDays(utcDate("2026-03-06"), utcDate("2026-03-09"), false, holidays), 0);
});

test("half-day on a holiday is 0", () => {
  const holidays = new Set([toUtcDateKey(utcDate("2026-03-04"))]);
  assert.equal(countWorkingDays(utcDate("2026-03-04"), utcDate("2026-03-04"), true, holidays), 0);
});

test("holidays outside the range don't affect the count", () => {
  const holidays = new Set([toUtcDateKey(utcDate("2026-04-01"))]);
  assert.equal(countWorkingDays(utcDate("2026-03-02"), utcDate("2026-03-06"), false, holidays), 5);
});

test("toUtcDateKey matches the key format countWorkingDays looks up", () => {
  assert.equal(toUtcDateKey(utcDate("2026-03-04")), "2026-03-04");
  // A late-in-the-day UTC instant still keys to its own UTC calendar date.
  assert.equal(toUtcDateKey(new Date("2026-03-04T23:59:59.000Z")), "2026-03-04");
});
