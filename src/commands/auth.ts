/**
 * `signum auth login|status|logout`
 *
 * STORY-12 (browser token handoff — the ONLY viable mechanism for the target app),
 * STORY-06 (identity check), STORY-04 (persistence), STORY-09 (never prompt without a TTY),
 * STORY-11 (never print a credential).
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, NotAuthenticatedError, UsageError } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import { deleteCredential, loadCredential, saveCredential } from "../core/config.ts";
import { SignumHttp } from "../core/http.ts";
import { flag, opt, resolveTarget } from "./context.ts";

const HANDOFF_INSTRUCTIONS = [
  "To obtain a token:",
  "  1. Sign in to the web application in your browser.",
  '  2. Open the browser console and run:  sessionStorage.getItem("authToken")',
  "  3. Pipe the value in:",
  "       signum auth login --url <url> --with-token < token.txt",
  '       printf %s "$TOKEN" | signum auth login --url <url> --with-token',
].join("\n");

async function login(ctx: Ctx): Promise<ExitCode> {
  // L1 (Brooks review): --url always parses into flags.url; it is never in `options`, so the
  // old `?? opt(ctx, "url")` fallback was dead code that misled about how flags flow.
  const url = ctx.args.flags.url;
  if (url === undefined) {
    throw new UsageError("--url is required to log in", {
      hint: "signum auth login --url https://app.example --with-token",
    });
  }

  const withToken = flag(ctx, "with-token") || opt(ctx, "with-token") !== undefined;
  if (!withToken) {
    throw new UsageError("--with-token is required", {
      hint:
        "This application accepts only a browser token handoff — it has no Signum.Rest module,\n" +
        "and Entra-provisioned users have no local password.\n\n" + HANDOFF_INSTRUCTIONS,
    });
  }

  // Read from stdin ONLY — never an argument, which would leak into shell history (AC-12.1).
  if (ctx.io.stdinIsTty) {
    // A TTY here means nothing was piped. Refusing beats hanging (STORY-09).
    throw new UsageError("no token on stdin", {
      hint: "The token is read from stdin so it never appears in shell history.\n\n" + HANDOFF_INSTRUCTIONS,
    });
  }

  const token = (await ctx.io.readStdin()).trim();
  if (token === "") {
    throw new UsageError("empty token on stdin", { hint: HANDOFF_INSTRUCTIONS });
  }

  // Validate before storing, so a bad paste fails now rather than mysteriously later.
  // A malformed token degrades silently to anonymous server-side, so this check is required (AC-12.3).
  //
  // `onTokenRotated` is REQUIRED here, not optional (Brooks review): validation runs before any
  // credential exists, so the default handler — `rotateCredential`, which updates the stored
  // one — would fail with "no stored credential to rotate" and abort the login. A token old
  // enough to trigger rotation on its very first use is exactly the token a user pastes out of
  // a browser session that has been open a while, and losing the replacement costs them another
  // handoff (AC-04.4, AC-12.12). Capture it locally and store it instead of the submitted one.
  let rotated: string | undefined;
  const http = new SignumHttp({
    baseUrl: url,
    token,
    timeoutMs: ctx.args.flags.timeoutMs,
    trace: ctx.args.flags.verbose ? (l) => ctx.io.err(l) : undefined,
    onTokenRotated: (fresh) => { rotated = fresh; },
    env: ctx.io.env,
  });

  const res = await http.request<unknown>({ method: "GET", path: "api/auth/currentUser" });
  const user = res.body;
  if (user === null || user === undefined || user === "") {
    throw new NotAuthenticatedError("the token was accepted but resolved to no user (anonymous)", {
      hint:
        "Signum silently degrades an invalid token to anonymous rather than rejecting it, so this\n" +
        "almost certainly means the token is wrong, truncated, or from a different application.\n\n" +
        HANDOFF_INSTRUCTIONS,
    });
  }

  const now = new Date().toISOString();
  const path = saveCredential(
    {
      url,
      token: rotated ?? token,
      source: "browser-handoff",
      savedAt: now,
      ...(rotated !== undefined ? { rotatedAt: now } : {}),
    },
    ctx.io.env,
  );

  const name = userName(user) ?? "(unknown)";
  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(
      { url, user: name, storedAt: path, rotatedOnLogin: rotated !== undefined },
      { format: ctx.format, write: ctx.io.out },
    );
  } else {
    ctx.io.out(`Logged in to ${url} as ${name}\n`);
    if (rotated !== undefined) {
      // Say so: the token in the user's clipboard is no longer the one that is stored.
      ctx.io.err("The server rotated the token during validation; the replacement was stored.\n");
    }
    ctx.io.err(`Credential stored at ${path} (mode 600).\n`);
    ctx.io.err(
      "This token is your only credential for this application; losing it means repeating the\n" +
      "browser handoff. It does not expire, and rotation is handled automatically.\n",
    );
  }
  return ExitCode.Ok;
}

function userName(user: unknown): string | undefined {
  if (user === null || typeof user !== "object") return undefined;
  const u = user as Record<string, unknown>;
  for (const key of ["userName", "toStr", "email", "ToStr"]) {
    const v = u[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

async function status(ctx: Ctx): Promise<ExitCode> {
  const stored = loadCredential(ctx.io.env);
  const url = ctx.args.flags.url ?? stored?.credential.url;

  const report = {
    target: url ?? null,
    credential: stored !== undefined ? "stored" : "none",
    // A token is NEVER printed, not even truncated (AC-06.3).
    authenticated: false as boolean,
    user: null as string | null,
    callerContext: ctx.caller.context,
    callerSignals: ctx.caller.signals,
    reachable: null as boolean | null,
    detail: null as string | null,
  };

  if (url === undefined) {
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDocument(report, { format: ctx.format, write: ctx.io.out });
    } else {
      ctx.io.out("Not configured.\n");
      ctx.io.out("\n" + HANDOFF_INSTRUCTIONS + "\n");
    }
    return ExitCode.NotAuthenticated;
  }

  const target = resolveTarget(ctx);
  if (target.permissionWarning !== undefined) {
    ctx.io.err(`warning: ${target.permissionWarning}\n`);
  }

  if (target.credential === undefined) {
    report.reachable = null;
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDocument(report, { format: ctx.format, write: ctx.io.out });
    } else {
      ctx.io.out(`Target        ${url}\n`);
      ctx.io.out(`Credential    none for this target\n`);
      ctx.io.out(`Caller        ${ctx.caller.context}\n`);
      ctx.io.out("\nDiscovery works without credentials; data access does not.\n");
    }
    return ExitCode.NotAuthenticated;
  }

  try {
    const res = await target.http.request<unknown>({ method: "GET", path: "api/auth/currentUser" });
    const name = userName(res.body);
    // Distinguish "authenticated as anonymous" from "authenticated as a user" (AC-06.2).
    report.authenticated = name !== undefined;
    report.user = name ?? null;
    report.reachable = true;
  } catch (err) {
    report.reachable = false;
    report.detail = err instanceof Error ? err.message : String(err);
  }

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(report, { format: ctx.format, write: ctx.io.out });
  } else {
    ctx.io.out(`Target        ${url}\n`);
    ctx.io.out(`Credential    stored (browser handoff, ${stored?.credential.savedAt ?? "unknown"})\n`);
    if (stored?.credential.rotatedAt !== undefined) {
      ctx.io.out(`Rotated       ${stored.credential.rotatedAt}\n`);
    }
    ctx.io.out(
      report.authenticated
        ? `Identity      ${report.user}\n`
        : report.reachable === true
          ? `Identity      anonymous — the stored token is not being accepted\n`
          : `Identity      unknown (${report.detail})\n`,
    );
    ctx.io.out(`Caller        ${ctx.caller.context}\n`);
    if (ctx.args.flags.verbose) {
      for (const s of ctx.caller.signals) ctx.io.out(`              · ${s}\n`);
    }
    // The one credential is a single point of failure; say so (AC-12.13).
    ctx.io.err("\nThis token is the only credential for this application (no Signum.Rest, no password).\n");
  }

  return report.authenticated ? ExitCode.Ok : ExitCode.NotAuthenticated;
}

function logout(ctx: Ctx): ExitCode {
  const removed = deleteCredential(ctx.io.env);
  ctx.io.out(removed ? "Credential removed.\n" : "No stored credential.\n");
  if (removed) {
    // Be honest: api/auth/logout clears a cookie and performs no token revocation (AC-07.2).
    ctx.io.err(
      "Note: this is local only. Signum does not revoke issued tokens, so the token remains\n" +
      "valid server-side until the user's password hash or state changes.\n",
    );
  }
  return ExitCode.Ok;
}

export async function runAuth(ctx: Ctx): Promise<ExitCode> {
  const sub = ctx.args.positionals[0]?.toLowerCase();
  switch (sub) {
    case "login":  return await login(ctx);
    case "status": return await status(ctx);
    case "logout": return logout(ctx);
    case undefined:
      throw new UsageError("`auth` needs a subcommand", { hint: "Run `signum auth --help`." });
    default:
      throw new UsageError(`unknown auth subcommand '${sub}'`, {
        hint: "Valid subcommands: login, status, logout.",
      });
  }
}
