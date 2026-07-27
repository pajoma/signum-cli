/**
 * `signum cache show|clear|path`
 *
 * STORY-24 · AC-24.3 ("the metadata cache is … explicitly clearable"), AC-24.4.
 *
 * The cache was previously invisible: filenames carry a non-reversible digest of the target URL,
 * so a user could neither tell what was cached nor get rid of it without deleting files by hand
 * from a directory they had to guess. That is a poor position for something the CLI silently
 * relies on for offline discovery and for pre-flight query validation.
 *
 * Cached reflection documents are METADATA — type and query names, member names, operation keys
 * — never row data, so this command is on the ungated output path (see core/policy.ts). It is
 * also purely local: nothing here touches the network, which is what makes it usable when
 * `--offline` is the only thing working.
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, UsageError } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import { cacheDir, clearMetadataCache, listMetadataCache, type CacheEntry } from "../core/config.ts";

/** Anonymous and authenticated documents differ — see the note on `cachePath`. */
function scope(entry: CacheEntry): string {
  return entry.authenticated ? "auth" : "anon";
}

function show(ctx: Ctx): ExitCode {
  const entries = listMetadataCache(ctx.io.env);

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(
      entries.map((e) => ({
        url: e.url,
        scope: scope(e),
        fetchedAt: e.fetchedAt,
        lastModified: e.lastModified ?? null,
        types: e.types,
        sizeBytes: e.sizeBytes,
        path: e.path,
      })),
      { format: ctx.format, write: ctx.io.out },
    );
    return ExitCode.Ok;
  }

  if (entries.length === 0) {
    // Empty is not an error: a fresh install has no cache, and that is the normal first state.
    ctx.io.err("no cached metadata\n");
    ctx.io.err(`Cache directory: ${cacheDir(ctx.io.env)}\n`);
    return ExitCode.Ok;
  }

  const w = Math.max(...entries.map((e) => e.url.length));
  for (const e of entries) {
    ctx.io.out(
      `${e.url.padEnd(w)}  ${scope(e).padEnd(4)}  fetched ${e.fetchedAt}  ${e.types} types\n`,
    );
  }
  ctx.io.err(
    "\nanon and auth are separate documents: reflection answers depend on who is asking,\n" +
    "so a document fetched before login reports nothing as queryable.\n",
  );
  return ExitCode.Ok;
}

function clear(ctx: Ctx): ExitCode {
  // Scoping to --url is the only filter offered; a target is the unit a user thinks in.
  const url = ctx.args.flags.url;
  const removed = clearMetadataCache(url, ctx.io.env);

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(
      { cleared: removed.length, url: url ?? null, entries: removed.map((e) => ({ url: e.url, scope: scope(e) })) },
      { format: ctx.format, write: ctx.io.out },
    );
    return ExitCode.Ok;
  }

  if (removed.length === 0) {
    ctx.io.err(url === undefined ? "no cached metadata to clear\n" : `no cached metadata for ${url}\n`);
    return ExitCode.Ok;
  }
  // Report what actually went, not a count the command assumed.
  for (const e of removed) ctx.io.out(`removed  ${e.url}  (${scope(e)})\n`);
  return ExitCode.Ok;
}

function path(ctx: Ctx): ExitCode {
  const dir = cacheDir(ctx.io.env);

  // Branch on the EXPLICIT format, not the resolved one. Everywhere else, "not a TTY" means
  // "a machine is reading, emit JSON" — but the machine reading this is a shell doing
  // `ls "$(signum cache path)"`, which is never a TTY and wants the bare string. Resolving to
  // JSON by default would make the command useless in precisely its intended use. Asking for
  // --json explicitly still gets a document. (Same reasoning as `get` treating a defaulted
  // `table` as "not a user request".)
  const explicit = ctx.args.flags.output;
  if (explicit === "json" || explicit === "ndjson") {
    renderDocument({ cacheDir: dir }, { format: explicit, write: ctx.io.out });
    return ExitCode.Ok;
  }
  ctx.io.out(dir + "\n");
  return ExitCode.Ok;
}

export function runCache(ctx: Ctx): ExitCode {
  const sub = ctx.args.positionals[0]?.toLowerCase();
  switch (sub) {
    case "show":
    case undefined: // bare `signum cache` is the harmless, informative one
      return show(ctx);
    case "clear": return clear(ctx);
    case "path":  return path(ctx);
    default:
      throw new UsageError(`unknown cache subcommand '${sub}'`, {
        hint: "Valid subcommands: show, clear, path.",
      });
  }
}
