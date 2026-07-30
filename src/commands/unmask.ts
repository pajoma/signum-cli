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
  checkIgnored, decodeUtf8, discover, gitRootOf, renameNoClobber, resolvePathBelow, resolveSegment,
  siblingOutputPath, writeUtf8, type Candidate, type IgnoreStatus, type SkipReason,
} from "../core/textfiles.ts";
import { flag, opt, optAll } from "./context.ts";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";

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
  /** True when the output path differs from the input path because a handle was in the NAME. */
  renamed?: boolean;
  /** A rename that could not be done: the destination already existed, or the name was unsafe. */
  renameBlocked?: "exists" | "unsafe";
}

/** A directory whose own name carries a handle. Its path leaks even when every file is clean. */
interface DirResult {
  path: string;
  output: string;
  blocked?: "exists" | "unsafe";
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

  // Each input is kept beside its own walk, because a resolved output path is computed RELATIVE to
  // the root the caller named — that root is never renamed, so `--in docs` cannot move `docs`.
  const walks = inputs.map((input) => ({ root: resolvePath(input), ...discover(input, glob) }));
  const candidates: Candidate[] = walks.flatMap((w) => w.files);
  const rootOf = new Map<string, string>();
  for (const w of walks) for (const f of w.files) rootOf.set(f.path, w.root);
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
    const root = rootOf.get(c.path) ?? c.path;
    // The PATH is resolved regardless of what the contents hold: a handle in a file or folder name
    // leaks an identity even when every byte inside is clean.
    const asPath = resolvePathBelow(root, c.path, handles);

    if (c.skip !== undefined) {
      // A glob miss is not interesting enough to report per file — it is the flag doing its job.
      if (c.skip === "glob") continue;
      // A skipped file is never copied or rewritten, but its NAME is still reported when it carries
      // a handle — otherwise `--in` would silently leave an identity in the tree it was asked to
      // clean. Renaming one is possible without reading it, so --in-place still does it below.
      results.push({
        path: c.path, resolved: 0, unresolvable: [], output: null, skip: c.skip,
        ...(asPath.changed ? { renamed: true } : {}),
        ...(asPath.unsafe ? { renameBlocked: "unsafe" as const } : {}),
      });
      continue;
    }

    const original = decodeUtf8(c.bytes as Uint8Array);
    const { text, replaced, unresolved } = resolveHandlesInText(original, handles);

    // Nothing to do at all: contents clean AND path clean. Do not write. Rewriting an identical file
    // churns mtimes and makes every walked file look touched, which matters under version control.
    if (replaced === 0 && !asPath.changed) {
      results.push({ path: c.path, resolved: 0, unresolvable: unresolved, output: null });
      continue;
    }

    // In place, the file keeps its path here and is renamed in the pass below — renaming now would
    // invalidate the directory renames that follow. Otherwise the sibling goes at the RESOLVED path,
    // so the copy carries no handle in its own name or in any folder above it.
    const output = inPlace ? c.path : siblingOutputPath(asPath.path);
    if (!dryRun) writeUtf8(output, replaced > 0 ? text : original);
    results.push({
      path: c.path, resolved: replaced, unresolvable: unresolved, output,
      ...(asPath.changed ? { renamed: true } : {}),
      ...(asPath.unsafe ? { renameBlocked: "unsafe" as const } : {}),
    });
  }

  /**
   * `--in-place` renames, deepest path first.
   *
   * Order is the whole difficulty: renaming `a/ref:x/` before `a/ref:x/ref:y.md` invalidates the
   * child's path and the second rename fails on a path that no longer exists. Sorting by depth
   * descending means every child is moved while its parent still has the name it was discovered
   * under.
   */
  const dirResults: DirResult[] = [];
  if (inPlace) {
    // Only the LAST segment is renamed at each step, never the fully-resolved path: with
    // deepest-first ordering the parent still has its original name, so a fully-resolved target
    // would point into a directory that does not exist yet — and `mkdir -p` would then split the
    // tree in two instead of moving anything.
    const renameLeaf = (path: string): { to: string; unsafe: boolean } => {
      const r = resolveSegment(basename(path), handles);
      return { to: join(dirname(path), r.name), unsafe: r.unsafe };
    };
    const deepestFirst = (a: string, b: string): number => b.split(sep).length - a.split(sep).length;

    // Files before directories, for the same reason: a file is moved while its parent is still
    // discoverable under the name it was found with.
    for (const r of [...results].sort((x, y) => deepestFirst(x.path, y.path))) {
      if (r.renamed !== true || r.renameBlocked !== undefined) continue;
      const { to } = renameLeaf(r.path);
      if (dryRun) { r.output = to; continue; }
      if (renameNoClobber(r.path, to)) r.output = to;
      else r.renameBlocked = "exists";
    }

    const dirs = walks.flatMap((w) => w.dirs.map((d) => ({ root: w.root, path: d })));
    for (const d of [...dirs].sort((x, y) => deepestFirst(x.path, y.path))) {
      const { to, unsafe } = renameLeaf(d.path);
      if (unsafe) { dirResults.push({ path: d.path, output: d.path, blocked: "unsafe" }); continue; }
      if (to === d.path) continue; // no handle in this folder's name
      if (dryRun) { dirResults.push({ path: d.path, output: to }); continue; }
      if (renameNoClobber(d.path, to)) dirResults.push({ path: d.path, output: to });
      else dirResults.push({ path: d.path, output: to, blocked: "exists" });
    }

    /**
     * Reconcile every reported path against where things ACTUALLY ended up.
     *
     * Renaming leaf-by-leaf deepest-first is correct on disk but leaves the recorded paths stale: a
     * file was moved while its parent still had a handle in its name, and the parent moved
     * afterwards. Reporting the intermediate path names a location that no longer exists — caught by
     * running the binary, where the summary and the git warning both pointed at paths `find` could
     * not see.
     *
     * The fully-resolved path is the answer, but it is only claimed when it is TRUE: `existsSync`
     * decides, so a blocked rename anywhere in the chain leaves the report at the honest
     * intermediate value rather than an optimistic one.
     */
    const settle = (root: string, path: string): string => {
      const resolved = resolvePathBelow(root, path, handles).path;
      if (resolved === path) return path;
      if (dryRun) return resolved; // nothing moved, so this is the truthful prediction
      return existsSync(resolved) ? resolved : path;
    };
    for (const r of results) {
      if (r.output === null) continue;
      r.output = settle(rootOf.get(r.path) ?? r.path, r.output);
    }
    for (const d of dirResults) {
      if (d.blocked !== undefined) continue;
      // Separator-aware, NOT a bare string prefix: `--in /x/docs --in /x/docs2` would otherwise
      // match a path under `docs2` against the `docs` root and settle it relative to the wrong one.
      const root = walks.find((w) => d.path === w.root || d.path.startsWith(w.root + sep))?.root ?? d.path;
      d.output = settle(root, d.output);
    }
  }

  const written = results.filter((r) => r.output !== null);
  const totalResolved = results.reduce((n, r) => n + r.resolved, 0);
  const unresolvable = [...new Set(results.flatMap((r) => r.unresolvable))];

  // Where the names went — an acceptance point in its own right, and the thing a reader needs most.
  // Renamed directories are included: a folder called `Project;7` publishes an identity in the path
  // whatever its contents say, and `*.local.*` does not cover a directory name.
  const destinations = [...new Set([
    ...written.map((r) => r.output as string),
    ...dirResults.filter((d) => d.blocked === undefined).map((d) => d.output),
  ])];
  // Grouped by repository so `git check-ignore` runs once per repo rather than once per file: the
  // reported workflow is ~25 generated reports, and a folder walk can be far larger.
  const byRepo = new Map<string, string[]>();
  if (!dryRun) {
    for (const p of destinations) {
      const root = gitRootOf(p);
      if (root === undefined) continue; // not in a work tree, so nothing to warn about
      byRepo.set(root, [...(byRepo.get(root) ?? []), p]);
    }
  }
  const risky: Array<{ path: string; root: string; status: IgnoreStatus }> = [];
  for (const [root, paths] of byRepo) {
    const statuses = checkIgnored(root, paths);
    for (const p of paths) {
      const status = statuses.get(resolvePath(p)) ?? "unknown";
      if (status !== "ignored") risky.push({ path: p, root, status });
    }
  }

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
          // A handle was in the file's own NAME, not only its contents.
          renamed: r.renamed === true,
          renameBlocked: r.renameBlocked ?? null,
        })),
        directories: dirResults.map((d) => ({
          path: d.path, output: d.output, blocked: d.blocked ?? null,
        })),
        totals: {
          filesMatched: results.length,
          filesWritten: written.length,
          resolved: totalResolved,
          unresolvable: unresolvable.length,
          pathsRenamed: results.filter((r) => r.renamed === true && r.renameBlocked === undefined).length
            + dirResults.filter((d) => d.blocked === undefined).length,
        },
        unresolvable,
        // Machine-readable form of the warning below, so a wrapper can gate a commit on it.
        unignoredOutputs: risky.map((d) => ({ path: d.path, gitRoot: d.root, ignoreStatus: d.status })),
      },
      { format: ctx.format, write: ctx.openData("re-identified documents") },
    );
    return ExitCode.Ok;
  }

  const shown = results.filter(
    (r) => r.skip !== undefined || r.resolved > 0 || r.unresolvable.length > 0 || r.renamed === true,
  );
  const w = shown.length === 0 ? 0 : Math.max(...shown.map((r) => rel(r.path).length));
  for (const r of shown) {
    if (r.skip !== undefined) {
      // A skipped file whose NAME carries a handle still has to be surfaced, or `--in` would leave an
      // identity in a tree it reported as handled.
      const nameNote = r.renamed === true
        ? r.output !== null
          ? `, name resolved — ${dryRun ? "would rename to" : "renamed to"} ${rel(r.output)}`
          : r.renameBlocked === "exists"
            ? ", name carries a handle — NOT renamed, destination exists"
            : ", name carries a handle — run with --in-place to rename it"
        : "";
      ctx.io.out(`${rel(r.path).padEnd(w)}  skipped (${r.skip})${nameNote}\n`);
      continue;
    }
    const bits = [`${r.resolved} resolved`];
    if (r.unresolvable.length > 0) bits.push(`${r.unresolvable.length} unresolvable`);
    if (r.renamed === true) bits.push("name resolved");
    if (r.renameBlocked === "exists") bits.push("NOT renamed: destination exists");
    const dest = r.output === null ? "nothing written" : `${dryRun ? "would write" : "wrote"} ${rel(r.output)}`;
    ctx.io.out(`${rel(r.path).padEnd(w)}  ${bits.join(", ")}  —  ${dest}\n`);
  }
  if (shown.length === 0) ctx.io.out(`No handles found in ${results.length} file(s).\n`);

  if (dirResults.length > 0) {
    ctx.io.out("\nFOLDERS\n");
    for (const d of dirResults) {
      if (d.blocked === "exists") {
        ctx.io.out(`  ${rel(d.path)}  NOT renamed: ${rel(d.output)} already exists\n`);
      } else if (d.blocked === "unsafe") {
        ctx.io.out(`  ${rel(d.path)}  NOT renamed: the resolved name is not a safe path segment\n`);
      } else {
        ctx.io.out(`  ${rel(d.path)}  ${dryRun ? "would become" : "became"} ${rel(d.output)}\n`);
      }
    }
  }

  // A handle in a name that only --in-place can fix has to be said in the summary too. Reporting it
  // per file is not enough when the run touched many: the whole point of --in is not having to audit
  // the tree by hand afterwards.
  // Counted over files that actually got a copy. A skipped file with a handle in its name has no
  // copy at all, so folding it into this number would claim a resolved name that does not exist —
  // its own line already says --in-place is what would fix it.
  const nameOnly = results.filter((r) => r.renamed === true && !inPlace && r.output !== null);
  if (nameOnly.length > 0) {
    ctx.io.err(
      `\nnote: ${nameOnly.length} path(s) carried a handle in the NAME. The copies written above have ` +
      "resolved names,\nbut the originals keep theirs — `--in-place` renames them instead.\n",
    );
  }

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
