import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env, isProduction } from "./env.js";
import authPlugin from "./core/plugins/auth.js";
import authGuardPlugin from "./core/plugins/authGuard.js";
import { registerErrorHandler } from "./core/plugins/errorHandler.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { registerCompanyRoutes } from "./modules/identity/registerCompany.routes.js";
import { invitationRoutes } from "./modules/identity/invitations.routes.js";
import { employeeRoutes } from "./modules/employees/employees.routes.js";
import { leaveRoutes } from "./modules/leave/leave.routes.js";
import { leaveRequestRoutes } from "./modules/leave/leaveRequests.routes.js";
import { systemAccrualRoutes } from "./modules/leave/systemAccrual.routes.js";
import { holidayRoutes } from "./modules/holidays/holidays.routes.js";
import { attendanceRoutes } from "./modules/attendance/attendance.routes.js";
import { regularizationRoutes } from "./modules/attendance/regularizations.routes.js";

export const buildApp = (): FastifyInstance => {
  const app = Fastify({
    logger: isProduction
      ? true
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        },
  });

  app.register(cors, {
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
  });

  app.register(authPlugin);
  app.register(authGuardPlugin);
  registerErrorHandler(app);

  // Grouped by module — mirrors src/modules/*.
  app.register(healthRoutes);
  app.register(registerCompanyRoutes);
  app.register(invitationRoutes);
  app.register(employeeRoutes);
  app.register(leaveRoutes);
  app.register(leaveRequestRoutes);
  app.register(systemAccrualRoutes);
  app.register(holidayRoutes);
  app.register(attendanceRoutes);
  app.register(regularizationRoutes);

  return app;
};
