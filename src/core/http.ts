/**
 * HTTP client.
 *
 * STORY-04 (New_Token rotation) · STORY-08 (403 disambiguation) · STORY-11 (redaction)
 *
 * Three server behaviours this must get right, each verified in framework source:
 *   • Auth failures are 403, NEVER 401 (SignumExceptionFilterAttribute.cs:131-146), and 403
 *     covers both "not authenticated" and "not authorized" — discriminate on exceptionType.
 *   • Tokens never expire; the server rotates them via a New_Token response header
 *     (AuthTokensServer.cs:85-94). Ignoring it freezes the user's role permanently.
 *   • A malformed token degrades SILENTLY to anonymous rather than erroring, so a stored
 *     token must be verified via api/auth/currentUser before it is trusted (AC-04.6).
 */

import {
  ConcurrencyError, NotAuthenticatedError, NotAuthorizedError, NotFoundError,
  TransportError, ValidationError, CliError, ExitCode,
} from "./errors.ts";
import { rotateCredential } from "./config.ts";

export const REDACTED = "<redacted>";

export interface HttpOptions {
  baseUrl: string;
  token?: string | undefined;
  timeoutMs?: number | undefined;
  /** Trace to stderr with credentials redacted (AC-11.2). */
  trace?: ((line: string) => void) | undefined;
  /** Called when the server rotates the token, so it can be persisted. */
  onTokenRotated?: ((token: string) => void) | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Extra request headers; values are redacted in traces if they look like credentials. */
  headers?: Record<string, string>;
  /** Sent even when no token is stored — used for anonymous endpoints. */
  allowAnonymous?: boolean;
  ifModifiedSince?: string | undefined;
}

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  /** True when the server answered 304 for a conditional request. */
  notModified: boolean;
}

const SENSITIVE_HEADERS = new Set(["authorization", "x-apikey", "new_token", "cookie"]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

export function buildUrl(baseUrl: string, path: string, query?: RequestSpec["query"]): string {
  const base = baseUrl.replace(/\/+$/, "");
  const rel = path.replace(/^\/+/, "");
  const url = new URL(`${base}/${rel}`);
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Extract Signum's exceptionType from an error body, however it is shaped. */
function exceptionType(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const direct = b["exceptionType"] ?? b["ExceptionType"];
  if (typeof direct === "string") return direct;
  return undefined;
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim() !== "") return body.trim().slice(0, 500);
  if (body !== null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["exceptionMessage", "ExceptionMessage", "title", "message", "Message", "detail"]) {
      const v = b[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 500);
    }
  }
  return fallback;
}

export class SignumHttp {
  constructor(private readonly opts: HttpOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /**
   * Whether this client will send a credential. Reflection responses are role-dependent
   * (`AuthServer.cs:143-157` clears `QueryDefined` for anything the caller may not query, and
   * an anonymous caller may query nothing), so the metadata cache has to know which kind of
   * answer it holds. Exposes only presence, never the token itself.
   */
  get hasToken(): boolean {
    return this.opts.token !== undefined && this.opts.token !== "";
  }

  async request<T = unknown>(spec: RequestSpec): Promise<HttpResponse<T>> {
    const url = buildUrl(this.opts.baseUrl, spec.path, spec.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(spec.headers ?? {}),
    };

    if (this.opts.token !== undefined && this.opts.token !== "") {
      headers["Authorization"] = `Bearer ${this.opts.token}`;
    } else if (spec.allowAnonymous !== true) {
      throw new NotAuthenticatedError("no stored credential for this target", {
        hint: "Run `signum auth login --url <url> --with-token`. See `signum help auth`.",
      });
    }

    if (spec.body !== undefined) headers["content-type"] = "application/json";
    if (spec.ifModifiedSince !== undefined) headers["if-modified-since"] = spec.ifModifiedSince;

    this.opts.trace?.(`> ${spec.method} ${url}\n`);
    if (this.opts.trace !== undefined) {
      for (const [k, v] of Object.entries(redactHeaders(headers))) {
        this.opts.trace(`> ${k}: ${v}\n`);
      }
    }

    const controller = new AbortController();
    const timeout = this.opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        method: spec.method,
        headers,
        signal: controller.signal,
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new TransportError(
        aborted ? `request timed out after ${timeout}ms` : `could not reach ${this.opts.baseUrl}`,
        {
          hint: aborted
            ? "Raise the limit with --timeout <seconds>."
            : "Check the URL and network. Is the application running and reachable?",
          cause: err,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    this.opts.trace?.(`< ${res.status} ${res.statusText}\n`);

    // Adopt a rotated token before anything else can fail (AC-04.4).
    const rotated = res.headers.get("New_Token") ?? res.headers.get("new_token");
    if (rotated !== null && rotated !== "") {
      this.opts.trace?.(`< New_Token: ${REDACTED} (adopting)\n`);
      const failure = this.opts.onTokenRotated !== undefined
        ? (this.opts.onTokenRotated(rotated), undefined)
        : rotateCredential(rotated, this.opts.env);
      if (failure !== undefined) {
        // Surfaced, never swallowed: a lost rotation costs a manual browser step (AC-12.12).
        throw new CliError(`token was rotated by the server but could not be saved: ${failure}`, ExitCode.Unexpected, {
          hint: "Re-run `signum auth login --with-token` to store a fresh token.",
        });
      }
    }

    if (res.status === 304) {
      return { status: 304, body: undefined as T, headers: res.headers, notModified: true };
    }

    const text = await res.text();
    let body: unknown = text;
    const contentType = res.headers.get("content-type") ?? "";
    if (text !== "" && (contentType.includes("json") || text.startsWith("{") || text.startsWith("["))) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (res.ok) return { status: res.status, body: body as T, headers: res.headers, notModified: false };

    throw this.toError(res.status, body);
  }

  private toError(status: number, body: unknown): CliError {
    const type = exceptionType(body) ?? "";
    const message = errorMessage(body, `HTTP ${status}`);

    if (status === 403) {
      // 403 covers BOTH cases; exceptionType is the only discriminator (AC-08.2).
      if (type.includes("AuthenticationException")) {
        return new NotAuthenticatedError(`not authenticated: ${message}`, {
          hint: "Your token may be invalid or superseded. Re-run `signum auth login --with-token`.",
        });
      }
      if (type.includes("UnauthorizedAccessException")) {
        return new NotAuthorizedError(`not authorized: ${message}`, {
          hint:
            "This is a permission problem, so retrying will not help. Note that operations hidden\n" +
            "from the web UI cannot be invoked over the API at all.",
        });
      }
      return new NotAuthenticatedError(`forbidden (403): ${message}`, {
        hint:
          "Signum returns 403 for both authentication and authorization failures and this response\n" +
          "carried no exceptionType, so the cause is ambiguous. Try `signum auth status`.",
      });
    }

    if (status === 401) {
      // Should be unreachable against Signum; if it happens, say so plainly.
      return new NotAuthenticatedError(`unexpected 401 from the server: ${message}`, {
        hint: "Signum normally returns 403, never 401. A proxy may be intercepting requests.",
      });
    }

    if (status === 404) {
      return new NotFoundError(message, { hint: "Check the type name, id, or query key." });
    }

    if (status === 400) {
      return new ValidationError(message, { hint: "The server rejected the request payload." });
    }

    if (status >= 500) {
      if (type.includes("ConcurrencyException")) {
        return new ConcurrencyError("the record changed since you read it", {
          hint: "Refetch and retry. This CLI never auto-retries, so the resolution stays your decision.",
        });
      }
      if (type.includes("FormatException")) {
        // A 500 that is really BAD INPUT. Signum's exception filter has no arm for
        // FormatException (`SignumExceptionFilterAttribute.cs:131-146`), so everything it throws
        // — notably an unknown query token from `QueryUtils.Parse` (`QueryUtils.cs:385,390`) —
        // arrives as 500. Reporting a user's typo as "unexpected, please report it" sends them
        // to file a bug about their own input; the message names what it could not resolve.
        return new ValidationError(message, {
          hint: "The server could not parse something in the request. This is usually a token or value, not a fault.",
        });
      }
      return new CliError(`server error (${status}): ${message}`, ExitCode.Unexpected);
    }

    return new CliError(`unexpected response (${status}): ${message}`, ExitCode.Unexpected);
  }
}
