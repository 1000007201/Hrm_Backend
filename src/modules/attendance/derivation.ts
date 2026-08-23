import { AttendanceSource, AttendanceStatus, type Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { eachUtcDateInRange, isWeekend, toUtcDateKey, utcMidnight } from "../../shared/workingDays.js";

type Db = PrismaClient | Prisma.TransactionClient;

// Only the fields derivation actually reads — so the pure functions below
// stay callable with a literal in tests, not a full Prisma row. `source`
// uses the generated enum rather than a hand-written union so adding a
// variant to the schema can't leave this behind.
export interface AttendanceRecordFacts {
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
  status: AttendanceStatus;
  source: AttendanceSource;
}

// A human deliberately set this day's status, so it must win over
// recomputing from clock times — including a forced ABSENT on a day that has
// punches, or a WFH day with no punches at all.
//
// Both writers qualify: HR editing directly (POST /attendance/mark) and an
// approved employee regularization (source REGULARIZED). Kept as one named
// predicate so a future AttendanceSource variant has a single obvious place
// to be classified instead of a bare === comparison buried in derivation.
const isExplicitHumanDecision = (source: AttendanceSource): boolean =>
  source === AttendanceSource.HR_MARKED || source === AttendanceSource.REGULARIZED;

// null = no status yet: a working day that hasn't happened (or isn't over)
// and has no record. Deliberately not an AttendanceStatus member — "we don't
// know yet" isn't a state worth persisting.
export type DerivedDayStatus = AttendanceStatus | null;

export interface DeriveDailyStatusInput {
  date: Date;
  /** Reference "today" as a UTC calendar day — injected, not read from the
   *  clock, so derivation stays pure and testable. */
  today: Date;
  holidayDateKeys: ReadonlySet<string>;
  approvedLeaveDateKeys: ReadonlySet<string>;
  record?: AttendanceRecordFacts | null;
  halfDayThresholdMinutes: number;
}

// Whole minutes between two punches, floored at 0. Shared by self check-out,
// HR mark and regularization approval so all three round identically.
export const toWorkedMinutes = (checkInAt: Date, checkOutAt: Date): number =>
  Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000));

// The single rule mapping worked time to PRESENT/HALF_DAY. Check-out uses it
// to store a status; derivation uses it to read one back — sharing it is why
// the two can't drift apart on the threshold comparison.
export const statusFromWorkedMinutes = (
  workedMinutes: number | null,
  halfDayThresholdMinutes: number,
): AttendanceStatus =>
  // null = checked in, not yet out. The day is still open, so treat it as
  // present rather than pre-judging it a half day.
  workedMinutes === null || workedMinutes >= halfDayThresholdMinutes
    ? AttendanceStatus.PRESENT
    : AttendanceStatus.HALF_DAY;

// THE ONE PLACE attendance/leave/holiday/weekend reconciliation lives —
// the attendance counterpart to countWorkingDays. Nothing else may decide
// what a given day "is"; every view (self month, HR day, HR month) routes
// through here so they cannot disagree.
//
// Pure and synchronous by the same reasoning as countWorkingDays: all data
// is injected, so it's testable without a database and does no hidden I/O.
// Callers bulk-load via loadAttendanceContext below.
//
// Priority order (first match wins):
//   1. weekend                      -> WEEK_OFF
//   2. org holiday                  -> HOLIDAY
//   3. approved leave               -> ON_LEAVE
//   4. has a record                 -> an explicit human decision's stored status
//                                      (HR mark / approved regularization), else
//                                      PRESENT/HALF_DAY by worked time
//   5. past working day, no record  -> ABSENT
//   6. today/future, no record      -> null (not yet determined)
export const deriveDailyStatus = ({
  date,
  today,
  holidayDateKeys,
  approvedLeaveDateKeys,
  record,
  halfDayThresholdMinutes,
}: DeriveDailyStatusInput): DerivedDayStatus => {
  const dateKey = toUtcDateKey(date);

  if (isWeekend(date)) {
    return AttendanceStatus.WEEK_OFF;
  }
  if (holidayDateKeys.has(dateKey)) {
    return AttendanceStatus.HOLIDAY;
  }
  // TODO: half-day leave (LeaveRequest.isHalfDay) currently blocks the whole
  // day as ON_LEAVE. Splitting it into half ON_LEAVE + half expecting
  // attendance needs a sub-day representation this model doesn't have yet.
  if (approvedLeaveDateKeys.has(dateKey)) {
    return AttendanceStatus.ON_LEAVE;
  }

  if (record) {
    return isExplicitHumanDecision(record.source)
      ? record.status
      : statusFromWorkedMinutes(record.workedMinutes, halfDayThresholdMinutes);
  }

  // A working day already past with nothing recorded is an absence. Today
  // and the future aren't absences yet — the day isn't over.
  return utcMidnight(date) < utcMidnight(today) ? AttendanceStatus.ABSENT : null;
};

export interface AttendanceContext {
  holidayDateKeys: Set<string>;
  approvedLeaveDateKeysByEmployeeId: Map<string, Set<string>>;
  recordsByEmployeeAndDateKey: Map<string, AttendanceRecordFacts & { id: string; date: Date; note: string | null }>;
}

const contextKey = (employeeId: string, dateKey: string): string => `${employeeId}|${dateKey}`;

// Bulk-loads everything derivation needs for a set of employees over a date
// range in exactly THREE queries, no matter how many employees or days —
// this is what keeps the month/day views free of N+1.
export const loadAttendanceContext = async (
  db: Db,
  organizationId: string,
  employeeIds: string[],
  startDate: Date,
  endDate: Date,
): Promise<AttendanceContext> => {
  const [holidays, approvedLeaves, records] = await Promise.all([
    db.holiday.findMany({
      where: { organizationId, date: { gte: startDate, lte: endDate } },
      select: { date: true },
    }),
    // Any approved request overlapping the window, not just fully inside it.
    db.leaveRequest.findMany({
      where: {
        organizationId,
        employeeId: { in: employeeIds },
        status: "APPROVED",
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
    db.attendanceRecord.findMany({
      where: { organizationId, employeeId: { in: employeeIds }, date: { gte: startDate, lte: endDate } },
    }),
  ]);

  const approvedLeaveDateKeysByEmployeeId = new Map<string, Set<string>>();
  for (const leave of approvedLeaves) {
    const dateKeys = approvedLeaveDateKeysByEmployeeId.get(leave.employeeId) ?? new Set<string>();
    for (const date of eachUtcDateInRange(leave.startDate, leave.endDate)) {
      dateKeys.add(toUtcDateKey(date));
    }
    approvedLeaveDateKeysByEmployeeId.set(leave.employeeId, dateKeys);
  }

  return {
    holidayDateKeys: new Set(holidays.map((holiday) => toUtcDateKey(holiday.date))),
    approvedLeaveDateKeysByEmployeeId,
    recordsByEmployeeAndDateKey: new Map(
      records.map((record) => [contextKey(record.employeeId, toUtcDateKey(record.date)), record]),
    ),
  };
};

export interface DerivedDay {
  date: string;
  status: DerivedDayStatus;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
  source: AttendanceRecordFacts["source"] | null;
  note: string | null;
}

const toDerivedDay = (
  date: Date,
  employeeId: string,
  context: AttendanceContext,
  today: Date,
  halfDayThresholdMinutes: number,
): DerivedDay => {
  const dateKey = toUtcDateKey(date);
  const record = context.recordsByEmployeeAndDateKey.get(contextKey(employeeId, dateKey)) ?? null;

  return {
    date: dateKey,
    status: deriveDailyStatus({
      date,
      today,
      holidayDateKeys: context.holidayDateKeys,
      approvedLeaveDateKeys: context.approvedLeaveDateKeysByEmployeeId.get(employeeId) ?? EMPTY_KEYS,
      record,
      halfDayThresholdMinutes,
    }),
    checkInAt: record?.checkInAt ?? null,
    checkOutAt: record?.checkOutAt ?? null,
    workedMinutes: record?.workedMinutes ?? null,
    source: record?.source ?? null,
    note: record?.note ?? null,
  };
};

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** First and last UTC calendar day of a month (month is 1-12). */
export const monthBounds = (year: number, month: number): { startDate: Date; endDate: Date } => ({
  startDate: new Date(Date.UTC(year, month - 1, 1)),
  endDate: new Date(Date.UTC(year, month, 0)),
});

// Every day of a month for one employee, each with its derived status.
export const buildMonthlyAttendance = async (
  db: Db,
  params: { organizationId: string; employeeId: string; year: number; month: number; today: Date; halfDayThresholdMinutes: number },
): Promise<DerivedDay[]> => {
  const { organizationId, employeeId, year, month, today, halfDayThresholdMinutes } = params;
  const { startDate, endDate } = monthBounds(year, month);

  const context = await loadAttendanceContext(db, organizationId, [employeeId], startDate, endDate);

  return eachUtcDateInRange(startDate, endDate).map((date) =>
    toDerivedDay(date, employeeId, context, today, halfDayThresholdMinutes),
  );
};

// One day's derived status for every employee in the org.
export const buildOrgDayAttendance = async (
  db: Db,
  params: { organizationId: string; date: Date; today: Date; halfDayThresholdMinutes: number },
): Promise<Array<{ employee: { id: string; fullName: string }; day: DerivedDay }>> => {
  const { organizationId, date, today, halfDayThresholdMinutes } = params;

  const employees = await db.employee.findMany({
    where: { organizationId },
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
  const context = await loadAttendanceContext(
    db,
    organizationId,
    employees.map((employee) => employee.id),
    date,
    date,
  );

  return employees.map((employee) => ({
    employee,
    day: toDerivedDay(date, employee.id, context, today, halfDayThresholdMinutes),
  }));
};
