/**
 * First-contact behaviour — findings from the usability audit, 2026-07-28.
 *
 * Every case here was a real transcript from driving the compiled binary as a newcomer. The pattern
 * they shared: the CLI was well-built for someone who already knew it, and rough for the first ten
 * minutes. These lock the fixes so the first ten minutes stay fixed.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../src/cli.ts";
import { ExitCode } from "../src/core/errors.ts";

interface Result { code: ExitCode; out: string; err: string }

async function cli(
  argv: string[],
  opts: { env?: Record<string, string>; tty?: boolean; stdinTty?: boolean; answers?: string[] } = {},
): Promise<Result> {
  let out = "", err = "";
  const answers = [...(opts.answers ?? [])];
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: opts.tty === true,
    stdinIsTty: opts.stdinTty ?? true,
    env: { SIGNUM_CONFIG_DIR: "/nonexistent-usability", ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    readStdin: async () => "",
    ...(opts.answers !== undefined
      ? { prompt: async () => answers.shift() ?? "" }
      : {}),
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

describe("--version, which is the first thing anyone types", () => {
  it("prints the version rather than silently printing help", async () => {
    // It used to fall through to the overview and exit 0 — indistinguishable from working.
    const r = await cli(["--version"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { cli: string };
    expect(doc.cli).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.out).not.toContain("USAGE");
  });

  it("is the same code path as the command, so the two cannot drift", async () => {
    const a = await cli(["--version"]);
    const b = await cli(["version"]);
    expect(a.out).toBe(b.out);
  });
});

describe("a mistyped command is treated as a typo, not a lecture", () => {
  for (const [typo, meant] of [["typs", "types"], ["quer", "query"], ["querie", "queries"]]) {
    it(`suggests '${meant}' for '${typo}'`, async () => {
      const r = await cli([typo as string]);
      expect(r.code).toBe(ExitCode.Usage);
      expect(r.err).toContain(`Did you mean \`signum ${meant}\``);
      // The old behaviour explained m2 operation keys to someone who had mistyped.
      expect(r.err).not.toContain("m1 is read-only");
    });
  }

  it("names the new command when an old one is typed — a rename is not a typo", async () => {
    // No edit distance connects `de-pseudonymize` to `unmask`, so suggestion machinery cannot help.
    const r = await cli(["de-pseudonymize", "--list"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("was renamed to 'unmask'");
    expect(r.err).not.toContain("m1 is read-only");
  });

  it("still reports a genuine verb-noun attempt as the m2 feature it is", async () => {
    // `ship` is nothing like a built-in, so it really does look like an operation.
    const r = await cli(["ship", "order"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("m1 is read-only");
  });
});

describe("local mistakes are reported before environment ones", () => {
  it("diagnoses --top before complaining about a missing target", async () => {
    // `--top abc` is wrong whatever the server says, but it used to be masked first by "no target
    // application" and then by "no credential" — two unrelated fixes before the real answer.
    const r = await cli(["query", "Order", "--top", "abc"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--top must be a positive integer");
    expect(r.err).not.toContain("no target application");
  });

  it("diagnoses --page the same way", async () => {
    const r = await cli(["query", "Order", "--page", "0"]);
    expect(r.err).toContain("--page must be a positive integer");
  });

  it("still reports a missing target when the command itself is fine", async () => {
    const r = await cli(["query", "Order", "--top", "5"]);
    expect(r.err).toContain("no target application");
  });
});

describe("help topics are discoverable without making a mistake", () => {
  it("lists them in the overview", async () => {
    const r = await cli([]);
    expect(r.out).toContain("HELP TOPICS");
    for (const t of ["filter", "tokens", "exit-codes", "pseudonymization"]) {
      expect(r.out, t).toContain(t);
    }
  });

  it("lists them in sorted order, not object-insertion order", async () => {
    const r = await cli([]);
    const line = r.out.split("\n")[r.out.split("\n").findIndex((l) => l.includes("HELP TOPICS")) + 1] ?? "";
    const names = line.trim().split(/\s+/);
    expect(names).toEqual([...names].sort());
  });
});

describe("auth login prompts instead of refusing at a terminal", () => {
  it("asks for the token when stdin is a TTY", async () => {
    // The CLI's own GETTING STARTED line used to fail every time with "no token on stdin".
    const dir = mkdtempSync(join(tmpdir(), "signum-ua-"));
    const r = await cli(["auth", "login", "--url", "http://127.0.0.1:1", "--with-token"], {
      env: { SIGNUM_CONFIG_DIR: dir }, answers: ["some-token"],
    });
    // The host is unreachable, so validation fails — but on TRANSPORT, which proves the token was
    // collected and the command got as far as trying to use it.
    expect(r.code).toBe(ExitCode.Transport);
    expect(r.err).not.toContain("no token on stdin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still refuses when there is no way to ask and nothing piped (STORY-09)", async () => {
    const r = await cli(["auth", "login", "--url", "http://127.0.0.1:1", "--with-token"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("no token on stdin");
  });
});

describe("auth login: --with-token is optional, and a token argument is refused", () => {
  it("prompts when --with-token is omitted entirely", async () => {
    // `signum auth login --url …` is the obvious command. It used to fail with "--with-token is
    // required" — an error telling the user to add a flag that selects the only available mechanism.
    const dir = mkdtempSync(join(tmpdir(), "signum-ua-wt-"));
    const r = await cli(["auth", "login", "--url", "http://127.0.0.1:1"], {
      env: { SIGNUM_CONFIG_DIR: dir }, answers: ["some-token"],
    });
    expect(r.err).not.toContain("--with-token is required");
    // Transport failure proves the token was collected and used.
    expect(r.code).toBe(ExitCode.Transport);
    rmSync(dir, { recursive: true, force: true });
  });

  it("REFUSES a token passed as an argument, and says it is compromised", async () => {
    // `--with-token` is boolean, so a value after it became a positional: login ignored it, prompted
    // anyway, and said nothing — leaving the token in shell history for no benefit. That is exactly
    // the leak AC-12.1 exists to prevent.
    const r = await cli(["auth", "login", "--url", "http://127.0.0.1:1", "--with-token", "my-token"], {
      answers: ["ignored"],
    });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("must not be passed as an argument");
    expect(r.err).toContain("shell history");
    expect(r.err).toContain("compromised");
  });

  it("still accepts --with-token, for when other mechanisms exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signum-ua-wt2-"));
    const r = await cli(["auth", "login", "--url", "http://127.0.0.1:1", "--with-token"], {
      env: { SIGNUM_CONFIG_DIR: dir }, answers: ["some-token"],
    });
    expect(r.code).toBe(ExitCode.Transport);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("unmask --clear asks before destroying the mapping", () => {
  /** A profile with one handle stored. */
  async function withHandle(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "signum-ua-clear-"));
    const { saveHandles } = await import("../src/core/config.ts");
    saveHandles({ "ref:aaaaaaaaaaaa": "Order;42" }, { SIGNUM_CONFIG_DIR: dir } as unknown as NodeJS.ProcessEnv);
    return dir;
  }

  it("confirms on a TTY, and 'n' leaves the mapping alone", async () => {
    // It used to delete irreversibly on a bare --clear, orphaning every outstanding handle.
    const dir = await withHandle();
    const r = await cli(["unmask", "--clear"], { env: { SIGNUM_CONFIG_DIR: dir }, tty: true, answers: ["n"] });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("Left untouched");
    const { loadHandles } = await import("../src/core/config.ts");
    expect(Object.keys(loadHandles({ SIGNUM_CONFIG_DIR: dir } as unknown as NodeJS.ProcessEnv))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("proceeds on 'y'", async () => {
    const dir = await withHandle();
    const r = await cli(["unmask", "--clear"], { env: { SIGNUM_CONFIG_DIR: dir }, tty: true, answers: ["y"] });
    expect(r.out).toContain("removed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--yes skips the question", async () => {
    const dir = await withHandle();
    const r = await cli(["unmask", "--clear", "--yes"], { env: { SIGNUM_CONFIG_DIR: dir }, tty: true });
    expect(r.out).toContain("removed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("never prompts when not a TTY — a script asked for it, and hanging is worse (STORY-09)", async () => {
    const dir = await withHandle();
    const r = await cli(["unmask", "--clear"], { env: { SIGNUM_CONFIG_DIR: dir } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("removed");
    rmSync(dir, { recursive: true, force: true });
  });
});
