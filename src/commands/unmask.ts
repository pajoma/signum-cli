/**
 * `signum unmask <ref:…> [<ref:…> …]` · `--list` · `--clear`
 *
 * REQ-058 (#52) · STORY-53 · AC-53.4, AC-53.6.
 *
 * Resolves local `ref:` handles back to the records they stand for, so a **human** can audit what an
 * agent read or acted on.
 *
 * This is the one command whose entire output is real identity data, so it is the one place that
 * needs a check of its own rather than leaning on the shared gate. Since REQ-057 landed, a detected
 * agent passes `openData` whenever pseudonymization is active — which is right for pseudonymized
 * rows and exactly wrong here, because resolving a handle is the act of *removing* the protection.
 * So it refuses an agent outright unless the human-typed acknowledgement is present.
 *
 * Nothing here touches the network. The mapping is local by construction — that is the point of
 * REQ-058 rather than a server-side lookup: the surrogate→real relationship never leaves the machine.
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, PolicyError, UsageError } from "../core/errors.ts";
import { renderDataDocument } from "../core/output.ts";
import { clearHandles, handlesPath, loadHandles } from "../core/config.ts";
import { HANDLE_PREFIX, isHandle, resolveHandle, resolveHandlesInText } from "../core/privacy.ts";
import {
  checkIgnored, decodeUtf8, discover, gitRootOf, siblingOutputPath, writeUtf8,
  type Candidate, type SkipReason,
} from "../core/textfiles.ts";
import { flag, opt, optAll } from "./context.ts";
import { existsSync } from "node:fs";
import { relative } from "node:path";

/** AC-53.4: a human resolves handles, not the agent whose protection they are. */
function assertHuman(ctx: Ctx): void {
  if (ctx.caller.context !== "agent" || ctx.args.flags.allowAgentData) return;
  throw new PolicyError("unmask is for a human, not a detected AI caller", {
    hint:
      "Signals: " + ctx.caller.signals.join("; ") + ".\n" +
      "Resolving a handle removes the protection the handle exists to provide, so it is not the\n" +
      "caller's to do. Run it yourself in a terminal, or pass\n" +
      "  --i-understand-data-goes-to-a-model\n" +
      "if you are the human and you meant it.",
  });
}

/** One file's outcome, shared by the human and JSON renderings so they cannot diverge. */
interface FileResult {
  path: string;
  resolved: number;
  unresolvable: string[];
  /** Where the rewritten text went, or null when nothing was written. */
  output: string | null;
  skip?: SkipReason;
}

/**
 * `unmask --in <path>` — resolve handles inside files (#102).
 *
 * The handles exist so an agent can produce a document it cannot read. The missing half was turning
 * that document back into one a human can: without this, every consumer writes the same ~150 lines
 * of grep-collect-shell-substitute, and gets the substitution ordering subtly wrong.
 *
 * This mode is MORE dangerous than resolving a handle to a terminal, not less. A printed name is
 * transient; a name written into a file is durable, and the likely destination is a git working tree
 * that deliberately contained none. Hence the git check below, and hence the sibling-file default.
 */
async function unmaskFiles(ctx: Ctx, inputs: readonly string[]): Promise<ExitCode> {
  // Before any file is read, let alone written. `assertHuman` is the strict unmask-specific gate;
  // `openData` is the shared one, called for the accounting even though the identities here go to
  // disk rather than through its writer.
  assertHuman(ctx);
  ctx.openData("re-identified documents");

  const dryRun = flag(ctx, "dry-run");
  const inPlace = flag(ctx, "in-place");
  const glob = opt(ctx, "glob");
  const handles = loadHandles(ctx.io.env);

  if (Object.keys(handles).length === 0) {
    // Distinguishable from "no handles in the files". Both leave the text untouched, and conflating
    // them is how someone concludes the documents were clean when the store was simply empty.
    ctx.io.err(
      "note: no handles are stored, so nothing in these files can resolve.\n" +
      `Store: ${handlesPath(ctx.io.env)} — a \`ref:\` is only valid for the profile and secret that minted it.\n`,
    );
  }

  // A path that does not exist is a mistake, not an empty result. Reporting it as a skipped
  // "unreadable" file among the others would let a typo look like a clean run over zero matches.
  const missing = inputs.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new UsageError(`--in path does not exist: ${missing.join(", ")}`, {
      hint: "Pass a file or a folder. A folder is walked recursively; --glob '*.md' narrows it.",
    });
  }

  const candidates: Candidate[] = inputs.flatMap((input) => discover(input, glob));
  if (candidates.length === 0) {
    throw new UsageError(`--in matched no files: ${inputs.join(", ")}`, {
      hint: "The folder is empty, or contains only entries that cannot be walked.",
    });
  }
  // A --glob that excludes everything is a wrong pattern, not a clean run over zero files. Skipped
  // binaries and symlinks are reported per file so they stay visible; a glob miss is not, which is
  // exactly why the all-excluded case has to be said out loud.
  if (glob !== undefined && candidates.every((c) => c.skip === "glob")) {
    throw new UsageError(`--glob '${glob}' matched no files under ${inputs.join(", ")}`, {
      hint: `${candidates.length} file(s) were walked and none matched. The pattern applies to the file NAME and supports only * and ?.`,
    });
  }

  const results: FileResult[] = [];
  for (const c of candidates) {
    if (c.skip !== undefined) {
      // A glob miss is not interesting enough to report per file — it is the flag doing its job.
      if (c.skip !== "glob") results.push({ path: c.path, resolved: 0, unresolvable: [], output: null, skip: c.skip });
      continue;
    }
    const original = decodeUtf8(c.bytes as Uint8Array);
    const { text, replaced, unresolved } = resolveHandlesInText(original, handles);

    // Nothing changed: do not write. Rewriting an identical file churns mtimes and makes every
    // walked file look touched, which matters when the tree is under version control.
    if (replaced === 0) {
      results.push({ path: c.path, resolved: 0, unresolvable: unresolved, output: null });
      continue;
    }

    const output = inPlace ? c.path : siblingOutputPath(c.path);
    if (!dryRun) writeUtf8(output, text);
    results.push({ path: c.path, resolved: replaced, unresolvable: unresolved, output });
  }

  const written = results.filter((r) => r.output !== null);
  const totalResolved = results.reduce((n, r) => n + r.resolved, 0);
  const unresolvable = [...new Set(results.flatMap((r) => r.unresolvable))];

  // Where the names went — an acceptance point in its own right, and the thing a reader needs most.
  const destinations = [...new Set(written.map((r) => r.output as string))];
  const risky = dryRun ? [] : destinations.map((p) => {
    const root = gitRootOf(p);
    return { path: p, root, status: root === undefined ? "ignored" as const : checkIgnored(root, p) };
  }).filter((d) => d.root !== undefined && d.status !== "ignored");

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDataDocument(
      {
        mode: "in",
        dryRun,
        inPlace,
        files: results.map((r) => ({
          path: r.path,
          resolved: r.resolved,
          unresolvable: r.unresolvable,
          output: r.output,
          skipped: r.skip ?? null,
        })),
        totals: {
          filesMatched: results.length,
          filesWritten: written.length,
          resolved: totalResolved,
          unresolvable: unresolvable.length,
        },
        unresolvable,
        // Machine-readable form of the warning below, so a wrapper can gate a commit on it.
        unignoredOutputs: risky.map((d) => ({ path: d.path, gitRoot: d.root, ignoreStatus: d.status })),
      },
      { format: ctx.format, write: ctx.openData("re-identified documents") },
    );
    return ExitCode.Ok;
  }

  const shown = results.filter((r) => r.skip !== undefined || r.resolved > 0 || r.unresolvable.length > 0);
  const w = shown.length === 0 ? 0 : Math.max(...shown.map((r) => rel(r.path).length));
  for (const r of shown) {
    if (r.skip !== undefined) {
      ctx.io.out(`${rel(r.path).padEnd(w)}  skipped (${r.skip})\n`);
      continue;
    }
    const bits = [`${r.resolved} resolved`];
    if (r.unresolvable.length > 0) bits.push(`${r.unresolvable.length} unresolvable`);
    const dest = r.output === null ? "nothing written" : `${dryRun ? "would write" : "wrote"} ${rel(r.output)}`;
    ctx.io.out(`${rel(r.path).padEnd(w)}  ${bits.join(", ")}  —  ${dest}\n`);
  }
  if (shown.length === 0) ctx.io.out(`No handles found in ${results.length} file(s).\n`);

  ctx.io.err(
    `\n${totalResolved} handle occurrence(s) resolved across ${written.length} of ${results.length} file(s)` +
    `${dryRun ? " (dry run — nothing written)" : ""}.\n`,
  );

  if (unresolvable.length > 0) {
    // Named, not just counted: which handles failed is what tells you whether you are on the wrong
    // profile or simply ran --clear. The tokens themselves reveal nothing.
    ctx.io.err(
      `\n${unresolvable.length} handle(s) could not be resolved and were left exactly as they were:\n` +
      `  ${unresolvable.slice(0, 10).join(", ")}${unresolvable.length > 10 ? ", …" : ""}\n` +
      "A handle is only valid for the profile and surrogate secret that minted it, so one from\n" +
      "another profile or from before `unmask --clear` is gone for good.\n",
    );
  }

  if (!dryRun && destinations.length > 0) {
    ctx.io.err(`\nReal identities were written to:\n${destinations.map((p) => "  " + rel(p)).join("\n")}\n`);
  }

  if (risky.length > 0) {
    ctx.io.err(
      "\nWARNING: the following now contain real identities and are NOT ignored by git:\n" +
      risky.map((d) => `  ${rel(d.path)}${d.status === "unknown" ? "  (could not ask git — treat as not ignored)" : ""}`).join("\n") +
      `\nGit work tree: ${risky[0]?.root ?? "?"}\n` +
      "Committing them would put names into a repository that deliberately held none. Add a line\n" +
      "like `*.local.*` to .gitignore, or move the files out of the tree.\n",
    );
  }

  return ExitCode.Ok;
}

/** Paths relative to cwd where that is shorter — absolute paths bury the interesting part. */
function rel(path: string): string {
  const r = relative(process.cwd(), path);
  return r !== "" && !r.startsWith("..") && r.length < path.length ? r : path;
}

export async function runUnmask(ctx: Ctx): Promise<ExitCode> {
  const inputs = optAll(ctx, "in");
  if (inputs.length > 0) {
    // Mutually exclusive by construction rather than by precedence: `--in` with `--clear` could only
    // mean one of two very different things, and guessing which is how a caller loses a handle store.
    for (const other of ["clear", "list"]) {
      if (flag(ctx, other)) {
        throw new UsageError(`--in cannot be combined with --${other}`, { hint: "Run them separately." });
      }
    }
    if (ctx.args.positionals.length > 0) {
      throw new UsageError("--in takes the handles from the files; do not also pass them as arguments", {
        hint: `signum unmask --in docs/\nsignum unmask ${HANDLE_PREFIX}7f3a1c2b4d5e`,
      });
    }
    return await unmaskFiles(ctx, inputs);
  }

  if (flag(ctx, "clear")) {
    // Lifetime, made explicit (AC-53.6): clearing is how a handle expires, and it is irreversible —
    // every outstanding handle stops resolving, which `resolveHandle` then reports honestly.
    //
    // Which is exactly why it asks first. REQ-046's destructive-action guard is scoped to server
    // mutations and is m2, but the principle does not care where the data lives: this permanently
    // orphans every handle, and it used to do so on a bare `--clear` with no confirmation at all.
    // Non-interactively it proceeds — a script asked for it, and prompting would hang (STORY-09).
    const stored = Object.keys(loadHandles(ctx.io.env)).length;
    if (stored > 0 && !flag(ctx, "yes") && ctx.io.prompt !== undefined && ctx.io.stdoutIsTty) {
      const answer = await ctx.io.prompt(
        `Forget ${stored} handle${stored === 1 ? "" : "s"}? Every outstanding ref: stops resolving. [y/N] `,
      );
      if (!/^y(es)?$/i.test(answer.trim())) {
        ctx.io.err("Left untouched.\n");
        return ExitCode.Ok;
      }
    }

    const removed = clearHandles(ctx.io.env);
    ctx.io.out(removed ? "Handle mapping removed.\n" : "No handle mapping stored.\n");
    if (removed) {
      ctx.io.err("Every outstanding ref: handle is now unresolvable. Re-run a query to mint fresh ones.\n");
    }
    return ExitCode.Ok;
  }

  const handles = loadHandles(ctx.io.env);

  if (flag(ctx, "list")) {
    // Counting is not revealing: it says how many handles exist, never what they mean (AC-53.3).
    const count = Object.keys(handles).length;
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDataDocument({ count, path: handlesPath(ctx.io.env) }, { format: ctx.format, write: ctx.openData("handle count") });
      return ExitCode.Ok;
    }
    ctx.io.out(`${count} handle${count === 1 ? "" : "s"} stored\n`);
    ctx.io.err(`${handlesPath(ctx.io.env)}\n`);
    return ExitCode.Ok;
  }

  const refs = ctx.args.positionals;
  if (refs.length === 0) {
    throw new UsageError("`unmask` needs at least one ref: handle", {
      hint:
        `signum unmask ${HANDLE_PREFIX}7f3a1c2b4d5e\n` +
        "signum unmask --list     how many are stored\n" +
        "signum unmask --clear    forget them all",
    });
  }

  // Everything below emits real identities.
  assertHuman(ctx);

  const bad = refs.filter((r) => !isHandle(r));
  if (bad.length > 0) {
    throw new UsageError(`not a handle: ${bad.join(", ")}`, {
      hint: `A handle starts with '${HANDLE_PREFIX}'. Lite keys are already readable — there is nothing to resolve.`,
    });
  }

  // Resolve all of them before emitting anything, so a partial answer never looks complete.
  const resolved = refs.map((ref) => ({ ref, entity: resolveHandle(ref, handles) }));

  const out = ctx.openData("re-identified records");
  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDataDocument(resolved, { format: ctx.format, write: out });
  } else {
    const w = Math.max(...resolved.map((r) => r.ref.length));
    for (const r of resolved) out(`${r.ref.padEnd(w)}  ${r.entity}\n`);
  }
  return ExitCode.Ok;
}
