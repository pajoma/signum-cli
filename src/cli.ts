/**
 * Entry point: dispatch, output wiring, error routing.
 *
 * STORY-09 (non-interactive by construction) · STORY-51 (agent gate) · STORY-63 (errors route to help)
 */

import { assertFormatSupported, assertKnownFlags, BUILT_INS, declaredFlagsFor, flagCheckPath, parseArgs, type ParsedArgs } from "./core/args.ts";
import { nearest } from "./core/text.ts";
import { CliError, ExitCode, NotFoundError, UsageError, exitCodeOf } from "./core/errors.ts";
import { detectCallerContext } from "./core/caller.ts";
import { assertMayTrace, makeDataOpener } from "./core/policy.ts";
import { parseMode, resolvePolicy } from "./core/privacy.ts";
import { colorEnabled, effectiveFormat, type OutputFormat } from "./core/output.ts";
import { assertNoUserInfo, resolveInstance } from "./core/instances.ts";
import { defaultCredentialUrl } from "./core/credentials.ts";
import { Explained } from "./core/http.ts";
import { applicationSubject, showApplicationHelp, showHelp } from "./commands/help.ts";
import { runVersion } from "./commands/version.ts";
import { runAuth } from "./commands/auth.ts";
import { runDiscover } from "./commands/discover.ts";
import { runQuery } from "./commands/query.ts";
import { runGet } from "./commands/get.ts";
import { runCache } from "./commands/cache.ts";
import { runInstance } from "./commands/instance.ts";
import { runUnmask } from "./commands/unmask.ts";
import { runOperation } from "./commands/operate.ts";
import { terminalIo } from "./terminal.ts";
import type { Ctx, Io } from "./core/ctx.ts";


export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const args = parseArgs(argv, io.env);
  try {
    return await runParsed(args, io);
  } catch (err) {
    // `--explain` showed the request the command was about to send, and nothing was sent (REQ-053).
    if (err instanceof Explained) return ExitCode.Ok;
    // The one place that knows how the user named the target, so a login hint raised anywhere
    // below is worded for it here (`-i <name>` when an instance was given).
    if (err instanceof CliError) err.namingInstance(args.flags.instance);
    throw err;
  }
}

async function runParsed(args: ParsedArgs, io: Io): Promise<ExitCode> {
  const format = effectiveFormat(args.flags.output, io.stdoutIsTty);

  const caller = detectCallerContext({
    override: args.flags.callerContext,
    env: io.env,
    stdoutIsTty: io.stdoutIsTty,
  });
  // Loosening detection is a deliberate act and is logged (AC-50.4).
  if (caller.loosened) {
    io.err(`warning: caller context loosened to '${caller.context}' by override\n`);
  }

  // Help FIRST, before anything reads configuration. AC-60.2 promises static help works with no
  // config at all, and resolving the privacy policy here meant `signum help` stat-ed and read
  // privacy.json — and a malformed one printed "warning: could not read …" over plain help.
  // Nothing above this line touches the filesystem.
  if (args.kind === "none" || args.flags.help || args.command === "help") {
    // A query or an operation is described from the application too (STORY-61); the rest of help
    // reads nothing, and only naming a subject makes it look further.
    const subject = applicationSubject(args);
    if (subject === undefined) return showHelp(args, io);
    // Describing a subject sends requests, and one carries the real id behind a handle (an operation's
    // entity pack), so its trace is gated as any command's is (#128).
    if (args.flags.verbose) assertMayTrace(caller, args.flags.allowAgentData);
    return await showApplicationHelp(args, io, subject, (helpArgs) => contextFor(helpArgs, io, caller, format));
  }

  // Before any request is made, so a refused trace never prints a line (#128).
  if (args.flags.verbose) assertMayTrace(caller, args.flags.allowAgentData);

  const ctx = contextFor(args, io, caller, format);

  switch (args.kind) {
    case "builtin": {
      const handler = args.command !== undefined ? HANDLERS[args.command] : undefined;
      if (handler === undefined) break;
      // Validate against the SUBCOMMAND's flags once it's known to be a real one; an invalid
      // subcommand should get its own "unknown subcommand" error, not a flag one.
      const path = flagCheckPath(args.command as string, args.positionals[0]);
      if (path !== undefined) {
        assertKnownFlags(args, path);
        assertFormatSupported(args, path);
      }
      return await handler(ctx, args.command as string);
    }

    case "operation-key":
    case "verb-noun": {
      // A MISTYPED built-in reaches here, because dispatch rule 3 treats anything unrecognised as a
      // verb-noun operation. Telling someone who typed `typs` about m2 operation keys is a lecture
      // about the wrong subject — and flags already get edit-distance suggestions, so the machinery
      // and the expectation both existed. Check for a near-miss before assuming intent.
      const typed = String(args.command).toLowerCase();

      // A RENAMED command is not a typo — no edit distance connects `de-pseudonymize` to `unmask` —
      // so the only way to help someone with the old name in muscle memory is to say so. One entry
      // per rename, removable once nobody could plausibly still be typing it.
      const renamed = RENAMED_COMMANDS[typed];
      if (renamed !== undefined) {
        throw new UsageError(`'${typed}' was renamed to '${renamed}'`, {
          hint: `Run \`signum ${renamed}\` instead. See \`signum ${renamed} --help\`.`,
        });
      }

      // An operation (REQ-040, REQ-041): resolved against metadata, confirmed, then sent. A near
      // built-in is the fallback, not the first answer: `set` is one edit from `get`, and an app's
      // `Set` operation must not be refused as a typo before metadata is even read.
      const near = args.kind === "verb-noun" ? nearest(typed, BUILT_INS) : undefined;
      const typo = near === undefined ? undefined : new UsageError(`unknown command '${String(args.command)}'`, {
        hint: `Did you mean \`signum ${near}\`?\nRun \`signum help\` to see every command.`,
      });
      // With no noun it cannot be an operation, so answer at once, without a network round trip.
      if (typo !== undefined && args.positionals.length === 0) throw typo;
      try {
        return await runOperation(ctx);
      } catch (err) {
        if (typo !== undefined && (err instanceof UsageError || err instanceof NotFoundError)) throw typo;
        throw err;
      }
    }
  }

  throw new UsageError(`unknown command '${String(args.command)}'`, {
    hint: "Run `signum help` to see available commands.",
  });
}

/** Everything a command reads: the target, the privacy policy, the data gate. Reads configuration. */
function contextFor(args: ParsedArgs, io: Io, caller: Ctx["caller"], format: OutputFormat): Ctx {
  // After help, which must not read configuration (AC-60.2). The parsed flags stay as typed; the
  // resolved URL goes into the context, where commands read it.
  const named = args.flags.instance !== undefined ? resolveInstance(args.flags.instance, io.env) : args.flags.url;
  // --url, SIGNUM_URL and a registered instance alike: a credential in the URL leaks everywhere.
  if (named !== undefined) assertNoUserInfo(named);

  // The target, once, before anything that is kept per target is read (#121).
  const target = named ?? defaultCredentialUrl(io.env);

  const privacy = resolvePolicy({
    callerIsAgent: caller.context === "agent",
    target,
    requested: args.flags.pseudonymize !== undefined ? parseMode(args.flags.pseudonymize) : undefined,
    acknowledged: args.flags.allowAgentData,
    env: io.env,
    warn: (line) => io.err(line),
  });

  return {
    args,
    io,
    named,
    target,
    format,
    color: colorEnabled(io.stdoutIsTty, args.flags.noColor, io.env),
    caller,
    // Pseudonymization active means an agent gets surrogates rather than a refusal (AC-51.4).
    openData: makeDataOpener(caller, args.flags.allowAgentData, io.out, privacy.mode !== "off"),
    privacy,
    declaredFlags: declaredFlagsFor(args),
  };
}





type Handler = (ctx: Ctx, command: string) => Promise<ExitCode> | ExitCode;

/**
 * One entry per built-in except `help`, which is answered before any configuration is read. A test
 * pins these keys to `COMMANDS`, so a command cannot be declared without being dispatched (#124).
 */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  version: (ctx) => runVersion(ctx),
  auth: (ctx) => runAuth(ctx),
  types: (ctx) => runDiscover(ctx, "types"),
  queries: (ctx) => runDiscover(ctx, "queries"),
  operations: (ctx) => runDiscover(ctx, "operations"),
  explain: (ctx) => runDiscover(ctx, "explain"),
  query: (ctx) => runQuery(ctx),
  get: (ctx) => runGet(ctx),
  unmask: (ctx) => runUnmask(ctx),
  cache: (ctx) => runCache(ctx),
  instance: (ctx) => runInstance(ctx),
};

/**
 * Commands that used to exist under another name.
 *
 * Kept deliberately small and dated: an alias map that grows without pruning becomes a museum. This
 * one exists because `de-pseudonymize` -> `unmask` (2026-07-28) happened before release, so nobody
 * has it in a script — only in their fingers.
 */
const RENAMED_COMMANDS: Readonly<Record<string, string>> = {
  "de-pseudonymize": "unmask",
};

function report(err: unknown, io: Io): ExitCode {
  const code = exitCodeOf(err);
  if (err instanceof CliError) {
    io.err(`error: ${err.message}\n`);
    if (err.hint !== undefined) io.err(err.hint.replace(/\n?$/, "\n"));
  } else {
    const message = err instanceof Error ? err.message : String(err);
    io.err(`error: ${message}\n`);
    io.err("This is an unexpected failure; please report it.\n");
  }
  return code;
}



export async function main(argv: readonly string[]): Promise<number> {
  const io = terminalIo();
  try {
    return await run(argv, io);
  } catch (err) {
    return report(err, io);
  }
}

// Bun sets import.meta.main for the entry module.
if (import.meta.main) {
  // Not process.exit(): stdout to a pipe is written asynchronously, and exiting at once kept only
  // the first 64 KiB (#151). A write callback does not help either: Bun calls it before the bytes
  // reach the pipe. Ending the process naturally lets pending writes drain first.
  process.exitCode = await main(process.argv.slice(2));
}
