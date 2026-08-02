import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APIError } from "better-auth";
import { registerCompany } from "../lib/registerCompany.js";
import { env } from "../env.js";

const registerCompanySchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  fullName: z.string().trim().min(1).max(200),
  email: z.email(),
  password: z.string().min(10).max(128),
});

export const registerCompanyRoutes = async (app: FastifyInstance) => {
  app.post("/api/register-company", async (request, reply) => {
    if (!env.ENABLE_PUBLIC_SIGNUP) {
      const providedSecret = request.headers["x-registration-secret"];
      if (!env.REGISTRATION_SECRET || providedSecret !== env.REGISTRATION_SECRET) {
        reply.status(401);
        return { error: "Unauthorized" };
      }
    }

    const parsed = registerCompanySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: z.prettifyError(parsed.error) };
    }

    try {
      const result = await registerCompany(parsed.data);
      result.authHeaders.forEach((value, key) => reply.header(key, value));
      reply.status(201);
      return { user: result.user, organization: result.organization };
    } catch (err) {
      if (err instanceof APIError) {
        reply.status(err.statusCode);
        return { error: err.body?.message ?? "Registration failed" };
      }
      app.log.error(err);
      reply.status(500);
      return { error: "Failed to complete company registration" };
    }
  });
};
