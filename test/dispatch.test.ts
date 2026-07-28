/**
 * Dispatch invariants and caller detection.
 *
 * design/cli-surface.md §2.1 · STORY-50
 */

import { describe, expect, it } from "bun:test";
import { BUILT_INS, builtInsSatisfyDispatchInvariant, flagSetsAreDisjoint, parseArgs } from "../src/core/args.ts";
import { detectCallerContext } from "../src/core/caller.ts";

describe("dispatch invariant", () => {
  it("no built-in contains a dot — rule 1 depends on it", () => {
    expect(builtInsSatisfyDispatchInvariant()).toBe(true);
  });

  it("built-in verbs stay lowercase, so app PascalCase verbs cannot collide accidentally", () => {
    for (const b of BUILT_INS) expect(b as string).toBe(b.toLowerCase());
  });

  it("a flag cannot both require a value and be boolean-only", () => {
    expect(flagSetsAreDisjoint()).toBe(true);
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

  it("both data paths persist minted handles before emitting", async () => {
    // A handle printed but not stored is permanently unresolvable, and we would have caused it
    // (AC-53.5). The mapping now rides on the result rather than an optional parameter, but nothing
    // stops a caller from ignoring it — so assert that neither does.
    for (const path of ["src/commands/query.ts", "src/commands/get.ts"]) {
      expect(await Bun.file(path).text()).toContain("persistHandles(ctx,");
    }
  });
});
