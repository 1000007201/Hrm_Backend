import type { FastifyError, FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError, type ErrorCode } from "../errors.js";
import { isProduction } from "../../env.js";

// Centralized mapping from "whatever a handler threw" to the
// { success: false, error } envelope. Route handlers throw AppError (or let
// zod/Prisma errors bubble) instead of formatting error responses themselves.
// Does not apply to /api/auth/* — that route replies directly and never
// throws into this handler.
export const registerErrorHandler = (app: FastifyInstance) => {
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, request, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode);
      return {
        success: false,
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      };
    }

    if (err instanceof ZodError) {
      reply.status(400);
      return {
        success: false,
        error: { code: "VALIDATION" satisfies ErrorCode, message: "Invalid request", details: z.treeifyError(err) },
      };
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        reply.status(409);
        return { success: false, error: { code: "CONFLICT" satisfies ErrorCode, message: "A record with this value already exists" } };
      }
      if (err.code === "P2025") {
        reply.status(404);
        return { success: false, error: { code: "NOT_FOUND" satisfies ErrorCode, message: "Record not found" } };
      }
      if (err.code === "P2034") {
        // Write conflict/deadlock under a Serializable transaction (used for
        // balance-critical writes like leave submission/approval) — the
        // transaction was rolled back in full, nothing partially applied.
        reply.status(409);
        return {
          success: false,
          error: { code: "CONFLICT" satisfies ErrorCode, message: "That conflicted with another update — please try again" },
        };
      }
    }

    request.log.error(err);
    reply.status(500);
    return {
      success: false,
      error: { code: "INTERNAL" satisfies ErrorCode, message: isProduction ? "Internal server error" : err.message },
    };
  });
};
