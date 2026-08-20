import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env, isProduction } from "./env.js";
import authPlugin from "./plugins/auth.js";
import authGuardPlugin from "./plugins/authGuard.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { registerCompanyRoutes } from "./routes/registerCompany.js";
import { employeeRoutes } from "./routes/employees.js";
import { invitationRoutes } from "./routes/invitations.js";
import { leaveRoutes } from "./routes/leave.js";
import { leaveRequestRoutes } from "./routes/leaveRequests.js";
import { holidayRoutes } from "./routes/holidays.js";
import { attendanceRoutes } from "./routes/attendance.js";
import { regularizationRoutes } from "./routes/regularizations.js";
import { systemAccrualRoutes } from "./routes/systemAccrual.js";

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

  app.register(healthRoutes);
  app.register(registerCompanyRoutes);
  app.register(employeeRoutes);
  app.register(invitationRoutes);
  app.register(leaveRoutes);
  app.register(leaveRequestRoutes);
  app.register(holidayRoutes);
  app.register(attendanceRoutes);
  app.register(regularizationRoutes);
  app.register(systemAccrualRoutes);

  return app;
};
