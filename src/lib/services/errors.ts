/**
 * Errors that map to an HTTP response. Anything that is not an ApiError is reported to the
 * client as a generic 500 so internal details never leak.
 */

export type ApiErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "payment_error"
  | "unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const invalid = (message: string, details?: unknown) => new ApiError(400, "invalid_request", message, details);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (message = "You do not have access to this resource") => new ApiError(403, "forbidden", message);
export const conflict = (message: string, details?: unknown) => new ApiError(409, "conflict", message, details);
export const rateLimited = (resetAt: string) =>
  new ApiError(429, "rate_limited", "Too many requests. Please slow down and try again shortly.", { resetAt });
export const unavailable = (message: string) => new ApiError(503, "unavailable", message);
