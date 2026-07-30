/**
 * `unmask --in` — resolving handles inside documents (#102).
 *
 * The handles let an agent write a report it cannot read. This is the other half: turning that
 * report into one a human can. Every consumer was otherwise writing the same grep-collect-substitute
 * script, and the substitution step has an ordering bug that is silent when you hit it.
 *
 * The properties worth testing are the ones the hand-rolled version got wrong: collision-safe
 * substitution, idempotency, UTF-8 regardless of platform codepage, unresolvable handles reported
 * rather than passed over, and the input not being mutated unless asked. Plus the gate, which matters
 * MORE here than for terminal output — a printed name is transient, a written one is durable.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../src/cli.ts";
import { saveHandles } from "../src/core/config.ts";
import { ExitCode } from "../src/core/errors.ts";
import { resolveHandlesInText } from "../src/core/privacy.ts";
import { matchesGlob, siblingOutputPath } from "../src/core/textfiles.ts";

let dir: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-unmask-cfg-"));
  work = mkdtempSync(join(tmpdir(), "signum-unmask-work-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

interface Result { code: ExitCode; out: string; err: string }

// Defaults to a TTY, because these assertions are about the HUMAN rendering. Without it every
// command renders JSON (AC-22.1) and prose assertions fail for a reason unrelated to what they test.
async function cli(argv: string[], extraEnv: Record<string, string> = {}, tty = true): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: tty,
    stdinIsTty: false,
    env: { SIGNUM_CONFIG_DIR: dir, ...extraEnv } as NodeJS.ProcessEnv,
    readStdin: async () => "",
  };
  try {
    const code = await run(argv, io);
    return { code, out, err };
  } catch (e) {
    const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

const env = () => ({ SIGNUM_CONFIG_DIR: dir }) as unknown as NodeJS.ProcessEnv;

function file(name: string, contents: string): string {
  const p = join(work, name);
  mkdirSync(join(p, "..") , { recursive: true });
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("substitution correctness (pure)", () => {
  it("is immune to handle-length collisions, which the scripted version was not", () => {
    // `ref:abc123abc123` is a prefix of `ref:abc123abc123ff`. A list-based replace corrupts the
    // longer one unless sorted longest-first; a single left-to-right pass cannot.
    const handles = {
      "ref:abc123abc123": "User;1",
      "ref:abc123abc123ff": "User;2",
    };
    const r = resolveHandlesInText("short ref:abc123abc123 long ref:abc123abc123ff", handles);
    expect(r.text).toBe("short User;1 long User;2");
    expect(r.replaced).toBe(2);
  });

  it("is idempotent — a second pass finds nothing to do", () => {
    const handles = { "ref:aaaaaaaaaaaa": "User;7" };
    const once = resolveHandlesInText("owner ref:aaaaaaaaaaaa", handles);
    const twice = resolveHandlesInText(once.text, handles);
    expect(once.text).toBe("owner User;7");
    expect(twice.text).toBe(once.text);
    expect(twice.replaced).toBe(0);
  });

  it("leaves an unresolvable handle byte-identical and reports it", () => {
    const r = resolveHandlesInText("a ref:deadbeefdead b", {});
    expect(r.text).toBe("a ref:deadbeefdead b");
    expect(r.replaced).toBe(0);
    expect(r.unresolved).toEqual(["ref:deadbeefdead"]);
  });

  it("reports each unresolvable handle once, in order of appearance", () => {
    const r = resolveHandlesInText("ref:bbbbbbbbbbbb ref:aaaaaaaaaaaa ref:bbbbbbbbbbbb", {});
    expect(r.unresolved).toEqual(["ref:bbbbbbbbbbbb", "ref:aaaaaaaaaaaa"]);
  });

  it("counts occurrences, not distinct handles", () => {
    const r = resolveHandlesInText("x ref:aaaaaaaaaaaa y ref:aaaaaaaaaaaa", { "ref:aaaaaaaaaaaa": "User;1" });
    expect(r.replaced).toBe(2);
  });

  it("never substitutes a token it is unsure of, even when a prefix would match", () => {
    // A longer hex run is NOT silently resolved to its 12-character prefix — the bias is to leave it
    // and say so, because a wrong identity is worse than an unresolved one.
    const r = resolveHandlesInText("ref:aaaaaaaaaaaabbbb", { "ref:aaaaaaaaaaaa": "User;1" });
    expect(r.text).toBe("ref:aaaaaaaaaaaabbbb");
    expect(r.unresolved).toEqual(["ref:aaaaaaaaaaaabbbb"]);
  });
});

describe("output paths and globs (pure)", () => {
  it("writes a .local. sibling, keeping the extension", () => {
    expect(siblingOutputPath("/a/b/report.md")).toBe("/a/b/report.local.md");
    expect(siblingOutputPath("/a/b/data.csv")).toBe("/a/b/data.local.csv");
  });

  it("handles a name with no extension", () => {
    expect(siblingOutputPath("/a/b/NOTES")).toBe("/a/b/NOTES.local");
  });

  it("chooses an infix a single .gitignore line can cover", () => {
    // `*.local.*` is the advice the warning gives, so the name must actually match it.
    expect(matchesGlob("report.local.md", "*.local.*")).toBe(true);
  });

  it("matches * and ? on the basename only", () => {
    expect(matchesGlob("a.md", "*.md")).toBe(true);
    expect(matchesGlob("a.txt", "*.md")).toBe(false);
    expect(matchesGlob("ab.md", "?.md")).toBe(false);
    expect(matchesGlob("a.md", "?.md")).toBe(true);
  });
});

describe("unmask --in", () => {
  it("resolves handles in a single file and writes a sibling (AC: no hand-written step)", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("report.md", "# Effort\n\nOwner: ref:aaaaaaaaaaaa — 12h\n");
    const r = await cli(["unmask", "--in", p]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(readFileSync(join(work, "report.local.md"), "utf8")).toContain("User;42");
    // AC: by default the input is NOT mutated.
    expect(readFileSync(p, "utf8")).toContain("ref:aaaaaaaaaaaa");
  });

  it("walks a folder recursively", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("a.md", "ref:aaaaaaaaaaaa");
    file("nested/b.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(readFileSync(join(work, "a.local.md"), "utf8")).toBe("User;42");
    expect(readFileSync(join(work, "nested/b.local.md"), "utf8")).toBe("User;42");
  });

  it("--in-place rewrites the input, and only when asked", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("report.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", p, "--in-place"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(readFileSync(p, "utf8")).toBe("User;42");
    expect(existsSync(join(work, "report.local.md"))).toBe(false);
  });

  it("--dry-run writes nothing and still reports the counts", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("report.md", "ref:aaaaaaaaaaaa and ref:ffffffffffff");
    const r = await cli(["unmask", "--in", p, "--dry-run"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(work, "report.local.md"))).toBe(false);
    expect(readFileSync(p, "utf8")).toContain("ref:aaaaaaaaaaaa");
    expect(r.out).toContain("1 resolved");
    expect(r.out).toContain("1 unresolvable");
    expect(r.err).toContain("dry run");
  });

  it("does not rewrite a file with no handles, so mtimes do not churn", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("clean.md", "nothing to see");
    const r = await cli(["unmask", "--in", work]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(work, "clean.local.md"))).toBe(false);
    expect(r.out).toContain("No handles found");
  });

  it("names the unresolvable handles rather than only counting them", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa ref:deadbeefdead");
    const r = await cli(["unmask", "--in", work]);
    expect(r.err).toContain("could not be resolved");
    expect(r.err).toContain("ref:deadbeefdead");
  });

  it("says an empty store is why nothing resolved, not that the files were clean", async () => {
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("no handles are stored");
  });

  it("tells the user where the real names went (AC)", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work]);
    expect(r.err).toContain("Real identities were written to:");
    expect(r.err).toContain("r.local.md");
  });

  it("reads and writes UTF-8 whatever the platform codepage is (AC)", async () => {
    // The scripted version decoded the CLI's stdout as cp1252 on a German Windows console and
    // produced mojibake in every name. In-process UTF-8 removes the class of bug.
    saveHandles({ "ref:aaaaaaaaaaaa": "Benutzer;7" }, env());
    const p = file("umlaut.md", "Träger: ref:aaaaaaaaaaaa — Grüße, Straße\n");
    const r = await cli(["unmask", "--in", p]);
    expect(r.code).toBe(ExitCode.Ok);
    const written = readFileSync(join(work, "umlaut.local.md"), "utf8");
    expect(written).toBe("Träger: Benutzer;7 — Grüße, Straße\n");
    // And byte-exact, not merely equal after some lossy round trip.
    expect(readFileSync(join(work, "umlaut.local.md"))).toEqual(Buffer.from(written, "utf8"));
  });

  it("is idempotent end to end — running twice does not double-substitute", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("r.md", "ref:aaaaaaaaaaaa");
    await cli(["unmask", "--in", p, "--in-place"]);
    const after = await cli(["unmask", "--in", p, "--in-place"]);
    expect(after.code).toBe(ExitCode.Ok);
    expect(readFileSync(p, "utf8")).toBe("User;42");
  });

  it("--glob narrows a folder walk", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("a.md", "ref:aaaaaaaaaaaa");
    file("b.txt", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work, "--glob", "*.md"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(work, "a.local.md"))).toBe(true);
    expect(existsSync(join(work, "b.local.txt"))).toBe(false);
  });

  it("honours an explicitly named file even if it fails the glob", async () => {
    // The caller pointed at it; silently doing nothing would misread an unambiguous instruction.
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("b.txt", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", p, "--glob", "*.md"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(work, "b.local.txt"))).toBe(true);
  });

  it("skips and reports a binary file rather than mangling it", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    writeFileSync(join(work, "blob.bin"), Buffer.from([0x72, 0x65, 0x66, 0x3a, 0x00, 0x01]));
    const r = await cli(["unmask", "--in", work]);
    expect(r.out).toContain("skipped (binary)");
    expect(existsSync(join(work, "blob.local.bin"))).toBe(false);
  });

  it("skips a symlink rather than following it out of the tree", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "ref:aaaaaaaaaaaa", "utf8");
    symlinkSync(outside, join(work, "link.md"));
    const r = await cli(["unmask", "--in", work]);
    expect(r.out).toContain("skipped (symlink)");
    expect(readFileSync(outside, "utf8")).toBe("ref:aaaaaaaaaaaa");
  });

  it("errors on a path that does not exist, rather than reporting a clean run over zero files", async () => {
    const r = await cli(["unmask", "--in", join(work, "nope.md")]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("does not exist");
  });

  it("errors when a folder is walked but --glob matches nothing", async () => {
    file("a.txt", "hello");
    const r = await cli(["unmask", "--in", work, "--glob", "*.md"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("matched no files");
  });

  it("refuses --in combined with --clear, instead of guessing which was meant", async () => {
    const r = await cli(["unmask", "--in", work, "--clear"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("cannot be combined");
  });

  it("refuses --in combined with handle arguments", async () => {
    const r = await cli(["unmask", "--in", work, "ref:aaaaaaaaaaaa"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("do not also pass them as arguments");
  });

  it("emits a stable -o json shape, so a wrapper need not parse prose", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa ref:deadbeefdead");
    const r = await cli(["unmask", "--in", work, "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as {
      mode: string; dryRun: boolean;
      files: Array<{ path: string; resolved: number; unresolvable: string[]; output: string | null }>;
      totals: { filesWritten: number; resolved: number; unresolvable: number };
      unresolvable: string[];
    };
    expect(doc.mode).toBe("in");
    expect(doc.totals.resolved).toBe(1);
    expect(doc.totals.filesWritten).toBe(1);
    expect(doc.unresolvable).toEqual(["ref:deadbeefdead"]);
    expect(doc.files[0]?.output).toContain("r.local.md");
  });
});

describe("the git footgun — names written into a tracked tree", () => {
  // The failure the issue names: a commit full of real names in a repo that deliberately held none.
  // `git check-ignore` is the authority; hand-rolling gitignore semantics would risk telling someone
  // their file is ignored when it is not, which is worse than not checking at all.

  function initRepo(): void {
    Bun.spawnSync({ cmd: ["git", "init", "--quiet"], cwd: work, stdout: "ignore", stderr: "ignore" });
  }

  it("warns when the output lands in a git work tree and is NOT ignored", async () => {
    initRepo();
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", join(work, "r.md")]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("NOT ignored by git");
    expect(r.err).toContain("r.local.md");
    // Actionable, and the advice actually covers the name this command produces.
    expect(r.err).toContain("*.local.*");
  });

  it("stays quiet when the output IS ignored", async () => {
    initRepo();
    writeFileSync(join(work, ".gitignore"), "*.local.*\n", "utf8");
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", join(work, "r.md")]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("NOT ignored by git");
    // The reader is still told where the names went — that is separate from the warning.
    expect(r.err).toContain("Real identities were written to:");
  });

  it("does not warn for a --dry-run, which writes nothing to warn about", async () => {
    initRepo();
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", join(work, "r.md"), "--dry-run"]);
    expect(r.err).not.toContain("NOT ignored by git");
  });

  it("does not warn outside a git work tree", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", join(work, "r.md")]);
    expect(r.err).not.toContain("NOT ignored by git");
  });

  it("exposes the same finding in --json, so a wrapper can gate a commit on it", async () => {
    initRepo();
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", join(work, "r.md"), "--json"], {}, false);
    const doc = JSON.parse(r.out) as { unignoredOutputs: Array<{ path: string; ignoreStatus: string }> };
    expect(doc.unignoredOutputs).toHaveLength(1);
    expect(doc.unignoredOutputs[0]?.ignoreStatus).toBe("not-ignored");
  });
});

describe("the human-only gate, for this mode specifically (AC)", () => {
  // Tested here rather than assumed to be inherited: writing a name to disk is durable in a way
  // printing one is not, so the gate matters MORE in this mode than in the one it was written for.

  it("refuses a detected AI caller and writes nothing", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", p], { CLAUDECODE: "1" });
    expect(r.code).toBe(ExitCode.Policy);
    expect(r.err).toContain("unmask is for a human");
    // The point of refusing before reading: no sibling, and the input untouched.
    expect(existsSync(join(work, "r.local.md"))).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("ref:aaaaaaaaaaaa");
  });

  it("refuses before writing even with --in-place, so the input survives", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", p, "--in-place"], { CLAUDECODE: "1" });
    expect(r.code).toBe(ExitCode.Policy);
    expect(readFileSync(p, "utf8")).toBe("ref:aaaaaaaaaaaa");
  });

  it("refuses a dry run too — the refusal is about the act, not the write", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", p, "--dry-run"], { CLAUDECODE: "1" });
    expect(r.code).toBe(ExitCode.Policy);
  });

  it("proceeds for a human who says so explicitly", async () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;42" }, env());
    const p = file("r.md", "ref:aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", p, "--i-understand-data-goes-to-a-model"], { CLAUDECODE: "1" });
    expect(r.code).toBe(ExitCode.Ok);
    expect(readFileSync(join(work, "r.local.md"), "utf8")).toBe("User;42");
  });
});
