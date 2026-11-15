/** Typed domain errors. `errorResponse` maps `status` straight to the HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** The request is well formed but conflicts with the current state (a stale update, a cap reached). */
export class ConflictError extends HttpError {
  constructor(message = "That change isn't allowed from the current state.") {
    super(409, message);
  }
}

/**
 * A write carried a stale `version` (someone else changed the row first). `current` is what the caller may see of the
 * row, so a client can show what changed; `errorResponse` sends it as `{ error, current }`.
 */
export class VersionConflictError extends ConflictError {
  constructor(
    readonly current: unknown,
    message = "This was changed by someone else. Review the latest version and try again.",
  ) {
    super(message);
  }
}

/** A conflict with a stable machine-readable `code` (`sold_out`, `slug_taken`, ...), sent as `{ error, code }`. */
export class CodedConflictError extends ConflictError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(limit: number) {
    super(413, `Body too large (limit ${limit} bytes)`);
  }
}

/** Too many attempts in a window (for example share attempts per hour). */
export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests") {
    super(429, message);
  }
}

/** The request is well formed but the content is unacceptable (for example a file that isn't the image it claims to be). */
export class UnprocessableError extends HttpError {
  constructor(message = "Unprocessable") {
    super(422, message);
  }
}
