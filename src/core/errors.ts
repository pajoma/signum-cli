/**
 * Exit-code taxonomy and typed errors.
 *
 * REQ-051 · STORY-08 · design/cli-surface.md §5
 *
 * The taxonomy exists so scripts and agents can tell "retry might help" from "stop".
 * Codes 3 and 4 are separate even though the server returns 403 for BOTH authentication
 * and authorization failures — the discriminator is `exceptionType` (AC-08.2).
 */

export const ExitCode = {
  Ok: 0,
  Unexpected: 1,
  Usage: 2,
  NotAuthenticated: 3,
  NotAuthorized: 4,
  NotFound: 5,
  Validation: 6,
  Concurrency: 7,
  Transport: 8,
  Policy: 9,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Human-facing one-liners, used by `signum help exit-codes`. */
export const EXIT_CODE_DESCRIPTIONS: Record<ExitCode, string> = {
  [ExitCode.Ok]: "success",
  [ExitCode.Unexpected]: "unexpected error",
  [ExitCode.Usage]: "usage error — bad flags or unparseable input",
  [ExitCode.NotAuthenticated]: "not authenticated — re-authentication may help",
  [ExitCode.NotAuthorized]: "not authorized — do not retry",
  [ExitCode.NotFound]: "not found",
  [ExitCode.Validation]: "validation failed",
  [ExitCode.Concurrency]: "concurrency conflict — refetch and retry",
  [ExitCode.Transport]: "network or timeout",
  [ExitCode.Policy]: "blocked by policy",
};

export interface CliErrorOptions {
  /** Actionable next step. Shown after the message; this is where help routing lives (STORY-63). */
  hint?: string;
  cause?: unknown;
}

/** Base for every error the CLI raises deliberately. Anything else exits `Unexpected`. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCode, options: CliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.hint = options.hint;
  }
}

export class UsageError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.Usage, options);
  }
}

/** 403 + `…AuthenticationException`, or no credential at all. Re-auth may help. */
export class NotAuthenticatedError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.NotAuthenticated, options);
  }
}

/** 403 + `…UnauthorizedAccessException`. A permission problem — retrying cannot help. */
export class NotAuthorizedError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.NotAuthorized, options);
  }
}

export class NotFoundError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.NotFound, options);
  }
}

export class ValidationError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.Validation, options);
  }
}

/** HTTP 500 carrying `Signum.Engine.ConcurrencyException`. Refetch, then retry. */
export class ConcurrencyError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.Concurrency, options);
  }
}

export class TransportError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.Transport, options);
  }
}

/** Refused by our own policy — e.g. emitting row data to a detected agent (STORY-51). */
export class PolicyError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, ExitCode.Policy, options);
  }
}

export function exitCodeOf(err: unknown): ExitCode {
  return err instanceof CliError ? err.exitCode : ExitCode.Unexpected;
}
