// Shared success envelope — pair with `reply.status(code)` in the handler,
// same as before. Errors go through AppError + the central error handler
// instead (see src/lib/errors.ts, src/plugins/errorHandler.ts).
export const ok = <T>(data: T) => ({ success: true as const, data });
