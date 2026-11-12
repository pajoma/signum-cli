/**
 * Echo the invocation instead of the data — REQ-078 (#90) · STORY-53 · AC-53.9 · ADR 0009 Decision 2.
 *
 * An agent composes a query, then prints the exact command for a **human** to run rather than
 * reading the rows itself. The human runs it in their own terminal, where the caller context is
 * `interactive` and no gate applies.
 *
 * This is the sound half of "pipe the output, or print the command". An agent that can pipe real
 * values has not been constrained at all — the pseudonymization would be theatre. Printing the
 * command keeps the agent useful (it composed the query and can explain the intent) while the values
 * never enter its context.
 *
 * **One command, not a script** — ADR 0009 open question 2, decided here. The whole value is that a
 * human can read it before running it, and a script trades that away for convenience. An agent that
 * needs several steps emits several commands, each inspectable on its own.
 *
 * Two things are deliberately absent from the output:
 *   • any credential — REQ-074, no exceptions, and there is nothing to include anyway since the
 *     token is never an argument (AC-12.1)
 *   • anything resolved from a `ref:` handle. The echo reproduces the arguments AS GIVEN, so a handle
 *     stays a handle and the human's own run resolves it locally (AC-53.3)
 */

import type { Ctx } from "./ctx.ts";

/** Flags that must never appear in the echo, with the reason each is dropped. */
const OMITTED_BOOLEANS = new Set([
  // Asking for the echo is not part of the command being echoed.
  "as-command",
]);

const OMITTED_GLOBALS = new Set([
  // A human at a terminal needs neither, and echoing them would tell them to assert something
  // about themselves that is not true.
  "i-understand-data-goes-to-a-model",
  "i-understand-an-agent-is-writing",
  "caller-context",
]);

/**
 * Quote one argument so the line runs verbatim.
 *
 * Double quotes rather than POSIX single quotes, deliberately: `"State = Shipped"` works unchanged in
 * bash, zsh, cmd.exe and PowerShell, and the common case — a filter expression containing spaces —
 * needs nothing more. A value containing a double quote, backslash, backtick or `$` cannot be quoted
 * portably, so those fall back to POSIX single-quoting and the caller is told (see `echoCommand`).
 */
function quote(arg: string): { text: string; posixOnly: boolean } {
  if (arg === "") return { text: '""', posixOnly: false };
  if (!/[\s"'`$\\|&;<>()*?\[\]{}!#~]/.test(arg)) return { text: arg, posixOnly: false };
  if (!/["`$\\]/.test(arg)) return { text: `"${arg}"`, posixOnly: false };
  return { text: `'${arg.replaceAll("'", `'\\''`)}'`, posixOnly: true };
}

export interface EchoInput {
  command: string;
  positionals: readonly string[];
  /** Typed global flags, already parsed. */
  url: string | undefined;
  output: string | undefined;
  offline: boolean;
  timeoutMs: number | undefined;
  pseudonymize: string | undefined;
  verbose: boolean;
  noColor: boolean;
  /** Repeatable/other options, as parsed. */
  options: ReadonlyMap<string, readonly string[]>;
  booleans: ReadonlySet<string>;
  /** True when --url was NOT given explicitly, so it came from the environment or a credential. */
  urlWasImplicit: boolean;
  /** The instance name, when one was typed — echoed instead of the URL it resolved to. */
  instance?: string | undefined;
}

export interface Echo {
  /** The command line, runnable verbatim. */
  command: string;
  /** Set when an argument could only be quoted POSIX-style, so cmd.exe/PowerShell would differ. */
  posixOnly: boolean;
}

/**
 * Rebuild the caller's own invocation.
 *
 * Reproducing what was given — rather than what was resolved — is what makes this inspectable: a
 * human reading the line sees the request they were asked to run, not a rewritten version of it.
 * `--url` is included only when it was passed explicitly; when it came from the environment or a
 * stored credential the human's shell already has it, and printing a customer's hostname that nobody
 * asked for is gratuitous.
 */
export function echoCommand(input: EchoInput): Echo {
  const parts: string[] = ["signum", input.command];
  let posixOnly = false;

  const push = (raw: string) => {
    const q = quote(raw);
    if (q.posixOnly) posixOnly = true;
    parts.push(q.text);
  };

  for (const p of input.positionals) push(p);

  if (input.instance !== undefined) { parts.push("-i"); push(input.instance); }
  else if (input.url !== undefined && !input.urlWasImplicit) { parts.push("--url"); push(input.url); }

  // Repeatable options in the order given, so a multi-filter query reads as the caller wrote it.
  for (const [name, values] of input.options) {
    if (OMITTED_GLOBALS.has(name)) continue;
    for (const v of values) { parts.push(`--${name}`); push(v); }
  }

  for (const b of input.booleans) {
    if (OMITTED_BOOLEANS.has(b) || OMITTED_GLOBALS.has(b)) continue;
    parts.push(`--${b}`);
  }

  if (input.output !== undefined) { parts.push("--output"); push(input.output); }
  if (input.offline) parts.push("--offline");
  if (input.verbose) parts.push("--verbose");
  if (input.noColor) parts.push("--no-color");
  if (input.timeoutMs !== undefined) { parts.push("--timeout"); push(String(input.timeoutMs / 1000)); }
  if (input.pseudonymize !== undefined) { parts.push("--pseudonymize"); push(input.pseudonymize); }

  return { command: parts.join(" "), posixOnly };
}

/**
 * Print the caller's own invocation for a human to run, and nothing else (REQ-078, AC-53.9).
 *
 * Goes to STDOUT through the ordinary writer, not the gated one: a command line is not data. That is
 * the whole point — an agent can produce this under any policy, because there is nothing in it to
 * protect. The credential is never an argument (AC-12.1), and arguments are echoed as GIVEN, so a
 * `ref:` handle stays a handle for the human's run to resolve locally.
 */
export function emitCommandEcho(ctx: Ctx): void {
  const echo = echoCommand({
    command: String(ctx.args.command),
    positionals: ctx.args.positionals,
    url: ctx.args.flags.url,
    urlWasImplicit: !ctx.args.rawFlagNames.has("url"),
    // Typed only: one from SIGNUM_INSTANCE is already in the human's environment, like SIGNUM_URL.
    instance: ctx.args.rawFlagNames.has("instance") || ctx.args.rawFlagNames.has("i") ? ctx.args.flags.instance : undefined,
    output: ctx.args.flags.output,
    offline: ctx.args.flags.offline,
    timeoutMs: ctx.args.flags.timeoutMs,
    pseudonymize: ctx.args.flags.pseudonymize,
    verbose: ctx.args.flags.verbose,
    noColor: ctx.args.flags.noColor,
    options: ctx.args.options,
    booleans: ctx.args.booleans,
  });

  ctx.io.out(echo.command + "\n");
  if (echo.posixOnly) {
    // Honesty beats a line that silently breaks in cmd.exe (AC-53.9's "runs verbatim").
    ctx.io.err(
      "note: an argument needed POSIX single-quoting, so this line is for a POSIX shell.\n" +
      "In cmd.exe or PowerShell the quoting will differ.\n",
    );
  }
}
