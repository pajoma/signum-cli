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
import { COMMANDS, findCommand, type CommandSpec } from "../src/core/help.ts";
import { assertKnownFlags, parseArgs } from "../src/core/args.ts";

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

  it("a name that is BOTH a topic and a command renders both (AC-60.4)", async () => {
    // `auth` is both. Rendering only the topic left `signum auth --help` with no subcommands,
    // no flags and no examples, while `signum query --help` had all three — so the promise that
    // every command's help carries runnable examples held for some commands and not others.
    for (const argv of [["help", "auth"], ["auth", "--help"]]) {
      const r = await cli(argv);
      expect(r.code).toBe(ExitCode.Ok);
      expect(r.out).toContain("AUTHENTICATION");  // the topic
      expect(r.out).toContain("SUBCOMMANDS");     // the command group
      expect(r.out).toContain("EXAMPLES");
      expect(r.out).toContain("signum auth status");
    }
  });

  it("-o json on a dual topic/command carries both halves", async () => {
    const r = await cli(["help", "auth", "--json"]);
    const doc = JSON.parse(r.out) as { topic: string; text: string; command?: { name: string; examples: string[] } };
    expect(doc.topic).toBe("auth");
    expect(doc.command?.name).toBe("auth");
    expect(doc.command?.examples.length).toBeGreaterThan(0);
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

/**
 * AC-60.4: "Every command's help carries examples that are **executable exactly as written**."
 *
 * The claim was previously unverified — an example could name a flag that had since been renamed
 * and nothing would fail. Since `assertKnownFlags` derives the valid flag set from the SAME
 * `CommandSpec` the examples live on, an example that drifts from its own declaration is exactly
 * the kind of thing a machine should be catching, not a reader.
 *
 * This checks that each example parses and passes flag validation. It cannot check that the
 * example produces useful output — that needs a server — so `--url https://app.example` examples
 * are validated for shape, not executed.
 */
describe("every documented example is executable as written (AC-60.4)", () => {
  /** Split a shell-ish command line, honouring single and double quotes. */
  function shellSplit(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let quote: '"' | "'" | undefined;
    let started = false;
    for (const ch of line) {
      if (quote !== undefined) {
        if (ch === quote) quote = undefined;
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
      if (ch === " ") {
        if (started) { out.push(cur); cur = ""; started = false; }
        continue;
      }
      cur += ch;
      started = true;
    }
    if (started) out.push(cur);
    return out;
  }

  /**
   * The argv a shell would hand to `signum`: everything after the `signum` word, with any
   * redirection, pipe, or command-substitution tail removed.
   *
   * Examples are written the way a user actually runs them, so `signum` is not always the first
   * word and not always at the top level of the line:
   *
   *   signum cache path
   *   printf %s "$TOKEN" | signum auth login --url … --with-token
   *   signum auth login --url … --with-token < token.txt
   *   ls "$(signum cache path)"                    ← inside a substitution, and quoted
   *
   * Scanning the raw string rather than the split words is what handles the last form: shell
   * splitting collapses `"$(signum cache path)"` into one quoted token, so `signum` disappears
   * from the word list entirely. (That is exactly how this test first failed — on an example
   * added later, which is the drift it exists to catch.)
   */
  function argvOf(example: string): string[] {
    // The last occurrence of `signum` that STARTS a command: preceded by nothing, by a space, or
    // by `(` from a substitution. The boundary check stops a URL like `https://signum.example`
    // from being mistaken for the invocation.
    let at = -1;
    for (let i = example.indexOf("signum"); i !== -1; i = example.indexOf("signum", i + 1)) {
      const before = i === 0 ? " " : (example[i - 1] as string);
      if (before === " " || before === "(") at = i;
    }
    expect(at, `example must invoke signum: ${example}`).toBeGreaterThanOrEqual(0);

    let rest = example.slice(at + "signum".length);
    // A substitution's closing paren ends the command, the same way a pipe does — but ONLY when
    // we are actually inside one. Cutting at every `)` would silently truncate a legitimate
    // grouped filter such as --filter "Total >= 100 and (State = Shipped or State = Delivered)",
    // and a test that quietly validates half an example is worse than no test.
    const insideSubstitution = at > 0 && example[at - 1] === "(";
    if (insideSubstitution) {
      const close = rest.indexOf(")");
      if (close !== -1) rest = rest.slice(0, close);
    }

    const words = shellSplit(rest);
    const cut = words.findIndex((w) => w === "<" || w === ">" || w === ">>" || w === "|");
    return cut === -1 ? words : words.slice(0, cut);
  }

  /** Walk COMMANDS depth-first, yielding each spec with the path that reaches it. */
  function walk(specs: readonly CommandSpec[], prefix: readonly string[] = []): Array<{ path: string[]; spec: CommandSpec }> {
    return specs.flatMap((spec) => {
      const path = [...prefix, spec.name];
      return [{ path, spec }, ...walk(spec.subcommands ?? [], path)];
    });
  }

  const all = walk(COMMANDS);

  it("covers every command and subcommand — none may ship without examples", () => {
    const bare = all.filter(({ spec }) => (spec.examples ?? []).length === 0).map(({ path }) => path.join(" "));
    expect(bare).toEqual([]);
  });

  for (const { path, spec } of all) {
    for (const example of spec.examples ?? []) {
      it(`${path.join(" ")}: ${example}`, () => {
        const argv = argvOf(example);

        // 1. It parses at all.
        const args = parseArgs(argv, {} as NodeJS.ProcessEnv);

        // 2. It invokes the command whose help it is printed under — or one of its
        //    subcommands, since a group's examples legitimately reach into them.
        expect(argv.slice(0, path.length).map((s) => s.toLowerCase())).toEqual(path);

        // 3. Every flag it uses is declared by the command it actually reaches. Resolve the
        //    deepest matching path first, exactly as cli.ts does before calling
        //    assertKnownFlags — `signum auth login --with-token` must validate against
        //    ["auth","login"], not ["auth"], or a subcommand flag reads as unknown.
        const resolved = [...path];
        for (const word of argv.slice(path.length)) {
          if (word.startsWith("-")) break;
          if (findCommand([...resolved, word.toLowerCase()]) === undefined) break;
          resolved.push(word.toLowerCase());
        }
        expect(() => assertKnownFlags(args, resolved)).not.toThrow();
      });
    }
  }

  it("extracts the invocation from every shape an example takes", () => {
    // Guards argvOf itself. Each of these forms appears in real examples, and the substitution
    // form silently broke the extractor once already — shell splitting collapses
    // `"$(signum cache path)"` into one token, so `signum` vanishes from the word list.
    const cases: Array<[string, string[]]> = [
      ["signum cache path", ["cache", "path"]],
      ['ls "$(signum cache path)"', ["cache", "path"]],
      ["signum auth login --url https://app.example --with-token < token.txt",
        ["auth", "login", "--url", "https://app.example", "--with-token"]],
      ['printf %s "$TOKEN" | signum auth login --url https://app.example --with-token',
        ["auth", "login", "--url", "https://app.example", "--with-token"]],
      // A grouped filter must survive intact: its ')' is data, not the end of a substitution.
      ['signum query Order --filter "Total >= 100 and (State = Shipped or State = Delivered)"',
        ["query", "Order", "--filter", "Total >= 100 and (State = Shipped or State = Delivered)"]],
      // A URL containing the word must not be mistaken for the invocation.
      ["signum types --url https://signum.example", ["types", "--url", "https://signum.example"]],
    ];
    for (const [line, expected] of cases) expect(argvOf(line), line).toEqual(expected);
  });

  it("would fail if an example used a flag its command does not declare", () => {
    // Guards the guard: a passing suite above must mean something.
    const args = parseArgs(["query", "Order", "--not-a-real-flag"], {} as NodeJS.ProcessEnv);
    expect(() => assertKnownFlags(args, ["query"])).toThrow(/unknown flag/);
  });
});
