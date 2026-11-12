/**
 * Dispatch invariants and caller detection.
 *
 * design/cli-surface.md §2.1 · STORY-50
 */

import { describe, expect, it } from "bun:test";
import { BUILT_INS, builtInsSatisfyDispatchInvariant, flagCheckPath, flagSetsAreDisjoint, parseArgs } from "../src/core/args.ts";
import { allFlagSpecs, COMMANDS, GLOBAL_FLAGS } from "../src/core/help.ts";
import { HANDLERS } from "../src/cli.ts";
import { flag, optAll, type Ctx } from "../src/core/ctx.ts";
import { detectCallerContext } from "../src/core/caller.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitData } from "../src/core/emit.ts";
import { loadHandles } from "../src/core/handles.ts";
import { unsafeDataWriter } from "../src/core/policy.ts";
import { resolvePolicy } from "../src/core/privacy.ts";

describe("dispatch invariant", () => {
  it("no built-in contains a dot — rule 1 depends on it", () => {
    expect(builtInsSatisfyDispatchInvariant()).toBe(true);
  });

  it("built-in verbs stay lowercase, so app PascalCase verbs cannot collide accidentally", () => {
    for (const b of BUILT_INS) expect(b).toBe(b.toLowerCase());
  });

  it("a flag cannot both require a value and be boolean-only", () => {
    expect(flagSetsAreDisjoint()).toBe(true);
  });

  // The parser learns each flag's arity from its FlagSpec, so no second list can drift (audit, R3).
  it("parses every declared flag with the arity its FlagSpec gives it", () => {
    // The globals the parser peels into typed fields are checked by their own tests.
    for (const f of allFlagSpecs().filter((g) => !GLOBAL_FLAGS.includes(g))) {
      for (const name of [f.name, ...(f.alias !== undefined ? [f.alias] : [])]) {
        const dash = name.length === 1 ? "-" : "--";
        const parsed = parseArgs(["query", "Order", `${dash}${name}`, "x"], {});
        if (f.arg !== undefined) expect([name, parsed.options.get(name)]).toEqual([name, ["x"]]);
        else expect([name, parsed.booleans.has(name), parsed.positionals]).toEqual([name, true, ["Order", "x"]]);
      }
    }
    // `--pack=true` used to land among the values, where `flag()` never looks, and was ignored.
    expect(parseArgs(["get", "Order", "42", "--pack=true"], {}).booleans.has("pack")).toBe(true);
  });

  // #124: the help tree, the built-in list and the dispatcher must name the same commands, or a
  // declared command silently falls through to operation dispatch.
  it("every command in the help tree except `help` has a dispatch handler, and nothing more", () => {
    const declared = COMMANDS.map((c) => c.name).filter((n) => n !== "help").sort();
    expect(Object.keys(HANDLERS).sort()).toEqual(declared);
  });

  it("every documented global flag is consumed by the parser, never left for command flag checks", () => {
    for (const f of GLOBAL_FLAGS) {
      for (const name of [f.name, ...(f.alias !== undefined ? [f.alias] : [])]) {
        const dashes = name.length === 1 ? "-" : "--";
        // A value every value-taking global flag accepts at parse time (`--output` validates).
        const argv = f.arg !== undefined ? [`${dashes}${name}`, f.name === "output" ? "json" : "1"] : [`${dashes}${name}`];
        const a = parseArgs(argv, {});
        expect({ name, options: [...a.options.keys()], booleans: [...a.booleans] })
          .toEqual({ name, options: [], booleans: [] });
      }
    }
  });

  it("an undeclared subcommand skips the flag check so the command can name the real mistake", () => {
    expect(flagCheckPath("auth", "login")).toEqual(["auth", "login"]);
    expect(flagCheckPath("cache", "bogus")).toBeUndefined();
    expect(flagCheckPath("cache", undefined)).toEqual(["cache"]);
    expect(flagCheckPath("query", "Order")).toEqual(["query"]);
  });

  it("routes a dotted first argument to a canonical operation key", () => {
    const a = parseArgs(["OrderOperation.Ship", "--lite", "Order;42"], {});
    expect(a.kind).toBe("operation-key");
    expect(a.command).toBe("OrderOperation.Ship");
  });

  it("built-ins always win over a verb-noun reading", () => {
    const a = parseArgs(["get", "order"], {});
    expect(a.kind).toBe("builtin");
    expect(a.command).toBe("get");
  });

  it("falls through to verb-noun for an unknown verb", () => {
    const a = parseArgs(["ship", "order", "42"], {});
    expect(a.kind).toBe("verb-noun");
    expect(a.command).toBe("ship");
    expect(a.positionals).toEqual(["order", "42"]);
  });

  it("treats a bare invocation as 'none' so it lands on help", () => {
    expect(parseArgs([], {}).kind).toBe("none");
  });
});

describe("flag parsing", () => {
  it("supports --json as an alias for -o json", () => {
    expect(parseArgs(["query", "Order", "--json"], {}).flags.output).toBe("json");
  });

  it("accepts --output=csv and -o csv", () => {
    expect(parseArgs(["query", "Order", "--output=csv"], {}).flags.output).toBe("csv");
    expect(parseArgs(["query", "Order", "-o", "tsv"], {}).flags.output).toBe("tsv");
  });

  it("collects repeatable options in order", () => {
    const a = parseArgs(["query", "Order", "--column", "A", "--column", "B"], {});
    expect(a.options.get("column")).toEqual(["A", "B"]);
  });

  it("rejects a value-taking flag with no value", () => {
    expect(() => parseArgs(["query", "Order", "--top"], {})).toThrow(/requires a value/);
  });

  it("reads the agent-data acknowledgement from the environment", () => {
    expect(parseArgs(["query", "Order"], { SIGNUM_ALLOW_AGENT_DATA: "1" }).flags.allowAgentData).toBe(true);
  });

  // H2 (Brooks review): a boolean flag given `=value` must still register as the boolean,
  // not silently land in `options` where flag() never looks — otherwise --exists=true is
  // read as "not passed" and the CLI fetches the full entity instead of checking existence.
  it("treats --exists=true as the boolean being set (H2 regression)", () => {
    const a = parseArgs(["get", "Order", "42", "--exists=true"], {});
    expect(a.booleans.has("exists")).toBe(true);
    expect(a.options.has("exists")).toBe(false);
  });

  it("treats --exists=false as the boolean NOT being set", () => {
    const a = parseArgs(["get", "Order", "42", "--exists=false"], {});
    expect(a.booleans.has("exists")).toBe(false);
  });

  it("rejects a non-boolean value on a boolean flag rather than silently accepting it", () => {
    expect(() => parseArgs(["get", "Order", "42", "--exists=maybe"], {})).toThrow(/--exists/);
  });
});

describe("caller detection (STORY-50)", () => {
  const noProc = { stdoutIsTty: false, env: {} as NodeJS.ProcessEnv };

  it("fails closed: no TTY and no marker is 'automated', never 'interactive'", () => {
    const d = detectCallerContext(noProc);
    // The parent process on a dev machine may itself be an agent, so accept either
    // strict verdict — what must never happen is 'interactive'.
    expect(d.context === "automated" || d.context === "agent").toBe(true);
  });

  it("treats a known agent env var as 'agent'", () => {
    const d = detectCallerContext({ stdoutIsTty: true, env: { CLAUDECODE: "1" } as NodeJS.ProcessEnv });
    expect(d.context).toBe("agent");
    expect(d.signals.some((s) => s.includes("CLAUDECODE"))).toBe(true);
  });

  it("mcp mode is definitive", () => {
    const d = detectCallerContext({ ...noProc, mcpMode: true });
    expect(d.context).toBe("agent");
  });

  it("flags a loosening override so the caller can log it (AC-50.4)", () => {
    const d = detectCallerContext({
      stdoutIsTty: true,
      env: { CLAUDECODE: "1" } as NodeJS.ProcessEnv,
      override: "interactive",
    });
    expect(d.context).toBe("interactive");
    expect(d.overridden).toBe(true);
    expect(d.loosened).toBe(true);
  });

  it("does not flag a tightening override as loosening", () => {
    const d = detectCallerContext({ stdoutIsTty: true, env: {} as NodeJS.ProcessEnv, override: "agent" });
    expect(d.loosened).toBe(false);
  });

  it("rejects an invalid override with a UsageError, not a plain Error (QA finding)", () => {
    expect(() => detectCallerContext({ ...noProc, override: "nonsense" })).toThrow(/invalid --caller-context/);
  });
});

/**
 * The data-output boundary is structural, not a convention (ADR 0007 · policy.ts).
 *
 * The old privacy gate had to be *remembered* by every data-emitting command, and forgetting it
 * was a silent leak nothing could detect. It is now a type: row and entity renderers accept only
 * a `DataWriter`, which `ctx.openData` mints after applying the gate. These two tests guard the
 * remaining ways to get around that — reaching for the escape hatch, or writing to stdout
 * directly from a data command.
 */
describe("the data-output boundary cannot be bypassed inside src/", () => {
  const SRC = new Bun.Glob("src/**/*.ts");

  async function sources(): Promise<Array<{ path: string; text: string }>> {
    const out: Array<{ path: string; text: string }> = [];
    for await (const path of SRC.scan(".")) out.push({ path, text: await Bun.file(path).text() });
    return out;
  }

  it("nothing in src/ mints a DataWriter through the test-only escape hatch", async () => {
    const offenders = (await sources())
      .filter((f) => f.path !== "src/core/policy.ts") // where it is defined
      .filter((f) => /\bunsafeDataWriter\s*\(/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("data commands read server data with exact numbers (#111)", async () => {
    // A rounded int64 id names a different record, and its handle would not match the one the
    // other data path mints for the same record. Every request in query.ts renders data; get.ts
    // reads its entity through fetchEntity, which is lossless.
    const query = await Bun.file("src/commands/query.ts").text() + await Bun.file("src/commands/query-variants.ts").text();
    const requests = query.match(/http\.request\b/g)?.length ?? 0;
    expect(requests).toBeGreaterThan(0);
    expect(query.match(/lossless: true/g)?.length ?? 0).toBe(requests);
    expect(await Bun.file("src/commands/get.ts").text()).toContain("fetchEntity(");
  });

  it("data commands write server data only through ctx.openData, never ctx.io.out", async () => {
    // query.ts and get.ts are the m1 data commands. They may still use ctx.io.err for
    // diagnostics and renderDocument+ctx.io.out for `--explain` (which sends nothing), so this
    // asserts the positive: each one opens the boundary, and the ungated renderers it calls are
    // the document ones.
    for (const path of ["src/commands/query.ts", "src/commands/get.ts"]) {
      const text = await Bun.file(path).text();
      expect(text).toContain("ctx.openData(");
      expect(text).toContain("renderDataDocument");
    }
  });
});

/**
 * Guard-rails for the two rules this codebase has already had to learn twice.
 *
 * A Brooks review found four copies of the sensitivity decision, which had drifted into two real
 * defects — introspection contradicting behaviour, and `get` emitting entity references while
 * reporting it had protected them. These assert the shape that prevents a fifth copy.
 */
describe("the sensitivity decision has exactly one home", () => {
  async function sources(): Promise<Array<{ path: string; text: string }>> {
    const glob = new Bun.Glob("src/**/*.ts");
    const out: Array<{ path: string; text: string }> = [];
    for await (const path of glob.scan(".")) out.push({ path, text: await Bun.file(path).text() });
    return out;
  }

  it("nothing outside privacy.ts decides sensitivity for itself", async () => {
    // The heuristic word list and the identity predicate are implementation details of the one
    // decision function. A caller reaching for them is a caller about to disagree with it.
    const offenders = (await sources())
      .filter((f) => f.path !== "src/core/privacy.ts")
      .filter((f) => /SENSITIVE_WORDS|isIdentityValue\s*\(/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("data leaves a command only through emit.ts, which keeps handles before writing and discloses after", async () => {
    // A handle printed but not stored is permanently unresolvable, and we would have caused it
    // (AC-53.5). emit.ts holds the order; a command that persisted or disclosed on its own would be
    // a second, unchecked copy of it (architecture audit, R3).
    for (const file of new Bun.Glob("src/commands/*.ts").scanSync()) {
      const text = await Bun.file(file).text();
      expect([file, text.includes("persistHandles(")]).toEqual([file, false]);
      expect([file, text.includes("disclosure(")]).toEqual([file, false]);
    }

    const dir = mkdtempSync(join(tmpdir(), "signum-emit-"));
    const env = { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const order: string[] = [];
    const ctx = {
      io: { env, err: (s: string) => order.push(`err:${s.trim().split("\n")[0]}`) },
      target: "https://app.example",
      privacy: resolvePolicy({ callerIsAgent: true, acknowledged: false, target: "https://app.example", env }),
      openData: () => unsafeDataWriter((s) => order.push(`out:${s}`), "test sink"),
    } as unknown as Ctx;
    emitData(ctx, "test data", { handles: { ref_aaaaaaaaaaaa: "Order;42" }, pseudonymized: ["Name"] }, (out) => {
      order.push(`stored:${loadHandles(env, "https://app.example")["ref_aaaaaaaaaaaa"] ?? "missing"}`);
      out("row");
    });
    expect(order[0]).toBe("stored:Order;42");
    expect(order[1]).toBe("out:row");
    expect(order[2]).toStartWith("err:note: pseudonymized");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("flag accessors (#124)", () => {
  const ctxFor = (argv: string[]) => ({ args: parseArgs(argv, {}) }) as unknown as Ctx;

  it("read a declared flag normally", () => {
    expect(optAll(ctxFor(["query", "Order", "--filter", "Id > 1"]), "filter")).toEqual(["Id > 1"]);
  });

  it("fail loudly when command code reads a name its help spec does not declare", () => {
    expect(() => flag(ctxFor(["query", "Order"]), "fitler")).toThrow(/not declared for 'query'/);
  });
});
