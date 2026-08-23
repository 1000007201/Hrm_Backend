import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/prisma.js";

export const healthRoutes = async (app: FastifyInstance) => {
  app.get("/health", async () => {
    return { status: "ok", uptime: process.uptime() };
  });

  app.get("/health/db", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok" };
    } catch (err) {
      app.log.error(err);
      reply.status(503);
      return { status: "down" };
    }
  });

  app.get("/me", async (request, reply) => {
    const session = await request.getSession();

    if (!session) {
      reply.status(401);
      return { error: "Unauthorized" };
    }

    return {
      user: session.user,
      activeOrganizationId: session.session.activeOrganizationId ?? null,
    };
  });
};
