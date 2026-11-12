/**
 * The destructive-action guard (REQ-046, STORY-46) and the local record of what was mutated
 * (AC-46.6, AC-53.7).
 *
 * One implementation, at the mutation boundary, so a future command cannot forget it — the argument
 * the `DataWriter` brand settles for the privacy gate (AC-51.6). Sending a mutation needs a
 * `MutationPermit`, and `confirmMutation` is the only producer of one: the brand is a module-private
 * symbol, so no other module can build a permit without a cast, and `assertPermit` checks it at
 * runtime because TypeScript erases.
 *
 * The rules (AC-46.1 to AC-46.3):
 *   - `--yes` (or `-y`) confirms, in every context.
 *   - At a terminal, ask — naming the operation, the target and the application — and stop on
 *     anything but yes.
 *   - Anywhere else, fail. A script must never hang on a prompt it cannot answer, and must never
 *     mutate by default (STORY-09). An agent is "anywhere else".
 *   - A detected AI agent also needs its own acknowledgement, `--i-understand-an-agent-is-writing`
 *     or SIGNUM_ALLOW_AGENT_WRITES=1 (AC-46.7). `--yes` alone is something an agent types, and text
 *     planted in a row can talk it into typing it. The data acknowledgement does not stand in for
 *     this one: reading and changing are different decisions. Detection is spoofable, so this is a
 *     stricter default, not a boundary (AC-50.6).
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.ts";
import { flag, type Ctx } from "./ctx.ts";
import { CliError, ExitCode, PolicyError, UsageError } from "./errors.ts";

const PERMIT: unique symbol = Symbol("signum.mutationPermit");

/** Proof that this mutation was confirmed. Mintable only by `confirmMutation`. */
export interface MutationPermit {
  readonly operation: string;
  /** The target as the CALLER named it — a handle stays a handle. */
  readonly target: string;
  /** The real target, for the local record (AC-53.7). Never printed to a caller. */
  readonly realTarget: string;
  readonly url: string;
  readonly [PERMIT]: true;
}

export interface MutationDescription {
  operation: string;
  target: string;
  realTarget: string;
  url: string;
  /** A delete: the least reversible thing the CLI does, and the prompt says so (#118). */
  destructive?: boolean;
  /** How many records a bulk operation touches; the prompt names it (#119, AC-45.5). */
  count?: number;
}

/**
 * From this many records a bare y/N is not enough: the count must be typed back (AC-46.5). A delete
 * of more than one record needs it at any size, because nothing about it can be undone.
 */
export const TYPED_CONFIRMATION_FROM = 10;

/** Ask, or refuse, before anything that changes the application. */
export async function confirmMutation(ctx: Ctx, m: MutationDescription): Promise<MutationPermit> {
  const permit: MutationPermit = {
    operation: m.operation, target: m.target, realTarget: m.realTarget, url: m.url, [PERMIT]: true,
  };

  // Before --yes, so an agent is told what it is missing whichever flags it passed.
  if (ctx.caller.context === "agent" && !ctx.args.flags.allowAgentWrites) {
    throw new PolicyError(`refusing to let a detected AI caller run ${m.operation}`, {
      hint:
        "Signals: " + ctx.caller.signals.join("; ") + ".\n" +
        "Nothing was sent. Changing data from an agent needs its own acknowledgement, separate\n" +
        "from the one for reading data:\n" +
        "  --i-understand-an-agent-is-writing   or   SIGNUM_ALLOW_AGENT_WRITES=1\n" +
        "--dry-run and --explain need neither: they change nothing.",
    });
  }
  if (flag(ctx, "yes") || flag(ctx, "y")) return permit;

  // A prompt needs a terminal on both ends: one to show it, one to answer it.
  if (!ctx.io.stdoutIsTty || ctx.io.prompt === undefined) {
    throw new UsageError(`refusing to run ${m.operation} on ${m.count !== undefined && m.count > 1 ? `${m.count} records` : m.target} without --yes`, {
      hint:
        "There is no terminal to confirm at, so nothing was sent. A command that changes data never\n" +
        "runs by default from a script or an agent. Check it first with --dry-run, then pass --yes.",
    });
  }

  // Show the real target: this is a person at their own terminal, and the wrong record is the
  // mistake a confirmation exists to catch. The URL is there for the wrong-environment mistake.
  const count = m.count ?? 1;
  if (count > 1) {
    const shown = m.realTarget.split(", ");
    const listed = shown.slice(0, 5).join(", ") + (shown.length > 5 ? `, … (${shown.length - 5} more)` : "");
    const typed = count >= TYPED_CONFIRMATION_FROM || m.destructive === true;
    const question = `${m.destructive === true ? "DELETE" : "Run " + m.operation + " on"} ${count} records at ${m.url}: ${listed}` +
      (m.destructive === true ? ". This cannot be undone." : ".") +
      (typed ? ` Type ${count} to confirm: ` : " [y/N] ");
    const answer = (await ctx.io.prompt(question)).trim();
    if (typed ? answer !== String(count) : !/^y(es)?$/i.test(answer)) {
      throw new CliError("not confirmed; nothing was sent", ExitCode.Usage);
    }
    return permit;
  }
  const answer = await ctx.io.prompt(m.destructive === true
    ? `DELETE ${m.realTarget} with ${m.operation} at ${m.url}? This cannot be undone. [y/N] `
    : `Run ${m.operation} on ${m.realTarget} at ${m.url}? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError("not confirmed; nothing was sent", ExitCode.Usage);
  }
  return permit;
}

/** The runtime half of the brand, for the code that sends. */
export function assertPermit(p: unknown): asserts p is MutationPermit {
  if (p === null || typeof p !== "object" || (p as Partial<MutationPermit>)[PERMIT] !== true) {
    throw new CliError(
      "internal: attempted a mutation without confirmation",
      ExitCode.Unexpected,
      { hint: "This is a bug in signum — a mutation must be confirmed via confirmMutation (REQ-046)." },
    );
  }
}

/** `<config-dir>/audit.log`: one JSON line per mutation attempt, 0600 beside the credential. */
export function auditLogPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "audit.log");
}

/**
 * Record a mutation and how it ended (AC-46.6), with the REAL target behind a handle (AC-53.7), so an
 * operator can reconstruct what an agent acted on. No credential, no request body, no response:
 * what was run, on what, where, when, and the outcome.
 *
 * It is a store of identities at rest, like the handle store, and lives beside it with the same
 * protection. A failure to write it must not turn a mutation that happened into a reported failure,
 * so it warns instead.
 */
export function recordMutation(
  ctx: Ctx,
  permit: MutationPermit,
  outcome: { ok: true } | { ok: false; error: string; exitCode: number },
  /** One record of a bulk operation, logged on its own line so each outcome is reconstructable. */
  record?: { realTarget: string; target: string },
): void {
  const path = auditLogPath(ctx.io.env);
  const line = JSON.stringify({
    time: new Date().toISOString(),
    url: permit.url,
    operation: permit.operation,
    target: record?.realTarget ?? permit.realTarget,
    caller: ctx.caller.context,
    ...((record?.target ?? permit.target) !== (record?.realTarget ?? permit.realTarget) ? { via: record?.target ?? permit.target } : {}),
    ...outcome,
  }) + "\n";
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (err) {
    ctx.io.err(`warning: could not write the audit log ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
