/**
 * File discovery and safe text rewriting for `unmask --in` (#102).
 *
 * Separate from `commands/unmask.ts` so the decisions that are easy to get wrong — what counts as a
 * text file, where the output goes, whether the destination is about to be committed — are testable
 * without driving a command.
 *
 * Nothing here knows what a handle is. It walks paths and moves UTF-8 around; `core/privacy.ts` owns
 * the substitution. Keeping that split is what lets the substitution be a pure function.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { resolveHandlesInText } from "./privacy.ts";

/**
 * Above this, assume the file is not a document someone wants names in. Handle-bearing output is
 * generated markdown, CSV or JSON; an 8 MiB one is a data dump, and rewriting it is more likely to
 * be an accident than an intention.
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** How much of a file to inspect before deciding it is binary. */
const SNIFF_BYTES = 8192;

/**
 * A NUL byte in the first few KiB means binary, by the same rule `git diff` uses.
 *
 * Cheap and not perfect — UTF-16 text is rejected, which is correct here anyway: this module reads
 * and writes UTF-8 only, so touching UTF-16 would corrupt it. Refusing to guess beats mangling.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Why a discovered path was not processed. `undefined` means it was. */
export type SkipReason = "binary" | "too-large" | "symlink" | "unreadable" | "glob";

export interface Candidate {
  path: string;
  skip?: SkipReason;
  bytes?: Uint8Array;
}

export interface Discovery {
  files: Candidate[];
  /**
   * Every directory walked, deepest last. Needed because a handle can be in a FOLDER name, and
   * renaming those requires knowing about directories the file walk otherwise passes straight
   * through. Excludes the root itself: the caller named it, so renaming it out from under them
   * would change the meaning of the argument they passed.
   */
  dirs: string[];
}

/**
 * Basename glob supporting `*` and `?` only.
 *
 * Deliberately not a full glob implementation: `--glob` exists to say "just the markdown", and a
 * half-correct `**`/brace/negation dialect that disagrees with the shell's would be worse than an
 * obviously small one. Path separators are not matched — the pattern applies to the file name.
 */
export function matchesGlob(name: string, pattern: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${rx}$`).test(name);
}

/**
 * Everything under `root`, or `root` itself when it is a file.
 *
 * Symlinks are skipped, not followed — reported rather than ignored. Following one could write
 * outside the tree the caller named, and this command's whole risk is writing identities somewhere
 * unexpected. `lstatSync` throughout, so a link is never silently traversed.
 */
export function discover(root: string, glob: string | undefined): Discovery {
  const out: Candidate[] = [];
  const dirs: string[] = [];

  const visit = (path: string, isRoot: boolean): void => {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      out.push({ path, skip: "unreadable" });
      return;
    }

    if (st.isSymbolicLink()) {
      out.push({ path, skip: "symlink" });
      return;
    }

    if (st.isDirectory()) {
      if (!isRoot) dirs.push(path);
      let entries: string[];
      try {
        entries = readdirSync(path).sort();
      } catch {
        out.push({ path, skip: "unreadable" });
        return;
      }
      // `.git` is walked past deliberately: rewriting anything in there is never wanted, and
      // object files would be skipped as binary only after being read.
      for (const e of entries) {
        if (e === ".git" || e === "node_modules") continue;
        visit(join(path, e), false);
      }
      return;
    }

    if (!st.isFile()) return;

    // An explicitly-named file is honoured even if it fails the glob — the caller pointed at it, so
    // silently doing nothing would be the wrong reading of an unambiguous instruction.
    if (!isRoot && glob !== undefined && !matchesGlob(basename(path), glob)) {
      out.push({ path, skip: "glob" });
      return;
    }

    if (st.size > MAX_TEXT_BYTES) {
      out.push({ path, skip: "too-large" });
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      out.push({ path, skip: "unreadable" });
      return;
    }
    if (looksBinary(bytes)) {
      out.push({ path, skip: "binary" });
      return;
    }
    out.push({ path, bytes });
  };

  visit(resolve(root), true);
  return { files: out, dirs };
}

/**
 * Where the rewritten copy goes: `report.md` -> `report.local.md`.
 *
 * A sibling by default because the input is typically generated, tracked, and deliberately free of
 * identities — mutating it in place is a decision, not a default. The `.local.` infix is chosen so a
 * single `*.local.*` line in `.gitignore` covers every output this command can produce.
 */
export function siblingOutputPath(path: string): string {
  const ext = extname(path);
  const stem = ext === "" ? basename(path) : basename(path, ext);
  return join(dirname(path), `${stem}.local${ext}`);
}

/**
 * Resolve handles in a single path SEGMENT — a file or folder name.
 *
 * A handle can name a file or a folder (`docs/ref:cccccccccccc/report-ref:aaaaaaaaaaaa.md`), where
 * the path leaks identities even after the contents are clean. Worth knowing: this is effectively
 * POSIX-only. A handle contains `:`, which is reserved in Windows filenames, so such a name cannot
 * exist there in the first place — whereas the replacement `Type;id` is legal on both.
 *
 * Applied per segment, never to a whole path, and the result is REFUSED if it gained a separator.
 * A `Type;id` cannot contain one, so this is defence against a corrupted store rather than an
 * expected case — but the failure it prevents is writing outside the tree the caller named, which is
 * severe enough to check rather than reason about.
 */
export function resolveSegment(
  name: string,
  handles: Readonly<Record<string, string>>,
): { name: string; changed: boolean; unresolved: string[]; unsafe: boolean } {
  const r = resolveHandlesInText(name, handles);
  if (r.replaced === 0) return { name, changed: false, unresolved: r.unresolved, unsafe: false };
  const unsafe = r.text.includes("/") || r.text.includes("\\") || r.text === "." || r.text === "..";
  if (unsafe) return { name, changed: false, unresolved: r.unresolved, unsafe: true };
  return { name: r.text, changed: true, unresolved: r.unresolved, unsafe: false };
}

/**
 * Rewrite `path` with every segment BELOW `root` handle-resolved. `root` is left alone: the caller
 * named it, and renaming it would change the meaning of the argument they passed.
 */
export function resolvePathBelow(
  root: string,
  path: string,
  handles: Readonly<Record<string, string>>,
): { path: string; changed: boolean; unsafe: boolean } {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel.startsWith("..")) return { path, changed: false, unsafe: false };
  let changed = false;
  let unsafe = false;
  const parts = rel.split(sep).map((seg) => {
    const r = resolveSegment(seg, handles);
    if (r.changed) changed = true;
    if (r.unsafe) unsafe = true;
    return r.name;
  });
  return { path: join(resolve(root), ...parts), changed, unsafe };
}

/** Read the bytes a `Candidate` already loaded as UTF-8, explicitly and regardless of platform. */
export function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Write UTF-8, explicitly.
 *
 * The encoding argument is not decoration. The scripted version of this shelled out to the CLI and
 * decoded its stdout using the platform codepage, which on a German Windows console is cp1252 — so
 * every umlaut in every name came out as mojibake. Reading and writing UTF-8 in-process removes that
 * class of bug entirely rather than working around it.
 */
export function writeUtf8(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8" });
}

/**
 * Rename, refusing to clobber.
 *
 * `renameSync` overwrites an existing destination silently, and here the destination is derived from
 * a handle — so two different handles resolving to one identity, or a name that already exists, would
 * destroy a file. Returns false rather than throwing so one collision does not abandon the rest of
 * the run; the caller reports it.
 */
export function renameNoClobber(from: string, to: string): boolean {
  if (from === to) return true;
  try {
    lstatSync(to);
    return false; // destination exists — never overwrite
  } catch { /* does not exist, which is what we want */ }
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** The nearest ancestor containing `.git`, or undefined. `.git` may be a file (worktrees). */
export function gitRootOf(path: string): string | undefined {
  let dir = dirname(resolve(path));
  for (;;) {
    try {
      lstatSync(join(dir, ".git"));
      return dir;
    } catch { /* keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type IgnoreStatus = "ignored" | "not-ignored" | "unknown";

/**
 * Is `path` ignored by git?
 *
 * This is the first subprocess in `src/`, and the alternative was worse. Hand-rolling gitignore
 * semantics means reimplementing negations, precedence and nested `.gitignore` files, and a
 * half-correct answer here is actively harmful: telling someone their file is ignored when it is not
 * is precisely the failure this check exists to prevent. `git check-ignore` is the authority, and it
 * is present in any tree that has a `.git` to begin with.
 *
 * Returns "unknown" — never a guess — when git is missing or errors, and the caller warns on that as
 * if it were "not-ignored". Args are passed as an array, so a path is never parsed by a shell.
 */
export function checkIgnored(gitRoot: string, path: string): IgnoreStatus {
  try {
    const res = Bun.spawnSync({
      cmd: ["git", "check-ignore", "--quiet", "--no-index", resolve(path)],
      cwd: gitRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (res.exitCode === 0) return "ignored";
    if (res.exitCode === 1) return "not-ignored";
    return "unknown";
  } catch {
    return "unknown";
  }
}
