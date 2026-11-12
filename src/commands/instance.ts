/**
 * `signum instance add|set|list|remove` — named instances, which are profiles (REQ-001, STORY-05).
 *
 * Purely local: nothing here touches the network, so an instance can be registered before the
 * application is reachable. A registered slug is then usable anywhere `--url` is, as `-i <slug>`.
 */

import type { Ctx } from "../core/ctx.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import { flag, opt } from "../core/ctx.ts";
import {
  addInstance, instancesPath, listInstances, removeInstance, updateInstance, validateHeaderName, validateSlug, validateUrl,
  type Instance, type ProfileSettings,
} from "../core/instances.ts";

function isJson(ctx: Ctx): ctx is Ctx & { format: "json" | "ndjson" } {
  return ctx.format === "json" || ctx.format === "ndjson";
}

/**
 * The name is always given, never derived from the URL. A derived name is a guess the user did not
 * make: two applications on one host label collide, and a name nobody chose is the one `-i` will
 * later send production commands to.
 */
function add(ctx: Ctx): ExitCode {
  const [, rawSlug, rawUrl] = ctx.args.positionals;
  const usage = "signum instance add <name> <url>\n  e.g. signum instance add renew https://renew.example.org";
  const looksLikeUrl = (v: string | undefined) => v !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
  if (looksLikeUrl(rawSlug) && rawUrl === undefined) {
    throw new UsageError("`instance add` needs a name before the URL", { hint: usage });
  }
  if (looksLikeUrl(rawSlug) && !looksLikeUrl(rawUrl)) {
    throw new UsageError("`instance add` takes the name first, then the URL", { hint: usage });
  }
  if (rawSlug === undefined || rawUrl === undefined) {
    throw new UsageError("`instance add` needs a name and a URL", { hint: usage });
  }
  const url = validateUrl(rawUrl);
  if (flag(ctx, "unprotected")) throw new UsageError("a new instance is unprotected unless --protected says otherwise");
  const added = addInstance(validateSlug(rawSlug), url, ctx.io.env, settingsOf(ctx));

  if (isJson(ctx)) {
    renderDocument(added, { format: ctx.format, write: ctx.io.out });
  } else {
    ctx.io.out(`added  ${describe(added)}\n`);
    ctx.io.err(`Use it with: signum -i ${added.slug} <command>\n`);
  }
  return ExitCode.Ok;
}

/** `--protected`, `--unprotected` and `--auth-header`, as `instance add` and `instance set` take them. */
function settingsOf(ctx: Ctx): ProfileSettings {
  const on = flag(ctx, "protected");
  const off = flag(ctx, "unprotected");
  if (on && off) throw new UsageError("choose one of --protected and --unprotected");
  const header = opt(ctx, "auth-header");
  return {
    ...(on ? { protected: true } : off ? { protected: false } : {}),
    ...(header !== undefined ? { authHeader: header.toLowerCase() === "default" ? null : validateHeaderName(header) } : {}),
  };
}

/** One profile on one line: name, URL, and what is not the default about it. */
function describe(i: Instance): string {
  const marks = [i.protected === true ? "protected" : "", i.authHeader !== undefined ? `token in ${i.authHeader}` : ""].filter((m) => m !== "");
  return `${i.slug}  ${i.url}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`;
}

/** `instance set <name>`: what a profile does, never where it points (remove and add for that). */
function set(ctx: Ctx): ExitCode {
  const slug = ctx.args.positionals[1];
  if (slug === undefined) {
    throw new UsageError("`instance set` needs a name", { hint: "signum instance set prod --protected" });
  }
  const settings = settingsOf(ctx);
  if (Object.keys(settings).length === 0) {
    throw new UsageError("`instance set` needs something to set", {
      hint: "--protected, --unprotected, or --auth-header <name> (default restores Authorization)",
    });
  }
  const updated = updateInstance(slug.toLowerCase(), settings, ctx.io.env);
  if (isJson(ctx)) renderDocument(updated, { format: ctx.format, write: ctx.io.out });
  else ctx.io.out(`set  ${describe(updated)}\n`);
  return ExitCode.Ok;
}

function list(ctx: Ctx): ExitCode {
  const all = listInstances(ctx.io.env);
  if (isJson(ctx)) {
    renderDocument(all, { format: ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }
  if (all.length === 0) {
    // Empty is the normal first state, not an error.
    ctx.io.err("no instances registered\n");
    ctx.io.err("Add one with: signum instance add <name> <url>\n");
    return ExitCode.Ok;
  }
  const w = Math.max(...all.map((i) => i.slug.length));
  for (const i of all) ctx.io.out(describe({ ...i, slug: i.slug.padEnd(w) }).trimEnd() + "\n");
  return ExitCode.Ok;
}

function remove(ctx: Ctx): ExitCode {
  const slug = ctx.args.positionals[1];
  if (slug === undefined) {
    throw new UsageError("`instance remove` needs a name", { hint: "signum instance remove renew" });
  }
  const removed = removeInstance(slug.toLowerCase(), ctx.io.env);
  if (removed === undefined) {
    throw new NotFoundError(`unknown instance '${slug}'`, { hint: "See `signum instance list`." });
  }
  if (isJson(ctx)) renderDocument(removed, { format: ctx.format, write: ctx.io.out });
  else ctx.io.out(`removed  ${removed.slug}  ${removed.url}\n`);
  // The stored credential is matched by URL, not by name, so it is deliberately left alone.
  return ExitCode.Ok;
}

function path(ctx: Ctx): ExitCode {
  // Explicit format only, as in `cache path`: a shell substitution wants the bare string.
  const explicit = ctx.args.flags.output;
  if (explicit === "json" || explicit === "ndjson") {
    renderDocument({ path: instancesPath(ctx.io.env) }, { format: explicit, write: ctx.io.out });
  } else {
    ctx.io.out(instancesPath(ctx.io.env) + "\n");
  }
  return ExitCode.Ok;
}

export function runInstance(ctx: Ctx): ExitCode {
  const sub = ctx.args.positionals[0]?.toLowerCase();
  switch (sub) {
    case "list":
    case undefined: // bare `signum instance` is the harmless, informative one
      return list(ctx);
    case "add": return add(ctx);
    case "set": return set(ctx);
    case "remove": return remove(ctx);
    case "path": return path(ctx);
    default:
      throw new UsageError(`unknown instance subcommand '${sub}'`, {
        hint: "Valid subcommands: add, set, list, remove, path.",
      });
  }
}
