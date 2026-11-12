/**
 * Named instances (REQ-001, first half): the slug → URL registry behind `-i <name>`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addInstance, instancesPath, listInstances, removeInstance, resolveInstance, validateSlug, validateUrl,
} from "../src/core/instances.ts";
import { parseArgs } from "../src/core/args.ts";

const dirs: string[] = [];
function env(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "signum-instances-"));
  dirs.push(d);
  return { SIGNUM_CONFIG_DIR: d } as NodeJS.ProcessEnv;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("validation", () => {
  it("lowercases a name and rejects anything that is not a plain word", () => {
    expect(validateSlug("Renew")).toBe("renew");
    expect(() => validateSlug("re new")).toThrow(/invalid instance name/);
    expect(() => validateSlug("-x")).toThrow(/invalid instance name/);
    expect(() => validateSlug("https://x")).toThrow(/invalid instance name/);
  });

  it("accepts http(s) only, and never a URL carrying a credential", () => {
    expect(validateUrl("https://renew.example.org/home/")).toBe("https://renew.example.org/home/");
    expect(validateUrl("https://renew.example.org:443/")).toBe("https://renew.example.org");
    expect(() => validateUrl("ftp://x.example")).toThrow(/unsupported scheme/);
    expect(() => validateUrl("https://user:secret@x.example")).toThrow(/user name or password/);
    expect(() => validateUrl("renew")).toThrow(/not a URL/);
  });
});

describe("the registry", () => {
  it("adds, lists, resolves and removes", () => {
    const e = env();
    addInstance("renew", "https://renew.example.org/home", e);
    addInstance("alpha", "https://alpha.example.org", e);
    expect(listInstances(e).map((i) => i.slug)).toEqual(["alpha", "renew"]);
    expect(resolveInstance("RENEW", e)).toBe("https://renew.example.org/home");
    expect(removeInstance("renew", e)?.url).toBe("https://renew.example.org/home");
    expect(removeInstance("renew", e)).toBeUndefined();
    expect(listInstances(e).map((i) => i.slug)).toEqual(["alpha"]);
  });

  it("refuses to overwrite a name silently", () => {
    const e = env();
    addInstance("renew", "https://renew.example.org", e);
    expect(() => addInstance("renew", "https://other.example.org", e)).toThrow(/already exists/);
    expect(resolveInstance("renew", e)).toBe("https://renew.example.org");
  });

  it("names the near miss and what exists when a name is unknown", () => {
    const e = env();
    addInstance("renew", "https://renew.example.org", e);
    expect(() => resolveInstance("renw", e)).toThrow(/unknown instance 'renw'/);
    try { resolveInstance("renw", e); } catch (err) {
      expect((err as { hint?: string }).hint).toContain("Did you mean 'renew'?");
    }
  });

  it("writes the file owner-only", () => {
    if (process.platform === "win32") return; // modes are POSIX-only (REQ-006)
    const e = env();
    addInstance("renew", "https://renew.example.org", e);
    expect(statSync(instancesPath(e)).mode & 0o777).toBe(0o600);
  });

  it("fails loudly on a corrupt file instead of reading it as empty", () => {
    const e = env();
    addInstance("renew", "https://renew.example.org", e);
    writeFileSync(instancesPath(e), "{ not json");
    expect(() => resolveInstance("renew", e)).toThrow(/could not read/);
  });
});

describe("flag parsing", () => {
  it("reads -i and --instance", () => {
    expect(parseArgs(["types", "-i", "renew"], {}).flags.instance).toBe("renew");
    expect(parseArgs(["types", "--instance=renew"], {}).flags.instance).toBe("renew");
  });

  it("refuses --url and --instance together rather than picking one", () => {
    expect(() => parseArgs(["types", "-i", "renew", "--url", "https://x.example"], {})).toThrow(/pass one/);
  });

  it("takes SIGNUM_INSTANCE or SIGNUM_URL, refuses both, and never wins over an explicit flag (AC-05.2)", () => {
    expect(parseArgs(["types"], { SIGNUM_INSTANCE: "renew" } as NodeJS.ProcessEnv).flags).toMatchObject({ instance: "renew", url: undefined });
    expect(parseArgs(["types"], { SIGNUM_URL: "https://x.example" } as NodeJS.ProcessEnv).flags).toMatchObject({ instance: undefined, url: "https://x.example" });
    const both = { SIGNUM_INSTANCE: "renew", SIGNUM_URL: "https://x.example" } as NodeJS.ProcessEnv;
    expect(() => parseArgs(["types"], both)).toThrow(/both name a target/);
    expect(parseArgs(["types", "--url", "https://y.example"], both).flags).toMatchObject({ instance: undefined, url: "https://y.example" });
    expect(parseArgs(["types", "-i", "alpha"], both).flags).toMatchObject({ instance: "alpha", url: undefined });
  });
});
