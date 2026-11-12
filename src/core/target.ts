/**
 * Resolve the target application for a command: its URL, the credential that applies to it, and a
 * traced HTTP client. Shared by every command that talks to a server.
 */

import type { Ctx } from "./ctx.ts";
import { SignumHttp, type ExplainedRequest } from "./http.ts";
import { renderDocument } from "./output.ts";
import { loadCredential, type StoredCredential } from "./credentials.ts";
import { NotAuthenticatedError, UsageError } from "./errors.ts";

export interface Target {
  url: string;
  /** The stored credential, when one applies to this target. Absent for an ambient token. */
  credential: StoredCredential | undefined;
  /** Where the bearer token came from. `none` means the request will go out anonymous. */
  tokenSource: "stored" | "environment" | "none";
  http: SignumHttp;
  /** Emitted once by the caller if set (AC-11.5). */
  permissionWarning: string | undefined;
}

/**
 * Where `--explain` shows a request (REQ-053): stdout, as a document in the chosen format. Handed to
 * every client the CLI builds, so a request any command makes is shown rather than sent (#122).
 */
export function explainSink(ctx: Ctx): ((request: ExplainedRequest) => void) | undefined {
  if (!ctx.args.flags.explain) return undefined;
  return (request) => renderDocument(request, { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
}

export function resolveTarget(ctx: Ctx, options: { requireAuth?: boolean } = {}): Target {
  const url = ctx.target;

  if (url === undefined) {
    throw new UsageError("no target application specified", {
      hint:
        "Pass --url <url>, set SIGNUM_URL, or run `signum auth login --url <url> --with-token`.\n" +
        "Discovery commands need only a URL — no credentials (see `signum help auth`).",
    });
  }

  // The stored token for THIS target only — never one issued to another application.
  const stored = loadCredential(url, ctx.io.env);
  const credential = stored?.credential;

  /**
   * AC-09.2: every credential can be supplied by environment variable.
   *
   * m1's only credential is a browser-handed-over token, and a CI runner has no browser — so
   * without this a pipeline could not authenticate at all except by writing `credential.json`
   * itself. The env var takes precedence over a stored credential, because an explicitly-set
   * variable is a deliberate act and a stored one is ambient state from an earlier login.
   *
   * It is deliberately NOT persisted: an ambient credential should stay ambient, or a CI run
   * would leave a token on a shared runner's disk.
   */
  const envToken = ctx.io.env["SIGNUM_TOKEN"];
  const useEnvToken = envToken !== undefined && envToken !== "";
  const token = useEnvToken ? envToken : credential?.token;
  const tokenSource: Target["tokenSource"] =
    useEnvToken ? "environment" : credential !== undefined ? "stored" : "none";

  if (options.requireAuth === true && tokenSource === "none") {
    // Exit 3, not 2: this is "not authenticated", and a script may usefully re-auth (AC-09.5).
    throw new NotAuthenticatedError(`no credential for ${url}`, {
      loginHint: {
        url,
        render: (login) =>
          "Run `" + login + " --with-token`, or set SIGNUM_TOKEN for a\n" +
          "non-interactive run. See `signum help auth`.",
      },
    });
  }

  const http = new SignumHttp({
    baseUrl: url,
    token,
    timeoutMs: ctx.args.flags.timeoutMs,
    trace: ctx.args.flags.verbose ? (line) => ctx.io.err(line) : undefined,
    explain: explainSink(ctx),
    // An ambient token has nowhere to be written back to, so a rotation must be reported rather
    // than attempted — the default handler updates the STORED credential and would fail with
    // "no stored credential to rotate", turning a successful request into a hard error. (Same
    // shape as the login-time rotation defect the Brooks review found.)
    ...(useEnvToken
      ? {
          onTokenRotated: () =>
            ctx.io.err(
              "warning: the server rotated the token, but SIGNUM_TOKEN cannot be updated from here.\n" +
              "The value in your environment still works; refresh it when convenient.\n",
            ),
        }
      : {}),
    env: ctx.io.env,
  });

  return { url, credential, tokenSource, http, permissionWarning: stored?.permissionWarning };
}

