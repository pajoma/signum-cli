/**
 * Shared plumbing for commands that talk to a server: resolve the target URL,
 * load the credential, and build a traced HTTP client.
 */

import type { Ctx } from "../cli.ts";
import { SignumHttp } from "../core/http.ts";
import { loadCredential, type StoredCredential } from "../core/config.ts";
import { NotAuthenticatedError, UsageError } from "../core/errors.ts";

export interface Target {
  url: string;
  credential: StoredCredential | undefined;
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
  const credential = stored !== undefined && stored.credential.url === url ? stored.credential : undefined;

  if (options.requireAuth === true && credential === undefined) {
    // Exit 3, not 2: this is "not authenticated", and a script may usefully re-auth.
    throw new NotAuthenticatedError(`no stored credential for ${url}`, {
      hint: "Run `signum auth login --url " + url + " --with-token`. See `signum help auth`.",
    });
  }

  const http = new SignumHttp({
    baseUrl: url,
    token: credential?.token,
    timeoutMs: ctx.args.flags.timeoutMs,
    trace: ctx.args.flags.verbose ? (line) => ctx.io.err(line) : undefined,
    env: ctx.io.env,
  });

  return { url, credential, http, permissionWarning: stored?.permissionWarning };
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
