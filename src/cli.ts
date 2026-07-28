/**
 * Entry point: dispatch, output wiring, error routing.
 *
 * STORY-09 (non-interactive by construction) · STORY-51 (agent gate) · STORY-63 (errors route to help)
 */

import { assertKnownFlags, parseArgs, type ParsedArgs } from "./core/args.ts";
import { CliError, ExitCode, UsageError, exitCodeOf } from "./core/errors.ts";
import { detectCallerContext, type CallerDetection } from "./core/caller.ts";
import { makeDataOpener, type DataWriter } from "./core/policy.ts";
import { parseMode, resolvePolicy, type PrivacyPolicy } from "./core/privacy.ts";
import { colorEnabled, effectiveFormat, renderDocument, type OutputFormat } from "./core/output.ts";
import {
  COMMANDS, TOPICS, findCommand, helpAsJson, renderCommand, renderOverview,
} from "./core/help.ts";
import { runVersion } from "./commands/version.ts";
import { runAuth } from "./commands/auth.ts";
import { runDiscover } from "./commands/discover.ts";
import { runQuery } from "./commands/query.ts";
import { runGet } from "./commands/get.ts";
import { runCache } from "./commands/cache.ts";
import { runUnmask } from "./commands/unmask.ts";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
}

export interface Ctx {
  args: ParsedArgs;
  io: Io;
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

function showHelp(args: ParsedArgs, io: Io): ExitCode {
  // Help is human-facing text, so prose is the default even when piped — unlike data
  // output, which switches to JSON off a TTY. Structured help must be asked for (AC-62.1).
  const explicit = args.flags.output;
  const asJson = explicit === "json" || explicit === "ndjson";
  const format: OutputFormat = asJson ? explicit : "table";

  const path = args.kind === "builtin" && args.command !== undefined && args.command !== "help"
    ? [args.command, ...args.positionals]
    : args.positionals;

  if (path.length > 0) {
    // QA fix: a multi-segment path (e.g. "auth login") can only mean a subcommand — topics
    // are always a single word — so try exact subcommand resolution FIRST. Previously topic
    // lookup used only path[0] and ran unconditionally, so "help auth login" silently dropped
    // "login" and rendered the "auth" topic instead of the login subcommand's own help, while
    // "auth login --help" (the other route to the same intent) worked correctly. The two
    // phrasings must agree.
    if (path.length > 1) {
      const exact = findCommand(path);
      if (exact !== undefined) {
        if (asJson) {
          renderDocument({ schemaVersion: 1, command: helpAsJson(exact) }, { format, write: io.out });
        } else {
          io.out(renderCommand(exact, path));
        }
        return ExitCode.Ok;
      }
    }

    const topicKey = (path[0] as string).toLowerCase();
    const topic = TOPICS[topicKey];
    if (topic !== undefined) {
      // A name can be BOTH a topic and a command — `auth` is. Render both, topic first: the
      // prose is the more useful lead, but stopping there meant `signum auth --help` showed no
      // subcommands, flags or examples, while `signum query --help` showed all three. AC-60.4
      // asks every command's help to carry runnable examples, so the command half is not
      // optional just because a topic outranks it.
      const alsoCommand = findCommand([topicKey]);
      if (asJson) {
        renderDocument(
          {
            schemaVersion: 1,
            topic: topicKey,
            text: topic,
            ...(alsoCommand !== undefined ? { command: helpAsJson(alsoCommand) } : {}),
          },
          { format, write: io.out },
        );
      } else {
        io.out(topic + "\n");
        if (alsoCommand !== undefined) io.out("\n" + renderCommand(alsoCommand, [topicKey]));
      }
      return ExitCode.Ok;
    }
    const spec = findCommand([path[0] as string]);
    if (spec !== undefined) {
      if (asJson) {
        // Structured help is SCOPED to what was asked for, not the whole tree.
        renderDocument({ schemaVersion: 1, command: helpAsJson(spec) }, { format, write: io.out });
      } else {
        io.out(renderCommand(spec, [path[0] as string]));
      }
      return ExitCode.Ok;
    }
    // Unknown topic/command asked of `help` is still a usage error (AC-60.3).
    throw new UsageError(`no help topic or command '${path.join(" ")}'`, {
      hint:
        "Commands: " + COMMANDS.map((c) => c.name).join(", ") + "\n" +
        "Topics:   " + Object.keys(TOPICS).join(", "),
    });
  }

  if (asJson) {
    renderDocument(helpAsJson(), { format, write: io.out });
    return ExitCode.Ok;
  }
  io.out(renderOverview());
  return ExitCode.Ok;
}

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const args = parseArgs(argv, io.env);
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

  const privacy = resolvePolicy({
    callerIsAgent: caller.context === "agent",
    requested: args.flags.pseudonymize !== undefined ? parseMode(args.flags.pseudonymize) : undefined,
    acknowledged: args.flags.allowAgentData,
    env: io.env,
    warn: (line) => io.err(line),
  });

  const ctx: Ctx = {
    args,
    io,
    format,
    color: colorEnabled(io.stdoutIsTty, args.flags.noColor, io.env),
    caller,
    // Pseudonymization active means an agent gets surrogates rather than a refusal (AC-51.4).
    openData: makeDataOpener(caller, args.flags.allowAgentData, io.out, privacy.mode !== "off"),
    privacy,
  };

  // `--help` anywhere, and bare invocation, both land on help (AC-60.1).
  if (args.kind === "none" || args.flags.help || args.command === "help") {
    return showHelp(args, io);
  }

  switch (args.kind) {
    case "builtin":
      switch (args.command) {
        case "version":
          assertKnownFlags(args, ["version"]);
          return await runVersion(ctx);
        case "auth": {
          // Validate against the SUBCOMMAND's flags once it's known to be a real one; an
          // invalid subcommand should get its own "unknown subcommand" error, not a flag one.
          const sub = args.positionals[0]?.toLowerCase();
          if (sub === "login" || sub === "status" || sub === "logout") {
            assertKnownFlags(args, ["auth", sub]);
          }
          return await runAuth(ctx);
        }
        case "types":
        case "queries":
        case "operations":
        case "explain":
          assertKnownFlags(args, [args.command]);
          return await runDiscover(ctx, args.command);
        case "query":
          assertKnownFlags(args, ["query"]);
          return await runQuery(ctx);
        case "get":
          assertKnownFlags(args, ["get"]);
          return await runGet(ctx);
        case "unmask":
          assertKnownFlags(args, ["unmask"]);
          return runUnmask(ctx);
        case "cache": {
          const sub = args.positionals[0]?.toLowerCase();
          if (sub === "show" || sub === "clear" || sub === "path") assertKnownFlags(args, ["cache", sub]);
          else assertKnownFlags(args, ["cache"]);
          return runCache(ctx);
        }
      }
      break;

    case "operation-key":
    case "verb-noun":
      throw new UsageError(
        `operations are not available in this milestone (m1 is read-only)`,
        {
          hint:
            `'${args.command}' looks like an operation. Invoking operations is m2 (REQ-040).\n` +
            "You can already discover them:\n" +
            "  signum operations [<Type>]      list invokable operations\n" +
            "  signum explain <OperationKey>   arguments and target kind",
        },
      );
  }

  throw new UsageError(`unknown command '${String(args.command)}'`, {
    hint: "Run `signum help` to see available commands.",
  });
}

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
  const io: Io = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    env: process.env,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
  };
  try {
    return await run(argv, io);
  } catch (err) {
    return report(err, io);
  }
}

// Bun sets import.meta.main for the entry module.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
