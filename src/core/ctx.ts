/**
 * The contract between the entry point and every command: the injected I/O and the per-invocation
 * context. Lives in core/ rather than cli.ts so commands depend on a stable type, not on the
 * dispatcher that imports them all (#124).
 */

import { flagCheckPath, type ParsedArgs } from "./args.ts";
import { knownFlagNames } from "./help.ts";
import type { CallerDetection } from "./caller.ts";
import type { DataWriter } from "./policy.ts";
import type { PrivacyPolicy } from "./privacy.ts";
import type { OutputFormat } from "./output.ts";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  /**
   * Ask the person at the terminal something. `hidden` suppresses echo, for a credential.
   *
   * Absent when there is nothing to ask — no TTY, or a test that has not opted in — so every caller
   * must handle its absence rather than assume an interactive human is there (STORY-09: never hang
   * waiting for input that cannot arrive).
   */
  prompt?: ((question: string, opts?: { hidden?: boolean }) => Promise<string>) | undefined;
  /**
   * Run `handler` on the caller's interrupt (Ctrl-C) instead of dying at once, until the returned
   * function is called. For a request whose server keeps working: what it already did must still be
   * reported and logged (AC-45.6). Absent where nothing can interrupt.
   */
  onInterrupt?: ((handler: () => void) => () => void) | undefined;
}

export interface Ctx {
  args: ParsedArgs;
  io: Io;
  /**
   * The target application's URL, resolved once (REQ-001, AC-05.2): `--url` or `-i`, then
   * SIGNUM_URL or SIGNUM_INSTANCE, then the default target (`auth switch`, else the latest login).
   * Undefined when none applies. Everything kept per target — the handle store, the surrogates —
   * is keyed by it, so one run never mixes two applications.
   */
  target: string | undefined;
  format: OutputFormat;
  color: boolean;
  caller: CallerDetection;
  /**
   * Open stdout for server DATA (rows, entities, field values) — AC-51.1. Applies the ADR 0007
   * gate and throws `PolicyError` under a detected agent without an explicit acknowledgement;
   * m1 has no pseudonymization engine, so stopping is the honest behaviour.
   *
   * This is the data-output boundary, not a convention (Brooks review M3): `renderResultTable`
   * and `renderDataDocument` accept only the `DataWriter` it returns, so a new command cannot
   * emit rows by forgetting a call — it would have to reach for `unsafeDataWriter` and say why.
   * Calling it is side-effect-free, so call it early too, before the network round trip, so a
   * refusal costs no request. `--explain` emits no data and is exempt.
   */
  openData: (what: string) => DataWriter;
  /**
   * The effective pseudonymization policy (REQ-057). Resolved once, from the profile and the caller
   * context — never from something the caller passed, except that a caller may tighten it
   * (ADR 0009 Decision 1).
   */
  privacy: PrivacyPolicy;
}

/**
 * The flag name, after checking the command declares it in help.ts (#124). A misspelt name in
 * command code would otherwise read as "not passed" forever; this turns it into a loud failure the
 * first time a test exercises that path. Unknown flags from the USER are rejected earlier, by
 * `assertKnownFlags` — this guards the code, not the caller.
 */
function declared(ctx: Ctx, name: string): string {
  const command = ctx.args.command;
  if (ctx.args.kind !== "builtin" || command === undefined) return name;
  const path = flagCheckPath(command, ctx.args.positionals[0]);
  if (path !== undefined && !knownFlagNames(path).has(name)) {
    throw new Error(`internal: --${name} is read but not declared for '${path.join(" ")}' in help.ts`);
  }
  return name;
}

/** Single option value, or undefined. */
export function opt(ctx: Ctx, name: string): string | undefined {
  const list = ctx.args.options.get(declared(ctx, name));
  return list?.[list.length - 1];
}

/** All values of a repeatable option, in order. */
export function optAll(ctx: Ctx, name: string): string[] {
  return ctx.args.options.get(declared(ctx, name)) ?? [];
}

export function flag(ctx: Ctx, name: string): boolean {
  return ctx.args.booleans.has(declared(ctx, name));
}

/**
 * Run `work` with Ctrl-C turned into an abort of its request instead of the death of the process,
 * so what the server already did can still be reported and logged (AC-45.6), and what was already
 * written can be closed so it stays valid (AC-23.5). A second Ctrl-C is
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
