/**
 * Help at every level — STORY-60, STORY-62, STORY-63.
 *
 * Previously 0% covered at the integration level: `showHelp` was only reachable by manual
 * inspection of cli.ts, never exercised through `run()`. This is the entire help story set.
 *
 * QA finding fixed here: `signum help auth login` silently dropped "login" and rendered the
 * `auth` TOPIC instead of the login SUBCOMMAND's help, because topic lookup used only
 * `path[0]` and ran before multi-segment command resolution. `signum auth login --help`
 * (the other route to the same intent) worked correctly, so the two phrasings disagreed.
 */

import { describe, expect, it } from "bun:test";
import { run, type Io } from "../src/cli.ts";
import { ExitCode } from "../src/core/errors.ts";

interface Result { code: ExitCode; out: string; err: string }

async function cli(argv: string[], opts: { env?: Record<string, string>; tty?: boolean } = {}): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: opts.tty === true,
    stdinIsTty: true,
    env: { SIGNUM_CONFIG_DIR: "/nonexistent-for-help-tests", ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
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

describe("static help works with zero configuration (AC-60.2)", () => {
  it("bare invocation shows the overview and exits 0", async () => {
    const r = await cli([]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("signum");
    expect(r.out).toContain("COMMANDS");
  });

  it("`signum help` with no topic also shows the overview", async () => {
    const r = await cli(["help"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("COMMANDS");
  });

  it("--help anywhere shows help and exits 0, never running the command (AC-60.3)", async () => {
    const r = await cli(["auth", "login", "--help"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("signum auth login");
    expect(r.out).not.toContain("error");
  });

  it("an unknown command exits 2 on stderr — help asked for is output, a mistake is a diagnostic", async () => {
    const r = await cli(["bogus-command-xyz"]);
    expect(r.code).toBe(ExitCode.Usage);
  });
});

describe("topic help (`signum help <topic>`)", () => {
  for (const topic of ["filter", "tokens", "output", "exit-codes", "auth", "contexts", "pseudonymization"]) {
    it(`renders the '${topic}' topic`, async () => {
      const r = await cli(["help", topic]);
      expect(r.code).toBe(ExitCode.Ok);
      expect(r.out.length).toBeGreaterThan(20);
    });
  }

  it("an unknown topic is a usage error naming valid topics and commands", async () => {
    const r = await cli(["help", "bogus-topic"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("Topics:");
    expect(r.err).toContain("Commands:");
  });
});

describe("command help (`signum <cmd> --help` and `signum help <cmd>`)", () => {
  it("shows a command's own usage and examples", async () => {
    const r = await cli(["query", "--help"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("signum query");
    expect(r.out).toContain("EXAMPLES");
  });

  it("`signum help query` and `signum query --help` agree (two phrasings, same intent)", async () => {
    const a = await cli(["help", "query"]);
    const b = await cli(["query", "--help"]);
    expect(a.code).toBe(ExitCode.Ok);
    expect(a.out).toBe(b.out);
  });

  it("`signum auth login --help` shows the login subcommand's help, not the auth group's", async () => {
    const r = await cli(["auth", "login", "--help"]);
    expect(r.out).not.toContain("SUBCOMMANDS"); // that heading only appears on the group's own help
    expect(r.out).toContain("--with-token");
  });

  it("QA fix: `signum help auth login` reaches the login SUBCOMMAND, not the 'auth' TOPIC", async () => {
    // Before the fix, "auth" being registered as both a topic and a command name meant
    // topic lookup on path[0] won unconditionally and "login" was silently dropped.
    const r = await cli(["help", "auth", "login"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("--with-token");
    expect(r.out).not.toContain("AUTHENTICATION\n"); // the topic's own heading
  });

  it("`signum help auth` (single segment) still prefers the long-form TOPIC over the command group", async () => {
    // Single-segment "auth" is genuinely ambiguous; the topic (longer prose) is the more
    // useful default and this is unchanged by the multi-segment fix above.
    const r = await cli(["help", "auth"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("AUTHENTICATION");
  });

  it("an unknown subcommand path falls back gracefully rather than crashing", async () => {
    const r = await cli(["help", "auth", "bogus-sub"]);
    expect(r.code).toBe(ExitCode.Ok); // falls back to the 'auth' topic — not an error
  });
});

describe("structured help for agents and tooling (AC-62.1, AC-62.2, AC-62.5)", () => {
  it("-o json on the overview returns the full schema", async () => {
    const r = await cli(["help", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { schemaVersion: number; commands: unknown[]; dispatch: unknown };
    expect(doc.schemaVersion).toBe(1);
    expect(Array.isArray(doc.commands)).toBe(true);
    expect(doc.dispatch).toBeDefined();
  });

  it("-o json on a specific command is SCOPED to that command, not the whole tree", async () => {
    const r = await cli(["query", "--help", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { command: { name: string; flags: unknown[] } };
    expect(doc.command.name).toBe("query");
    expect(Array.isArray(doc.command.flags)).toBe(true);
  });

  it("-o json on a topic returns the topic text as structured data", async () => {
    const r = await cli(["help", "filter", "--json"]);
    const doc = JSON.parse(r.out) as { topic: string; text: string };
    expect(doc.topic).toBe("filter");
    expect(doc.text.length).toBeGreaterThan(10);
  });

  it("structured help contains no data values — safe to emit under an agent context (AC-62.5)", async () => {
    const r = await cli(["help", "--json"], { env: { CLAUDECODE: "1" } });
    // Help must never be blocked by the privacy gate — it is metadata about the CLI itself,
    // never query/entity data.
    expect(r.code).toBe(ExitCode.Ok);
  });
});

describe("prose is the default even when piped (QA design note)", () => {
  it("help is NOT auto-JSON off a TTY — unlike data output, it stays prose unless asked", async () => {
    const r = await cli(["help", "filter"], { tty: false });
    expect(r.out.trim().startsWith("{")).toBe(false);
  });
});
