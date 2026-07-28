/**
 * Credential file permissions — AC-11.5, AC-04.1 · #84.
 *
 * The warning fired on EVERY invocation on Windows with a message the user could not act on:
 * `credential.json is mode 666; expected 600`. It was not a real exposure and it was not fixable
 * by the suggested fix (`saveCredential` already chmods 0600) — on Windows, Node's `chmod` only
 * toggles the read-only attribute and `stat().mode` is synthesized, so the file can only ever
 * report 666 there. A warning nobody can satisfy trains people to ignore the ones that matter.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPermissions, permissionsAreUnenforceable, saveCredential, loadCredential } from "../src/core/config.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signum-perm-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = () => ({ SIGNUM_CONFIG_DIR: dir }) as unknown as NodeJS.ProcessEnv;

describe("POSIX hosts: the check works and is worth having", () => {
  it("stays silent on a correctly-restricted file", () => {
    const p = join(dir, "c.json");
    writeFileSync(p, "{}", { mode: 0o600 });
    expect(checkPermissions(p, "linux")).toBeUndefined();
  });

  it("warns when group or other can read", () => {
    const p = join(dir, "c.json");
    writeFileSync(p, "{}", { mode: 0o600 });
    chmodSync(p, 0o644);
    expect(checkPermissions(p, "linux")).toContain("expected 600");
  });

  it("warns on a world-writable file", () => {
    const p = join(dir, "c.json");
    writeFileSync(p, "{}", { mode: 0o600 });
    chmodSync(p, 0o666); // explicit: writeFileSync's mode is subject to umask, chmod is not
    expect(checkPermissions(p, "linux")).toContain("666");
  });

  it("a stat failure is non-fatal — a readable credential must stay usable", () => {
    expect(checkPermissions(join(dir, "does-not-exist.json"), "linux")).toBeUndefined();
  });

  it("saveCredential really does write 0600 here", () => {
    const p = saveCredential(
      { url: "https://a.example", token: "t", source: "browser-handoff", savedAt: "now" },
      env(),
    );
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("Windows: the check is suppressed because it cannot be satisfied (#84)", () => {
  it("returns no warning even for a mode the POSIX check would reject", () => {
    // Exactly the reported situation: a 666 file. On Windows that is what Node reports for ANY
    // writable file, so warning about it says nothing about exposure.
    const p = join(dir, "c.json");
    writeFileSync(p, "{}", { mode: 0o600 });
    chmodSync(p, 0o666);
    expect(checkPermissions(p, "linux")).toBeDefined();   // same file, POSIX host -> warns
    expect(checkPermissions(p, "win32")).toBeUndefined(); // ...and win32 -> silent
  });

  it("declares permissions unenforceable, so diagnostics can say where protection comes from", () => {
    expect(permissionsAreUnenforceable("win32")).toBe(true);
    expect(permissionsAreUnenforceable("linux")).toBe(false);
    expect(permissionsAreUnenforceable("darwin")).toBe(false);
  });
});

describe("loadCredential surfaces the check without depending on it", () => {
  it("loads a credential and reports no warning when the mode is right", () => {
    saveCredential(
      { url: "https://a.example", token: "t", source: "browser-handoff", savedAt: "now" },
      env(),
    );
    const loaded = loadCredential(env());
    expect(loaded?.credential.url).toBe("https://a.example");
    expect(loaded?.permissionWarning).toBeUndefined();
  });

  it("still loads a credential whose permissions are wrong — a warning, never a failure", () => {
    const p = saveCredential(
      { url: "https://a.example", token: "t", source: "browser-handoff", savedAt: "now" },
      env(),
    );
    chmodSync(p, 0o666);
    const loaded = loadCredential(env());
    // AC-11.5: wrong permissions are a warning, not a refusal to work.
    expect(loaded?.credential.token).toBe("t");
    if (!permissionsAreUnenforceable()) expect(loaded?.permissionWarning).toContain("expected 600");
  });
});
