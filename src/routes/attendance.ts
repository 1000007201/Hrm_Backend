import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { AttendanceStatus, EmployeeRole, Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { env } from "../env.js";
import { toUtcDateKey, utcMidnight } from "../lib/workingDays.js";
import {
  buildMonthlyAttendance,
  buildOrgDayAttendance,
  deriveDailyStatus,
  loadAttendanceContext,
  statusFromWorkedMinutes,
  toWorkedMinutes,
} from "../lib/attendance.js";

const MANAGER_ROLES = [EmployeeRole.ADMIN, EmployeeRole.HR];
const HALF_DAY_THRESHOLD_MINUTES = env.ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES;

const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });

// "YYYY-MM" -> { year, month }. Parsed as UTC like every other calendar date
// in this codebase (see the note in src/lib/workingDays.ts).
const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be in YYYY-MM format")
    .optional(),
});

const dateQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format")
    .optional(),
});

const markAttendanceSchema = z
  .object({
    employeeId: z.string().min(1),
    date: z.coerce.date(),
    status: z.enum(AttendanceStatus).optional(),
    checkInAt: z.coerce.date().optional(),
    checkOutAt: z.coerce.date().optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => data.status !== undefined || data.checkInAt !== undefined || data.checkOutAt !== undefined, {
    message: "Provide at least one of status, checkInAt or checkOutAt",
  })
  .refine((data) => !data.checkInAt || !data.checkOutAt || data.checkOutAt > data.checkInAt, {
    message: "checkOutAt must be after checkInAt",
    path: ["checkOutAt"],
  });

const resolveMonth = (month: string | undefined): { year: number; month: number } => {
  if (!month) {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }
  const [year, monthNumber] = month.split("-").map(Number);
  return { year: year!, month: monthNumber! };
};

/** Today as a UTC calendar day — the reference deriveDailyStatus compares against. */
const utcToday = (): Date => utcMidnight(new Date());

export const attendanceRoutes = async (app: FastifyInstance) => {
  app.post("/attendance/check-in", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId } = request.auth;
    const now = new Date();
    const today = utcMidnight(now);

    // Serializable + upsert on the (employeeId, date) unique constraint: two
    // simultaneous check-ins would otherwise both find "no record" and both
    // insert. Postgres aborts one, surfaced as 409 by the error handler.
    const record = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.attendanceRecord.findUnique({
          where: { employeeId_date: { employeeId, date: today } },
        });
        if (existing?.checkInAt) {
          throw new AppError(409, "CONFLICT", "You have already checked in today");
        }

        // Reuse the same reconciliation the read views use, so "is today a
        // working day for me" can't answer differently here than in the
        // month view.
        const context = await loadAttendanceContext(tx, organizationId, [employeeId], today, today);
        const derived = deriveDailyStatus({
          date: today,
          today,
          holidayDateKeys: context.holidayDateKeys,
          approvedLeaveDateKeys: context.approvedLeaveDateKeysByEmployeeId.get(employeeId) ?? new Set(),
          record: null,
          halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
        });
        if (derived === AttendanceStatus.WEEK_OFF) {
          throw new AppError(409, "CONFLICT", "Today is a week off — no check-in needed");
        }
        if (derived === AttendanceStatus.HOLIDAY) {
          throw new AppError(409, "CONFLICT", "Today is a company holiday — no check-in needed");
        }
        if (derived === AttendanceStatus.ON_LEAVE) {
          throw new AppError(409, "CONFLICT", "You are on approved leave today — no check-in needed");
        }

        return tx.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId, date: today } },
          // PRESENT is provisional until check-out recomputes it from worked
          // time (statusFromWorkedMinutes treats an open day as present).
          create: {
            organizationId,
            employeeId,
            date: today,
            checkInAt: now,
            status: AttendanceStatus.PRESENT,
            source: "SELF",
          },
          update: { checkInAt: now, status: AttendanceStatus.PRESENT, source: "SELF" },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    reply.status(201);
    return ok({ record });
  });

  app.post("/attendance/check-out", { preHandler: app.requireAuth }, async (request) => {
    const { employeeId } = request.auth;
    const now = new Date();
    const today = utcMidnight(now);

    const record = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.attendanceRecord.findUnique({
          where: { employeeId_date: { employeeId, date: today } },
        });
        if (!existing?.checkInAt) {
          throw new AppError(409, "CONFLICT", "You have not checked in today");
        }
        if (existing.checkOutAt) {
          throw new AppError(409, "CONFLICT", "You have already checked out today");
        }

        const workedMinutes = toWorkedMinutes(existing.checkInAt, now);
        return tx.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            checkOutAt: now,
            workedMinutes,
            status: statusFromWorkedMinutes(workedMinutes, HALF_DAY_THRESHOLD_MINUTES),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return ok({ record });
  });

  app.get("/attendance/me", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { year, month } = resolveMonth(monthQuerySchema.parse(request.query).month);

    const days = await buildMonthlyAttendance(prisma, {
      organizationId,
      employeeId,
      year,
      month,
      today: utcToday(),
      halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
    });

    return ok({ year, month, days });
  });

  app.get("/attendance", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { date } = dateQuerySchema.parse(request.query);
    const targetDate = date ? new Date(`${date}T00:00:00.000Z`) : utcToday();
    if (Number.isNaN(targetDate.getTime())) {
      throw new AppError(400, "VALIDATION", "date must be a valid YYYY-MM-DD date");
    }

    const attendance = await buildOrgDayAttendance(prisma, {
      organizationId,
      date: targetDate,
      today: utcToday(),
      halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
    });

    return ok({ date: toUtcDateKey(targetDate), attendance });
  });

  app.get("/attendance/:employeeId", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { employeeId } = employeeIdParamSchema.parse(request.params);
    const { year, month } = resolveMonth(monthQuerySchema.parse(request.query).month);

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true, fullName: true },
    });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const days = await buildMonthlyAttendance(prisma, {
      organizationId,
      employeeId,
      year,
      month,
      today: utcToday(),
      halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
    });

    return ok({ employee, year, month, days });
  });

  // Mark or correct one employee's day. Regularization (an employee
  // *requesting* a correction and someone approving it) is a separate later
  // prompt — this is the direct HR override.
  app.post("/attendance/mark", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { employeeId, date, status, checkInAt, checkOutAt, note } = markAttendanceSchema.parse(request.body);
    const day = utcMidnight(date);

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId }, select: { id: true } });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const record = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.attendanceRecord.findUnique({
          where: { employeeId_date: { employeeId, date: day } },
        });

        // Times may arrive across two calls (in now, out later), so recompute
        // from the merged pair rather than only what's in this payload.
        const mergedCheckInAt = checkInAt ?? existing?.checkInAt ?? null;
        const mergedCheckOutAt = checkOutAt ?? existing?.checkOutAt ?? null;
        if (mergedCheckInAt && mergedCheckOutAt && mergedCheckOutAt <= mergedCheckInAt) {
          throw new AppError(400, "VALIDATION", "checkOutAt must be after checkInAt");
        }
        const workedMinutes =
          mergedCheckInAt && mergedCheckOutAt ? toWorkedMinutes(mergedCheckInAt, mergedCheckOutAt) : null;

        // An explicit status wins; otherwise fall back to the shared
        // worked-time rule so HR entering only times still gets the same
        // PRESENT/HALF_DAY split a self check-out would produce.
        const resolvedStatus = status ?? statusFromWorkedMinutes(workedMinutes, HALF_DAY_THRESHOLD_MINUTES);

        const data = {
          checkInAt: mergedCheckInAt,
          checkOutAt: mergedCheckOutAt,
          workedMinutes,
          status: resolvedStatus,
          source: "HR_MARKED",
          note: note ?? existing?.note ?? null,
        } as const;

        return tx.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId, date: day } },
          create: { organizationId, employeeId, date: day, ...data },
          update: data,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return ok({ record });
  });
};
