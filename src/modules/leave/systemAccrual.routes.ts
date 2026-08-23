import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { accrueForAllOrgs } from "./accrual.js";

// No Better Auth session here by design — this is machine-to-machine (the
// monthly cron), gated by a shared secret instead of app.requireAuth. Kept in
// its own route file/namespace (/system/*, not /api/* or a guarded route) so
// it's obviously not part of the normal user-facing surface.
export const systemAccrualRoutes = async (app: FastifyInstance) => {
  app.post("/system/leave/accrual/run-all", async (request) => {
    if (request.headers["x-accrual-secret"] !== env.ACCRUAL_SECRET) {
      throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const results = await accrueForAllOrgs(year, month);

    return ok({
      year,
      month,
      organizationsProcessed: results.length,
      results,
    });
  });
};
