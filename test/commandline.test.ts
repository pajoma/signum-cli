/**
 * Echoing the invocation instead of the data — REQ-078 (#90) · AC-53.9 · ADR 0009 Decision 2.
 *
 * The property that matters is that the printed line RUNS. AC-60.4 already machine-checks the
 * documented examples for exactly that; this is the same discipline applied to generated output.
 */

import { describe, expect, it } from "bun:test";
import { echoCommand, type EchoInput } from "../src/core/commandline.ts";

function input(over: Partial<EchoInput> = {}): EchoInput {
  return {
    command: "query",
    positionals: ["Order"],
    url: undefined,
    urlWasImplicit: true,
    output: undefined,
    offline: false,
    timeoutMs: undefined,
    pseudonymize: undefined,
    verbose: false,
    noColor: false,
    options: new Map(),
    booleans: new Set(),
    ...over,
  };
}

describe("reproduces the caller's own invocation", () => {
  it("echoes command and positionals", () => {
    expect(echoCommand(input()).command).toBe("signum query Order");
  });

  it("keeps repeatable options in the order given", () => {
    const e = echoCommand(input({
      options: new Map([["filter", ["State = Shipped", "Total > 100"]]]),
    }));
    expect(e.command).toBe('signum query Order --filter "State = Shipped" --filter "Total > 100"');
  });

  it("includes booleans it was given", () => {
    expect(echoCommand(input({ booleans: new Set(["resolve"]) })).command)
      .toBe("signum query Order --resolve");
  });

  it("includes --url only when it was TYPED, not when inherited", () => {
    // Printing a customer's hostname nobody asked for is gratuitous, and the human's own shell
    // already has SIGNUM_URL or a stored credential.
    expect(echoCommand(input({ url: "https://app.example", urlWasImplicit: true })).command)
      .not.toContain("--url");
    expect(echoCommand(input({ url: "https://app.example", urlWasImplicit: false })).command)
      .toContain("--url https://app.example");
  });

  it("carries the output format and other globals through", () => {
    const e = echoCommand(input({ output: "csv", offline: true, timeoutMs: 45_000 }));
    expect(e.command).toContain("--output csv");
    expect(e.command).toContain("--offline");
    expect(e.command).toContain("--timeout 45"); // seconds, as the flag takes them
  });
});

describe("what must never appear", () => {
  it("drops --as-command itself — asking for the echo is not part of it", () => {
    expect(echoCommand(input({ booleans: new Set(["as-command", "count"]) })).command)
      .toBe("signum query Order --count");
  });

  it("drops the acknowledgement flag and --caller-context", () => {
    // Echoing these would tell a human to assert something untrue about themselves. At a terminal
    // they need neither.
    const e = echoCommand(input({
      booleans: new Set(["i-understand-data-goes-to-a-model"]),
      options: new Map([["caller-context", ["agent"]]]),
    }));
    expect(e.command).toBe("signum query Order");
  });

  it("never contains a token — there is nothing to leak, since it is never an argument", () => {
    // Guards the property rather than the mechanism: the credential arrives on stdin or in the
    // environment (AC-12.1), so no reconstruction of argv can carry it.
    const e = echoCommand(input({ options: new Map([["filter", ["State = Shipped"]]]) }));
    expect(e.command).not.toMatch(/token|bearer|apikey/i);
  });

  it("echoes a ref: handle AS GIVEN, so the human's run resolves it locally", () => {
    // Resolving it here would put a real identity in the agent's output — the one thing the handle
    // exists to prevent (AC-53.3).
    expect(echoCommand(input({ command: "get", positionals: ["ref:7f3a1c2b4d5e"] })).command)
      .toBe("signum get ref:7f3a1c2b4d5e");
  });
});

describe("quoting — the line has to RUN", () => {
  it("leaves simple arguments unquoted", () => {
    expect(echoCommand(input({ positionals: ["Order"] })).command).toBe("signum query Order");
  });

  it("double-quotes a value with spaces, which works in bash, cmd AND PowerShell", () => {
    const e = echoCommand(input({ options: new Map([["filter", ["State = Shipped"]]]) }));
    expect(e.command).toContain('"State = Shipped"');
    expect(e.posixOnly).toBe(false);
  });

  it("quotes a Lite key, because an unquoted ; is a shell separator", () => {
    const e = echoCommand(input({ command: "get", positionals: ["Order;42"] }));
    expect(e.command).toBe('signum get "Order;42"');
  });

  it("falls back to POSIX quoting when a value cannot be quoted portably, and SAYS so", () => {
    // Silently emitting a line that breaks in cmd.exe would defeat "runs verbatim".
    const e = echoCommand(input({ options: new Map([["filter", ['Name = "x"']]]) }));
    expect(e.posixOnly).toBe(true);
    expect(e.command).toContain("'");
  });

  it("escapes an embedded single quote in the POSIX fallback", () => {
    const e = echoCommand(input({ options: new Map([["filter", ["Name = O'Brien \"x\""]]]) }));
    expect(e.posixOnly).toBe(true);
    // The classic '\'' dance — without it the line would end the quote early and mangle.
    expect(e.command).toContain(`'\\''`);
  });

  it("represents an empty argument rather than dropping it", () => {
    expect(echoCommand(input({ positionals: [""] })).command).toBe('signum query ""');
  });
});
