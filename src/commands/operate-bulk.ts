/**
 * An operation over many records (#119, STORY-45): one request, one outcome per record.
 *
 * Bulk is not a loop over single operations. The multi endpoints take a list of Lites and stream
 * NDJSON back, one `{entity, error}` line per record, flushed as each is done
 * (`OperationController.cs:211-256`, `ForeachNDJson` at `:598-624`). So each outcome is logged and
 * shown the moment it arrives: a batch interrupted half-way leaves every line already shown valid,
 * and says how far it got (AC-45.6).
 *
 * Values to change on every record go as property setters (AC-45.4, `setters.ts`): `--edit` over
 * many records, or `--setters-json` for MList rows and new entities.
 */

import type { Ctx } from "../core/ctx.ts";
import { optAll } from "../core/ctx.ts";
import { ExitCode, InterruptedError, UsageError } from "../core/errors.ts";
import { confirmMutation, recordMutation } from "../core/guard.ts";
import { loadHandles } from "../core/handles.ts";
import { parseLossless } from "../core/json.ts";
import { kebab, type ArgValue, type ResolvedOperation } from "../core/operations.ts";
import { renderDocument } from "../core/output.ts";
import { isHandle } from "../core/reidentify.ts";
import { describeSetters, parseSettersJson, settersFromEdits, type PropertySetter } from "../core/setters.ts";
import type { Target } from "../core/target.ts";
import {
  argsOf, cleanName, explainSendError, failureOf, interruptible, liteJson, packCanExecute, parseEdits, permission,
  realKey, recordKey, renderPack, shownTarget, type OperationTarget,
} from "./operate-common.ts";

export interface BulkPlan {
  many: true;
  op: ResolvedOperation;
  targets: OperationTarget[];
  route: "executeMultiple" | "deleteMultiple" | "constructFromMultiple" | "constructFromMany";
  args: ArgValue[] | null;
  /** Sent: handles resolved to the Lites they stand for. */
  setters: PropertySetter[] | undefined;
  /** For `--explain` and the confirmation: handles as written. */
  shownSetters: PropertySetter[] | undefined;
}

/** `settersJson` is the text `--setters-json` stood for, already read. */
export function bulkPlan(ctx: Ctx, op: ResolvedOperation, targets: OperationTarget[], settersJson: string | undefined): BulkPlan {
  const kind = op.info.kind ?? "Execute";
  if (targets.length === 0) {
    throw new UsageError(`${op.key} runs on records; name them`, {
      hint: `signum ${op.key} --lite "${op.type.name};1" --lite "${op.type.name};2"`,
    });
  }
  const route = kind === "Execute" ? "executeMultiple"
    : kind === "Delete" ? "deleteMultiple"
    : kind === "ConstructorFrom" ? "constructFromMultiple"
    : kind === "ConstructorFromMany" ? "constructFromMany"
    : undefined;
  if (route === undefined) {
    throw new UsageError(`${op.key} is a constructor, which runs on no record`, { hint: `signum ${kebab(op.info.verb)} ${kebab(op.type.name)}` });
  }

  const edits = parseEdits(ctx);
  let setters: PropertySetter[] | undefined;
  let shownSetters: PropertySetter[] | undefined;
  if (edits.length > 0 || settersJson !== undefined) {
    // The same rule as one record's --edit (#114), and the web UI's own (`ContextualOperations.tsx:257`):
    // values go only to an operation that saves the entity it is given. A delete or a construct-from
    // would apply them to something that is then thrown away.
    if (route !== "executeMultiple" || !op.info.canBeModified) {
      throw new UsageError(`${op.key} does not save the records it is given, so the values would be discarded`, {
        hint: "Set values with an operation that takes the entity, such as its Save.",
      });
    }
    const handles = loadHandles(ctx.io.env);
    setters = [
      ...settersFromEdits(op.type, edits, handles),
      ...(settersJson !== undefined ? parseSettersJson(settersJson, handles) : []),
    ];
    shownSetters = [
      ...settersFromEdits(op.type, edits, "keep"),
      ...(settersJson !== undefined ? parseSettersJson(settersJson, "keep") : []),
    ];
  }
  return { many: true, op, targets, route, args: argsOf(ctx), setters, shownSetters };
}

/** One record's outcome, as the multi endpoints stream it (`OperationController.OperationResult`). */
interface BulkOutcome {
  /** As the caller named it: a handle stays a handle. */
  target: string;
  ok: boolean;
  error?: string;
}

function bulkPath(p: BulkPlan): string {
  return `api/operation/${p.route}/${encodeURIComponent(p.op.key)}`;
}

/** `MultiOperationRequest`: the Lites, the args, the setters, and for constructFromMany the type when no Lite says it. */
function bulkBody(p: BulkPlan, shown: boolean): Record<string, unknown> {
  const setters = shown ? p.shownSetters : p.setters;
  return {
    lites: p.targets.map(shown ? shownTarget : liteJson),
    args: p.args,
    ...(setters !== undefined ? { setters } : {}),
    ...(p.route === "constructFromMany" ? { type: cleanName(p.op.type.name) } : {}),
  };
}

/** One NDJSON line as `{key, ok, error}`, or undefined when it cannot be read — a stream cut off mid-line. */
function readOutcomeLine(line: string): { key: string; ok: boolean; error?: string } | undefined {
  let o: { entity?: { EntityType?: string; id?: unknown }; error?: string | null };
  try {
    // Lossless, so an id past 2^53 still matches the record it names.
    o = parseLossless(line) as typeof o;
  } catch {
    return undefined;
  }
  if (o === null || typeof o !== "object") return undefined;
  const ok = o.error === null || o.error === undefined || o.error === "";
  return {
    key: recordKey(String(o.entity?.EntityType ?? ""), String(o.entity?.id ?? "")),
    ok,
    ...(!ok ? { error: String(o.error) } : {}),
  };
}

/** 0 when every record succeeded, 10 when some did, 1 when none did (AC-45.3). */
function bulkExit(outcomes: readonly BulkOutcome[]): ExitCode {
  const failed = outcomes.filter((o) => !o.ok).length;
  if (failed === 0) return ExitCode.Ok;
  return failed === outcomes.length ? ExitCode.Unexpected : ExitCode.PartialFailure;
}

/**
 * Outcomes as they arrive. A table and NDJSON are written line by line, so what is on screen stays
 * true if the batch is interrupted; JSON is one document, written when every record is accounted for.
 */
function outcomeWriter(ctx: Ctx, words: { ok: string; failed: string }): {
  add(o: BulkOutcome): void;
  finish(all: readonly BulkOutcome[]): void;
} {
  return {
    add(o) {
      if (ctx.format === "ndjson") ctx.io.out(JSON.stringify(o) + "\n");
      else if (ctx.format !== "json") ctx.io.out(o.ok ? `${words.ok}  ${o.target}\n` : `${words.failed}  ${o.target}: ${o.error}\n`);
    },
    finish(all) {
      if (ctx.format === "json") renderDocument(all, { format: "json", write: ctx.io.out });
      const failed = all.filter((o) => !o.ok).length;
      const dry = words.ok === "permitted";
      ctx.io.err(`${all.length - failed} of ${all.length} ${dry ? "permitted" : "succeeded"}` +
        (failed > 0 ? `; ${failed} ${dry ? "not permitted" : "failed"}` : "") + "\n");
    },
  };
}

/**
 * `--dry-run` over many records: each record's own `canExecute` from its entity pack (AC-45.5,
 * #119). `stateCanExecutes` answers for the SET as a whole, which is the blanket answer a per-record
 * dry run must not give. Reads only; no `api/operation/*` request.
 */
async function bulkDryRun(ctx: Ctx, target: Target, p: BulkPlan): Promise<ExitCode> {
  const writer = outcomeWriter(ctx, { ok: "permitted", failed: "blocked" });
  const outcomes: BulkOutcome[] = [];
  for (const t of p.targets) {
    const { ok, reason } = permission(await packCanExecute(target, t), p.op.key);
    const o: BulkOutcome = { target: t.shown, ok, ...(reason !== undefined ? { error: reason } : {}) };
    outcomes.push(o);
    writer.add(o);
  }
  writer.finish(outcomes);
  ctx.io.err("note: a dry run checks permission, not success: a permitted operation can still fail when run.\n");
  if (p.setters !== undefined) {
    ctx.io.err("note: the values to set are not checked; the server checks each one's write permission as it applies it.\n");
  }
  return outcomes.every((o) => o.ok) ? ExitCode.Ok : ExitCode.NotAuthorized;
}

export async function runBulk(ctx: Ctx, target: Target, p: BulkPlan, mode: { explain: boolean; dry: boolean }): Promise<ExitCode> {
  if (mode.explain) {
    renderDocument({ method: "POST", url: `${target.url}/${bulkPath(p)}`, body: bulkBody(p, true) },
      { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
    if (!mode.dry) return ExitCode.Ok;
  }
  if (mode.dry) return await bulkDryRun(ctx, target, p);

  const isDelete = p.route === "deleteMultiple";
  // The count first, before anything else can scroll it away (AC-45.5).
  ctx.io.err(`${p.op.key} on ${p.targets.length} records\n`);
  const permit = await confirmMutation(ctx, {
    operation: p.op.key,
    target: `${p.targets.length} records`,
    realTarget: p.targets.map(realKey).join(", "),
    url: target.url,
    destructive: isDelete,
    records: p.targets.map(realKey),
    ...(p.shownSetters !== undefined ? { changes: describeSetters(p.shownSetters) } : {}),
  });
  const audit = (t: OperationTarget, o: BulkOutcome, exitCode: number): void => {
    recordMutation(ctx, permit, o.ok ? { ok: true } : { ok: false, error: o.error ?? "", exitCode }, { realTarget: realKey(t), target: t.shown });
  };
  const request = { method: "POST" as const, path: bulkPath(p), rawBody: JSON.stringify(bulkBody(p, false)), lossless: true };

  if (p.route === "constructFromMany") {
    // One new entity from many records: a pack, not a stream.
    let response: unknown;
    try {
      response = (await target.http.request<unknown>(request)).body;
    } catch (err) {
      const failure = explainSendError(err, p.targets.some((t) => isHandle(t.shown)) ? `a record among the ${p.targets.length} was not found` : undefined);
      recordMutation(ctx, permit, failureOf(failure));
      throw failure;
    }
    recordMutation(ctx, permit, { ok: true });
    if (response === null || response === undefined || response === "") {
      ctx.io.err(`note: ${p.op.key} declined to construct anything; nothing was returned.\n`);
      return ExitCode.Ok;
    }
    if (!p.op.info.resultIsSaved) ctx.io.err(`note: ${p.op.key} returned a new ${p.op.type.name} that is NOT saved; nothing was stored.\n`);
    renderPack(ctx, response);
    return ExitCode.Ok;
  }

  const byKey = new Map(p.targets.map((t) => [recordKey(t.type, t.id), t]));
  const reported = new Map<string, BulkOutcome>();
  const writer = outcomeWriter(ctx, { ok: isDelete ? "deleted" : "ok", failed: "FAILED" });
  let unreadable = 0;
  let stoppedBy: "interrupt" | "transport" | undefined;
  let brokeOff = "";
  try {
    await interruptible(ctx, (signal) => target.http.requestLines({ ...request, signal }, (line) => {
      const read = readOutcomeLine(line);
      if (read === undefined) {
        unreadable++;
        return;
      }
      const t = byKey.get(read.key);
      if (t === undefined || reported.has(read.key)) return;
      const o: BulkOutcome = { target: t.shown, ok: read.ok, ...(read.error !== undefined ? { error: read.error } : {}) };
      reported.set(read.key, o);
      audit(t, o, ExitCode.PartialFailure);
      writer.add(o);
    }));
  } catch (err) {
    if (err instanceof InterruptedError) {
      stoppedBy = "interrupt";
    } else if (reported.size === 0) {
      // The request as a whole failed: every record in it did.
      const failure = explainSendError(err, p.targets.some((t) => isHandle(t.shown)) ? `a record among the ${p.targets.length} was not found` : undefined);
      for (const t of p.targets) recordMutation(ctx, permit, failureOf(failure), { realTarget: realKey(t), target: t.shown });
      throw failure;
    } else {
      stoppedBy = "transport";
      brokeOff = err instanceof Error ? err.message : String(err);
    }
  }

  // Silence is not success: a record the server never reported on is a failure that says why.
  const missing = stoppedBy === "interrupt" ? "interrupted before the server reported it; it may still have been processed"
    : stoppedBy === "transport" ? `${brokeOff}; check the record`
    : unreadable > 0 ? "no readable outcome: the server's answer was cut off or malformed; check the record"
    : "no outcome reported by the server";
  const all = p.targets.map((t) => {
    const key = recordKey(t.type, t.id);
    const known = reported.get(key);
    if (known !== undefined) return known;
    const o: BulkOutcome = { target: t.shown, ok: false, error: missing };
    audit(t, o, stoppedBy === "interrupt" ? ExitCode.Interrupted : ExitCode.PartialFailure);
    writer.add(o);
    return o;
  });
  writer.finish(all);
  if (stoppedBy === "interrupt") {
    ctx.io.err(`interrupted: the server reported ${reported.size} of ${p.targets.length} records before it was stopped.\n` +
      "It stops after the record in progress, which may have completed. Every outcome above is final.\n");
    return ExitCode.Interrupted;
  }
  return bulkExit(all);
}

/** Over many records `--edit` becomes setters; one-record checks do not apply. */
export function isBulkRequest(ctx: Ctx, targetCount: number): boolean {
  return targetCount > 1 || optAll(ctx, "setters-json").length > 0;
}
