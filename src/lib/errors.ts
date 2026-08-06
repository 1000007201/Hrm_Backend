import type { APIError } from "better-auth";

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

// Thrown for any known, expected failure (missing record, bad role, duplicate
// email, ...). Caught centrally by the Fastify error handler in
// src/plugins/errorHandler.ts and turned into the { success: false, error }
// envelope — route handlers never format error responses themselves.
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  // Better Auth's own APIError already carries an HTTP status + message; this
  // just re-labels it into our envelope shape instead of inventing new codes.
  static fromBetterAuthError(err: APIError): AppError {
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 400;
    const code: ErrorCode =
      statusCode === 409
        ? "CONFLICT"
        : statusCode === 404
          ? "NOT_FOUND"
          : statusCode === 401
            ? "UNAUTHORIZED"
            : statusCode === 403
              ? "FORBIDDEN"
              : "VALIDATION";
    return new AppError(statusCode, code, err.body?.message ?? err.message ?? "Request failed");
  }
}
