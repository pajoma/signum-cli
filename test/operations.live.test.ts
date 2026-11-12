/**
 * Live WRITE checks against a real Signum application (REQ-077, the online half; #114, #117, AC-31.6,
 * AC-32.3). The mock tests prove what is sent; only a real server proves it is APPLIED — and every write
 * hazard in this API fails quietly, which is why this file exists.
 *
 * It CHANGES DATA, so it never runs by accident. Besides the live target (live-config.ts), it needs the
 * records it may write named explicitly — it never picks one itself:
 *
 *   SIGNUM_LIVE_WRITE_ENTITY       a Lite key to edit and restore, e.g. "ProjectArtifactGroup;1"
 *   SIGNUM_LIVE_WRITE_SAVE         that type's save operation, e.g. "ProjectArtifactGroupOperation.Save"
 *   SIGNUM_LIVE_WRITE_MEMBER       a text member of it with a required-value rule, e.g. "Name"
 *   SIGNUM_LIVE_WRITE_NESTED       optional: a record with an MList of embedded rows, e.g. "RASCIMatrixTemplateTask;2"
 *   SIGNUM_LIVE_WRITE_NESTED_SAVE  its save operation
 *   SIGNUM_LIVE_WRITE_NESTED_PATH  a text member inside the first row, e.g. "Roles.0.RASCI"
 *   SIGNUM_LIVE_WRITE_NESTED_VALUE a valid value different from the current one, e.g. "A"
 *
 * Point it at a NON-production instance. Every edit is reverted in a `finally`; values stay in memory
 * and are never printed. The audit log goes to a throwaway config dir.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { ConcurrencyError, ExitCode, exitCodeOf } from "../src/core/errors.ts";
import { fetchEntity, serializeEntity, setMember, type EntityJson } from "../src/core/entity.ts";
import { auditLogPath } from "../src/core/guard.ts";
import { SignumHttp } from "../src/core/http.ts";
import { parseLiteKey } from "../src/core/text.ts";
import { live } from "./live-config.ts";

const env = process.env;
const entity = parseLiteKey(env["SIGNUM_LIVE_WRITE_ENTITY"] ?? "");
const save = env["SIGNUM_LIVE_WRITE_SAVE"] || undefined;
const member = env["SIGNUM_LIVE_WRITE_MEMBER"] || undefined;
const nested = parseLiteKey(env["SIGNUM_LIVE_WRITE_NESTED"] ?? "");
const nestedSave = env["SIGNUM_LIVE_WRITE_NESTED_SAVE"] || undefined;
const nestedPath = env["SIGNUM_LIVE_WRITE_NESTED_PATH"] || undefined;
const nestedValue = env["SIGNUM_LIVE_WRITE_NESTED_VALUE"] || undefined;

const writes = live !== undefined && entity !== undefined && save !== undefined && member !== undefined;
const nestedWrites = writes && nested !== undefined && nestedSave !== undefined && nestedPath !== undefined && nestedValue !== undefined;

const configDir = mkdtempSync(join(tmpdir(), "signum-live-write-"));
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

const http = live === undefined ? undefined : new SignumHttp({ baseUrl: live.url, token: live.token, onTokenRotated: () => {} });

interface Result { code: ExitCode; out: string; err: string }

/** One command, non-interactively, as a script would run it. Output stays in memory. */
async function cli(argv: string[]): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: false,
    stdinIsTty: false,
    // An isolated profile, and an explicit human context: the run is a script, not an agent.
    env: { SIGNUM_CONFIG_DIR: configDir, SIGNUM_URL: live?.url ?? "", SIGNUM_TOKEN: live?.token ?? "", SIGNUM_CALLER_CONTEXT: "automated" } as NodeJS.ProcessEnv,
    readStdin: async () => "",
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    return { code: exitCodeOf(e), out, err: err + (e instanceof Error ? e.message : String(e)) };
  }
}

const read = (lite: { type: string; id: string }): Promise<EntityJson> => fetchEntity(http as SignumHttp, lite.type, lite.id);

/** The wire key for a member as people write it: `Name` is `name` on the wire. */
function wireKey(o: Record<string, unknown>, name: string): string {
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) throw new Error(`the record has no member '${name}'`);
  return key;
}

/** Walk `Roles.0.RASCI` through the wire shape: an MList index steps into the row's element. */
function valueAt(e: EntityJson, path: string): unknown {
  let node: unknown = e;
  for (const seg of path.split(".")) {
    if (/^\d+$/.test(seg)) {
      const row = (node as unknown[])[Number(seg)] as Record<string, unknown>;
      node = Object.hasOwn(row, "element") ? row["element"] : row;
    } else {
      const o = node as Record<string, unknown>;
      node = o[wireKey(o, seg)];
    }
  }
  return node;
}

/** The record without its concurrency token: what must be unchanged by a save that changes nothing. */
function withoutTicks(e: EntityJson): string {
  const { ticks: _t, ...rest } = e as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** A value `--edit` would read back as text, not as a number, boolean or null. */
const editable = (v: unknown): v is string => typeof v === "string" && !/^(null|true|false|-?\d+(\.\d+)?)$/.test(v);

describe.skipIf(!writes)("live writes (#114, #117)", () => {
  const key = `${entity?.type};${entity?.id}`;

  it("--dry-run says the save is permitted and changes nothing (#112)", async () => {
    const before = await read(entity as { type: string; id: string });
    const r = await cli([save as string, "--lite", key, "--dry-run", "-o", "json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect((JSON.parse(r.out) as { permitted: boolean }).permitted).toBe(true);
    expect((await read(entity as { type: string; id: string })).ticks).toBe(before.ticks);
  });

  it("a save with no edits leaves the record as it was (AC-31.6)", async () => {
    const before = await read(entity as { type: string; id: string });
    const r = await cli([save as string, "--lite", key, "--yes", "-o", "json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const after = await read(entity as { type: string; id: string });
    expect(withoutTicks(after)).toBe(withoutTicks(before));
  });

  it("an --edit is applied, and restoring it brings the record back (AC-31.7, AC-32.1)", async () => {
    const before = await read(entity as { type: string; id: string });
    const k = wireKey(before as Record<string, unknown>, member as string);
    const original = (before as Record<string, unknown>)[k];
    if (!editable(original)) throw new Error(`${member} is not a text value this test can restore`);
    try {
      const r = await cli([save as string, "--lite", key, "--edit", `${member}=${original} (signum live test)`, "--yes", "-o", "json"]);
      expect(r.code).toBe(ExitCode.Ok);
      expect(((await read(entity as { type: string; id: string })) as Record<string, unknown>)[k]).toBe(`${original} (signum live test)`);
    } finally {
      const restore = await cli([save as string, "--lite", key, "--edit", `${member}=${original}`, "--yes"]);
      expect(restore.code).toBe(ExitCode.Ok);
    }
    expect(withoutTicks(await read(entity as { type: string; id: string }))).toBe(withoutTicks(before));
    // Each write was recorded with its real target and outcome (AC-46.6).
    const log = readFileSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv), "utf8");
    expect(log).toContain(`"target":"${entity?.type.replace(/Entity$/, "")};${entity?.id}"`);
  });

  it("an empty required value is refused as a validation error, exit 6 (AC-40.6)", async () => {
    const before = await read(entity as { type: string; id: string });
    const k = wireKey(before as Record<string, unknown>, member as string);
    const original = (before as Record<string, unknown>)[k];
    const r = await cli([save as string, "--lite", key, "--edit", `${member}=`, "--yes"]);
    if (r.code === ExitCode.Ok) {
      // Accepted: put it back, and say this member was the wrong choice for the check.
      await cli([save as string, "--lite", key, "--edit", `${member}=${String(original)}`, "--yes"]);
      throw new Error(`the server accepted an empty ${member}; choose a member with a required-value rule`);
    }
    expect(r.code).toBe(ExitCode.Validation);
    expect(withoutTicks(await read(entity as { type: string; id: string }))).toBe(withoutTicks(before));
  });

  it("a write based on a stale read is a concurrency conflict, exit 7, and changes nothing (AC-33.2)", async () => {
    const stale = await read(entity as { type: string; id: string });
    const k = wireKey(stale as Record<string, unknown>, member as string);
    const original = (stale as Record<string, unknown>)[k] as string;
    // Move the record on: an edit and its restore, so its ticks is no longer the one `stale` holds.
    expect((await cli([save as string, "--lite", key, "--edit", `${member}=${original} (signum live test)`, "--yes"])).code).toBe(ExitCode.Ok);
    expect((await cli([save as string, "--lite", key, "--edit", `${member}=${original}`, "--yes"])).code).toBe(ExitCode.Ok);
    const current = await read(entity as { type: string; id: string });

    setMember(stale, [k], `${original} (stale write)`);
    let error: unknown;
    try {
      await (http as SignumHttp).request({
        method: "POST",
        path: `api/operation/executeEntity/${encodeURIComponent(save as string)}`,
        rawBody: `{"entity":${serializeEntity(stale).json},"args":null}`,
      });
    } catch (e) {
      error = e;
    }
    const after = await read(entity as { type: string; id: string });
    if (!(error instanceof ConcurrencyError)) {
      // It went through: restore before failing, so the record is not left changed.
      if ((after as Record<string, unknown>)[k] !== original) {
        await cli([save as string, "--lite", key, "--edit", `${member}=${original}`, "--yes"]);
      }
    }
    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(exitCodeOf(error)).toBe(ExitCode.Concurrency);
    expect(withoutTicks(after)).toBe(withoutTicks(current));
  });
});

describe.skipIf(!nestedWrites)("live nested writes (AC-32.3)", () => {
  it("an edit inside an MList row's embedded entity persists, and is restored", async () => {
    const lite = nested as { type: string; id: string };
    const key = `${lite.type};${lite.id}`;
    const before = await read(lite);
    const original = valueAt(before, nestedPath as string);
    if (!editable(original)) throw new Error(`${nestedPath} is not a text value this test can restore`);
    if (original === nestedValue) throw new Error("SIGNUM_LIVE_WRITE_NESTED_VALUE must differ from the current value");
    try {
      const r = await cli([nestedSave as string, "--lite", key, "--edit", `${nestedPath}=${nestedValue}`, "--yes"]);
      expect(r.code).toBe(ExitCode.Ok);
      // Depth is the point: the change sits in an embedded entity inside a row, and only reaches the
      // database if every node above it was marked modified (AC-32.1).
      expect(valueAt(await read(lite), nestedPath as string)).toBe(nestedValue);
    } finally {
      const restore = await cli([nestedSave as string, "--lite", key, "--edit", `${nestedPath}=${original}`, "--yes"]);
      expect(restore.code).toBe(ExitCode.Ok);
    }
    // Restored whole: the rows kept their rowIds, so they were updated, not recreated (AC-31.3).
    expect(withoutTicks(await read(lite))).toBe(withoutTicks(before));
  });
});
