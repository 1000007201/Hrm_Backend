import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { AttendanceStatus, EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { env } from "../../env.js";
import { toUtcDateKey, utcMidnight } from "../../shared/workingDays.js";
import { buildMonthlyAttendance, buildOrgDayAttendance } from "./derivation.js";
import { checkIn, checkOut, markAttendance } from "./attendance.service.js";

const MANAGER_ROLES = [EmployeeRole.ADMIN, EmployeeRole.HR];
const HALF_DAY_THRESHOLD_MINUTES = env.ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES;

const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });

// "YYYY-MM" -> { year, month }. Parsed as UTC like every other calendar date
// in this codebase (see the note in src/shared/workingDays.ts).
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

    const record = await checkIn(prisma, { organizationId, employeeId });

    reply.status(201);
    return ok({ record });
  });

  app.post("/attendance/check-out", { preHandler: app.requireAuth }, async (request) => {
    const { employeeId } = request.auth;

    const record = await checkOut(prisma, { employeeId });
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

  // Direct HR override. The employee-initiated equivalent (request +
  // approval, with an audit trail) is in regularizations.routes.ts.
  app.post("/attendance/mark", { preHandler: app.requireRole(MANAGER_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const body = markAttendanceSchema.parse(request.body);

    const record = await markAttendance(prisma, { organizationId, ...body });
    return ok({ record });
  });
};
