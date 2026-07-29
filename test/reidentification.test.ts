/**
 * Local re-identification handles — REQ-058 (#52) · STORY-53.
 *
 * The mapping file is the one place a real identity and its surrogate sit side by side, so the
 * properties that matter are: it is never emitted, a handle never reaches the server, an
 * unresolvable handle fails loudly rather than being forwarded, and resolving one is a human act.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHandles, handlesPath, loadHandles, saveHandles } from "../src/core/config.ts";
import {
  createRecorder, HANDLE_PREFIX, isHandle, resolvePolicy, resolveHandle, surrogate,
} from "../src/core/privacy.ts";
import { UsageError } from "../src/core/errors.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signum-refs-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = () => ({ SIGNUM_CONFIG_DIR: dir }) as unknown as NodeJS.ProcessEnv;
const policy = () => resolvePolicy({ callerIsAgent: true, acknowledged: false, env: env() });

describe("Lite values become opaque handles (AC-53.1)", () => {
  it("emits ref:… for a Lite, not a Type;id and not a label", () => {
    const out = surrogate({ EntityType: "User", id: 102 }, "User", policy());
    expect(typeof out).toBe("string");
    expect(String(out)).toStartWith(HANDLE_PREFIX);
    // Deliberately NOT Type;id-shaped, so nothing downstream mistakes it for one.
    expect(String(out)).not.toContain(";");
  });

  it("records the real key so the handle can be resolved later", () => {
    const rec = createRecorder();
    const h = String(surrogate({ EntityType: "User", id: 102 }, "User", policy(), rec));
    expect(rec.entries()[h]).toBe("User;102");
  });

  it("is stable — the same record yields the same handle across invocations", () => {
    const p = policy();
    expect(surrogate({ EntityType: "User", id: 102 }, "User", p))
      .toBe(surrogate({ EntityType: "User", id: 102 }, "User", p));
  });

  it("uses enough bits that collisions are not a practical concern", () => {
    // ADR 0007 illustrates `ref:7f3a`; 16 bits collide at a few hundred entries by the birthday
    // bound, and a handle collision means two people sharing one identity.
    const h = String(surrogate({ EntityType: "User", id: 1 }, "User", policy()));
    expect(h.slice(HANDLE_PREFIX.length)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("distinguishes different records", () => {
    const p = policy();
    const a = surrogate({ EntityType: "User", id: 102 }, "User", p);
    const b = surrogate({ EntityType: "User", id: 103 }, "User", p);
    expect(a).not.toBe(b);
  });
});

describe("the store (AC-53.3, AC-53.6)", () => {
  it("is written 0600 — it is the one file holding both halves", () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;1" }, env());
    if (process.platform !== "win32") {
      expect(statSync(handlesPath(env())).mode & 0o777).toBe(0o600);
    }
  });

  it("merges across invocations rather than replacing", () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;1" }, env());
    saveHandles({ "ref:bbbbbbbbbbbb": "User;2" }, env());
    expect(loadHandles(env())).toEqual({ "ref:aaaaaaaaaaaa": "User;1", "ref:bbbbbbbbbbbb": "User;2" });
  });

  it("re-recording the SAME mapping is not a collision", () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;1" }, env());
    expect(saveHandles({ "ref:aaaaaaaaaaaa": "User;1" }, env())).toEqual([]);
  });

  it("REPORTS a collision instead of silently overwriting", () => {
    // A silent overwrite would mean a handle resolving to the wrong person — the exact mismatch
    // AC-53.6 forbids, and unlike a stale handle it would look like it worked.
    saveHandles({ "ref:aaaaaaaaaaaa": "User;1" }, env());
    const collisions = saveHandles({ "ref:aaaaaaaaaaaa": "User;999" }, env());
    expect(collisions).toEqual(["ref:aaaaaaaaaaaa"]);
    expect(loadHandles(env())["ref:aaaaaaaaaaaa"]).toBe("User;1"); // prior mapping untouched
  });

  it("survives a corrupt store rather than crashing the CLI", () => {
    writeFileSync(handlesPath(env()), "{ not json");
    expect(loadHandles(env())).toEqual({});
  });

  it("--clear is how a handle expires, and it is total", () => {
    saveHandles({ "ref:aaaaaaaaaaaa": "User;1" }, env());
    expect(clearHandles(env())).toBe(true);
    expect(existsSync(handlesPath(env()))).toBe(false);
    expect(clearHandles(env())).toBe(false); // idempotent
  });
});

describe("resolution (AC-53.2, AC-53.5)", () => {
  it("resolves a stored handle to the real key", () => {
    expect(resolveHandle("ref:aaaaaaaaaaaa", { "ref:aaaaaaaaaaaa": "User;102" })).toBe("User;102");
  });

  it("FAILS on an unknown handle rather than forwarding it as a literal", () => {
    // Forwarding `ref:…` to the server would 404 confusingly at best, and at worst match something.
    expect(() => resolveHandle("ref:ffffffffffff", {})).toThrow(UsageError);
    expect(() => resolveHandle("ref:ffffffffffff", {})).toThrow(/cannot resolve/);
  });

  it("explains WHY a handle is gone — scope and lifetime (AC-53.6)", () => {
    try {
      resolveHandle("ref:ffffffffffff", {});
      throw new Error("expected a throw");
    } catch (e) {
      const hint = (e as UsageError).hint ?? "";
      expect(hint).toContain("per profile");
      expect(hint).toContain("--clear");
    }
  });

  it("recognises a handle by prefix, and a Lite key as not one", () => {
    expect(isHandle("ref:aaaaaaaaaaaa")).toBe(true);
    expect(isHandle("User;102")).toBe(false);
  });
});

describe("the mapping never leaks (AC-53.3)", () => {
  it("the store file is the ONLY place the pairing exists", () => {
    // Guards against a future change that logs or returns the map. The recorder hands entries to
    // the caller for persistence and nothing else reads them.
    const rec = createRecorder();
    surrogate({ EntityType: "User", id: 102 }, "User", policy(), rec);
    saveHandles(rec.entries(), env());
    const onDisk = readFileSync(handlesPath(env()), "utf8");
    expect(onDisk).toContain("User;102");
    // ...and the surrogate itself carries nothing of the original.
    const handle = Object.keys(rec.entries())[0]!;
    expect(handle).not.toContain("102");
    expect(handle).not.toContain("User;");
  });
});
