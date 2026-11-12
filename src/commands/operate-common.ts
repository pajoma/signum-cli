/**
 * What running an operation on one record and on many have in common: how a record is named and
 * recognised, how args and edits are read, how permission is asked, how a failure is worded and
 * logged, and how a returned entity is shown. `operate.ts` is the one-record path and the entry
 * point; `operate-bulk.ts` is the many-record path (#119). Both use these, so a rule here changes
 * for both at once (Brooks review of #162).
 */

import type { Ctx } from "../core/ctx.ts";
import { flag, optAll } from "../core/ctx.ts";
import { CliError, ExitCode, NotAuthorizedError, NotFoundError, UsageError } from "../core/errors.ts";
import { asEntity, type MemberPath } from "../core/entity.ts";
import { loadHandles, persistHandles } from "../core/handles.ts";
import { JsonNumber } from "../core/json.ts";
import { encodeArgs, type ArgValue } from "../core/operations.ts";
import { renderDataDocument } from "../core/output.ts";
import { disclosure, pseudonymizeDocument } from "../core/privacy.ts";
import { isHandle } from "../core/reidentify.ts";
import type { Target } from "../core/target.ts";

export const DATA_KIND = "operation result";

/** The record an operation runs on, as the caller named it and as it really is. */
export interface OperationTarget {
  type: string;
  id: string;
  /** As written: a handle stays a handle in everything shown to a caller. */
  shown: string;
}

export type Edit = { path: MemberPath; value: ArgValue; written: string };

/** `--edit Member.Path=value`: the path addresses members, `entity`, and list indices (AC-31.7). */
export function parseEdits(ctx: Ctx): Edit[] {
  return optAll(ctx, "edit").map((written) => {
    const eq = written.indexOf("=");
    if (eq <= 0) throw new UsageError(`--edit '${written}' needs a member and a value`, { hint: "--edit Name=Acme  or  --edit Address.City=Berlin" });
    const path = written.slice(0, eq).split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const raw = written.slice(eq + 1);
    // The same scalar inference as --arg, and no more: an edit sets one value.
    const value: ArgValue = raw === "null" ? null
      : raw === "true" ? true
      : raw === "false" ? false
      : /^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw) ? new JsonNumber("number", raw)
      : raw;
    return { path, value, written };
  });
}

export function cleanName(typeName: string): string {
  return typeName.replace(/Entity$/, "");
}

/** `type;id`, case-folded: how a record is recognised again, in the targets and in the server's answer. */
export function recordKey(type: string, id: string): string {
  return `${cleanName(type).toLowerCase()};${id}`;
}

/** The record as `Type;id`, for the local record and a person's confirmation — never for an agent. */
export function realKey(t: OperationTarget): string {
  return `${cleanName(t.type)};${t.id}`;
}

export function liteJson(t: OperationTarget): Record<string, unknown> {
  return { EntityType: cleanName(t.type), id: /^\d+$/.test(t.id) ? new JsonNumber("identifier", t.id) : t.id };
}

/** What the target looks like in the request, with a handle in place of the id it stands for. */
export function shownTarget(t: OperationTarget): Record<string, unknown> {
  return { ...liteJson(t), ...(isHandle(t.shown) ? { id: t.shown } : {}) };
}

/** The positional args, in the order typed (AC-42.1). */
export function argsOf(ctx: Ctx): ArgValue[] | null {
  return encodeArgs(ctx.args.sequence, {
    handles: loadHandles(ctx.io.env, ctx.target),
    allowCustomObjects: flag(ctx, "allow-custom-arg"),
    warn: (line) => ctx.io.err(line),
  });
}

/** Whether `canExecute` permits `key`, and the server's reason when not. */
export function permission(canExecute: Record<string, unknown>, key: string): { ok: boolean; reason?: string } {
  // A key ABSENT was withheld for this login (`OperationLogic.cs:456`): not permitted, never unknown (#112).
  if (!Object.hasOwn(canExecute, key)) return { ok: false, reason: "not permitted for this login; the server gives no reason" };
  const r = canExecute[key];
  return r === null || r === undefined || r === "" ? { ok: true } : { ok: false, reason: String(r) };
}

/** The `canExecute` of a stored record's entity pack. A read: nothing is invoked. */
export async function packCanExecute(target: Target, t: OperationTarget): Promise<Record<string, unknown>> {
  const res = await target.http.request<unknown>({
    method: "GET",
    path: `api/entityPack/${encodeURIComponent(cleanName(t.type))}/${encodeURIComponent(t.id)}`,
    lossless: true,
    prepare: true, // a dry run's permission read: it composes with --explain (AC-43.6)
  });
  return (((res.body ?? {}) as Record<string, unknown>)["canExecute"] ?? {}) as Record<string, unknown>;
}

/** `EntityPackTS` → the entity, pseudonymized like `get`, beside its new `canExecute`. */
export function renderPack(ctx: Ctx, pack: unknown): void {
  const o = (pack ?? {}) as Record<string, unknown>;
  const entity = o["entity"] !== undefined && o["entity"] !== null ? asEntity(o["entity"]) : null;
  const { value, pseudonymized, handleDetails } = pseudonymizeDocument(entity, ctx.privacy);
  persistHandles(ctx, handleDetails); // before emitting — see the note in query.ts
  renderDataDocument({ entity: value, canExecute: o["canExecute"] ?? {} }, {
    format: ctx.format === "table" ? "json" : ctx.format,
    write: ctx.openData(DATA_KIND),
  });
  const note = disclosure(ctx.privacy, pseudonymized);
  if (note !== "") ctx.io.err("\n" + note);
}

/**
 * A failed send, said in the CLI's terms. A 403 may mean the operation is hidden from the UI: the
 * server judges every call as if the UI made it (`OperationController.cs:137`), so such an operation
 * cannot be invoked over the API at all (AC-40.5). A not-found reached through a handle must not
 * spell out the id behind it, so it is replaced by `hiddenNotFound` when one is given (AC-53.2).
 */
export function explainSendError(err: unknown, hiddenNotFound: string | undefined): unknown {
  if (err instanceof NotAuthorizedError) {
    return new NotAuthorizedError(`not permitted: ${err.message}`, {
      hint: "This login may not run it on this record, or the operation is hidden from the UI —\n" +
        "the API invokes only what the UI may (OperationController.cs:137). Check with --dry-run.",
    });
  }
  if (err instanceof NotFoundError && hiddenNotFound !== undefined) return new NotFoundError(hiddenNotFound);
  return err;
}

/** The audit outcome of a failure. */
export function failureOf(err: unknown): { ok: false; error: string; exitCode: number } {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    exitCode: err instanceof CliError ? err.exitCode : ExitCode.Unexpected,
  };
}

/**
 * Run `work` with Ctrl-C turned into an abort of its request instead of the death of the process,
 * so what the server already did can still be reported and logged (AC-45.6). A second Ctrl-C is
 * the default again: whoever presses it twice means it.
 */
export async function interruptible<T>(ctx: Ctx, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  release = ctx.io.onInterrupt?.(() => {
    release?.();
    release = undefined;
    controller.abort();
  });
  try {
    return await work(controller.signal);
  } finally {
    release?.();
  }
}
