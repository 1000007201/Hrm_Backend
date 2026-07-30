import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env, isProduction } from "./env.js";
import authPlugin from "./plugins/auth.js";
import { healthRoutes } from "./routes/health.js";

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
  app.register(healthRoutes);

  return app;
};
