/**
 * Shared plumbing for commands that talk to a server: resolve the target URL,
 * load the credential, and build a traced HTTP client.
 */

import type { Ctx } from "../cli.ts";
import { SignumHttp } from "../core/http.ts";
import { loadCredential, type StoredCredential } from "../core/config.ts";
import { normalizeUrl } from "../core/text.ts";
import { NotAuthenticatedError, UsageError } from "../core/errors.ts";

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

export function resolveTarget(ctx: Ctx, options: { requireAuth?: boolean } = {}): Target {
  const stored = loadCredential(ctx.io.env);
  const url = ctx.args.flags.url ?? stored?.credential.url;

  if (url === undefined) {
    throw new UsageError("no target application specified", {
      hint:
        "Pass --url <url>, set SIGNUM_URL, or run `signum auth login --url <url> --with-token`.\n" +
        "Discovery commands need only a URL — no credentials (see `signum help auth`).",
    });
  }

  // Use the stored token only for the target it was issued against.
  // Compare canonically so a trailing slash or default port does not orphan the credential (M2).
  const credential =
    stored !== undefined && normalizeUrl(stored.credential.url) === normalizeUrl(url) ? stored.credential : undefined;

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
      hint:
        "Run `signum auth login --url " + url + " --with-token`, or set SIGNUM_TOKEN for a\n" +
        "non-interactive run. See `signum help auth`.",
    });
  }

  const http = new SignumHttp({
    baseUrl: url,
    token,
    timeoutMs: ctx.args.flags.timeoutMs,
    trace: ctx.args.flags.verbose ? (line) => ctx.io.err(line) : undefined,
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

/** Single option value, or undefined. */
export function opt(ctx: Ctx, name: string): string | undefined {
  const list = ctx.args.options.get(name);
  return list?.[list.length - 1];
}

/** All values of a repeatable option, in order. */
export function optAll(ctx: Ctx, name: string): string[] {
  return ctx.args.options.get(name) ?? [];
}

export function flag(ctx: Ctx, name: string): boolean {
  return ctx.args.booleans.has(name);
}
