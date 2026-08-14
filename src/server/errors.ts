/**
 * Error taxonomy.
 *
 * Every failure the API can produce has a `code` drawn from a closed union that
 * the client imports. The UI branches on the code, never on the message, so
 * rewording an error message cannot break a form's error handling.
 *
 * The wire format is RFC 9457 problem details.
 */

export const ERROR_CODES = [
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_key_reused",
  "rate_limited",
  "period_approved",
  "record_locked",
  "timer_already_running",
  "rate_overlap",
  "attached_entries_changed",
  "retainer_insufficient",
  "invoice_state_invalid",
  "archive_blocked",
  "not_implemented",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  rate_limited: 429,
  period_approved: 409,
  record_locked: 409,
  timer_already_running: 409,
  rate_overlap: 409,
  attached_entries_changed: 409,
  retainer_insufficient: 409,
  invoice_state_invalid: 409,
  archive_blocked: 409,
  not_implemented: 501,
  internal_error: 500,
};

const TITLE: Record<ErrorCode, string> = {
  validation_failed: "Validation failed",
  unauthenticated: "Sign in required",
  forbidden: "Not allowed",
  not_found: "Not found",
  conflict: "Conflict",
  idempotency_key_reused: "Idempotency key reused",
  rate_limited: "Too many requests",
  period_approved: "That week has been approved",
  record_locked: "This cannot be changed",
  timer_already_running: "A timer is already running",
  rate_overlap: "Rate periods overlap",
  attached_entries_changed: "The attached time has changed",
  retainer_insufficient: "Not enough on the retainer",
  invoice_state_invalid: "Not possible in this state",
  archive_blocked: "Archive blocked",
  not_implemented: "Not available yet",
  internal_error: "Something went wrong",
};

export interface FieldErrors {
  [field: string]: string[];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: FieldErrors;
  readonly meta?: Record<string, unknown>;

  constructor(code: ErrorCode, detail?: string, opts: { fieldErrors?: FieldErrors; meta?: Record<string, unknown> } = {}) {
    super(detail ?? TITLE[code]);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.fieldErrors = opts.fieldErrors;
    this.meta = opts.meta;
  }
}

/* --------------------------------------------------------------- factories */

export const validationFailed = (fieldErrors: FieldErrors, detail?: string) =>
  new AppError("validation_failed", detail ?? "Some fields need attention.", { fieldErrors });

export const unauthenticated = (detail = "Sign in to continue.") => new AppError("unauthenticated", detail);

export const forbidden = (detail = "You do not have permission to do that.") => new AppError("forbidden", detail);

/**
 * Used for records outside the actor's scope as well as records that genuinely
 * do not exist. Returning 403 for the former would confirm that a record exists,
 * which is information the actor is not entitled to (BACKEND_PRD 7.3).
 */
export const notFound = (what = "That record") => new AppError("not_found", `${what} was not found.`);

export const conflict = (detail: string, meta?: Record<string, unknown>) =>
  new AppError("conflict", detail, { meta });

export const recordLocked = (reasons: string[], detail = "This can no longer be changed.") =>
  new AppError("record_locked", detail, { meta: { reasons } });

export const notImplemented = (what: string) =>
  new AppError("not_implemented", `${what} is not available in this build.`);

/* ------------------------------------------------------------ wire format */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  request_id: string;
  errors?: FieldErrors;
  meta?: Record<string, unknown>;
}

export function toProblem(error: unknown, requestId: string): ProblemDetails {
  if (error instanceof AppError) {
    return {
      type: `https://tally.jhmg/errors/${error.code}`,
      title: TITLE[error.code],
      status: error.status,
      detail: error.message,
      code: error.code,
      request_id: requestId,
      ...(error.fieldErrors ? { errors: error.fieldErrors } : {}),
      ...(error.meta ? { meta: error.meta } : {}),
    };
  }

  // Anything unrecognised is a bug, and its message may contain internals, so
  // the response says nothing beyond the request id. The full error goes to the
  // server log, where the request id ties the two together.
  return {
    type: "https://tally.jhmg/errors/internal_error",
    title: TITLE.internal_error,
    status: 500,
    detail: "Something went wrong. The request id below identifies it in the logs.",
    code: "internal_error",
    request_id: requestId,
  };
}

/** Postgres error codes worth translating into something a person can act on. */
export function fromDatabaseError(error: unknown): AppError | null {
  const e = unwrap(error);
  if (!e || typeof e !== "object") return null;

  const code = (e as { code?: string }).code;
  const constraint = (e as { constraint_name?: string }).constraint_name ?? "";

  if (code === "23505") {
    // unique_violation
    if (constraint === "one_running_timer_per_user") {
      return new AppError("timer_already_running", "A timer is already running. Stop it before starting another.");
    }
    if (constraint === "clients_name_unique") {
      return new AppError("conflict", "A client with that name already exists.", { meta: { constraint } });
    }
    if (constraint === "tasks_name_unique") {
      return new AppError("conflict", "A task with that name already exists.", { meta: { constraint } });
    }
    if (constraint === "invoices_number_unique") {
      return new AppError("conflict", "That invoice number is already in use.", { meta: { constraint } });
    }
    if (constraint === "users_email_unique" || constraint === "users_email_key") {
      return new AppError("conflict", "Somebody already uses that email address.", { meta: { constraint } });
    }
    return new AppError("conflict", "That would duplicate an existing record.", { meta: { constraint } });
  }

  if (code === "23P01") {
    // exclusion_violation
    if (constraint === "user_rates_no_overlap") {
      return new AppError("rate_overlap", "That rate period overlaps one that already exists.");
    }
    return new AppError("conflict", "That conflicts with an existing record.", { meta: { constraint } });
  }

  if (code === "23503") {
    return new AppError("conflict", "That references something that does not exist.", { meta: { constraint } });
  }

  if (code === "23514") {
    // check_violation: a bug in the caller, but a readable one
    return new AppError("validation_failed", `That value is not allowed (${constraint}).`, {
      meta: { constraint },
    });
  }

  return null;
}

function unwrap(error: unknown): unknown {
  let cur = error;
  for (let i = 0; i < 5 && cur; i += 1) {
    if (typeof cur === "object" && "code" in (cur as object)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return error;
}
