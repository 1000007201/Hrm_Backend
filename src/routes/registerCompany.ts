import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APIError } from "better-auth";
import { registerCompany } from "../lib/registerCompany.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
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
        throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
      }
    }

    const parsed = registerCompanySchema.parse(request.body);

    try {
      const result = await registerCompany(parsed);
      result.authHeaders.forEach((value, key) => reply.header(key, value));
      reply.status(201);
      return ok({ user: result.user, organization: result.organization });
    } catch (err) {
      if (err instanceof APIError) {
        throw AppError.fromBetterAuthError(err);
      }
      throw err;
    }
  });
};
