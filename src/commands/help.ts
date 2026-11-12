/**
 * `signum help`, and `--help` on anything (STORY-60, STORY-61, STORY-62).
 *
 * Static help reads no configuration at all (AC-60.2). A named query or operation is also described
 * as the target application has it (STORY-61), through a context the entry point builds only then.
 */

import { assertFormatSupported, type ParsedArgs } from "../core/args.ts";
import { CliError, ExitCode, UsageError } from "../core/errors.ts";
import { renderDocument, type OutputFormat } from "../core/output.ts";
import {
  COMMANDS, TOPICS, findCommand, helpAsJson, renderCommand, renderOverview, topicNames, type AppHelp,
} from "../core/help.ts";
import type { Ctx, Io } from "../core/ctx.ts";
import { describeQuery } from "./discover.ts";
import { describeOperation } from "./operate.ts";

export function showHelp(args: ParsedArgs, io: Io): ExitCode {
  // Help is human-facing text, so prose is the default even when piped — unlike data
  // output, which switches to JSON off a TTY. Structured help must be asked for (AC-62.1).
  // Help is a document whatever it describes, so csv, tsv and name are refused as anywhere else.
  assertFormatSupported(args, ["help"]);
  const explicit = args.flags.output;
  const asJson = explicit === "json" || explicit === "ndjson";
  const format: OutputFormat = asJson ? explicit : "table";

  // `signum ship order --help`: an operation's help is the operations topic (STORY-41).
  if (args.kind === "operation-key" || args.kind === "verb-noun") {
    if (asJson) renderDocument({ schemaVersion: 1, topic: "operations", text: TOPICS["operations"] }, { format, write: io.out });
    else io.out(TOPICS["operations"] + "\n");
    return ExitCode.Ok;
  }

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
        "Topics:   " + topicNames().join(", "),
    });
  }

  if (asJson) {
    renderDocument(helpAsJson(), { format, write: io.out });
    return ExitCode.Ok;
  }
  io.out(renderOverview());
  return ExitCode.Ok;
}

export type Subject = { kind: "query"; key: string } | { kind: "operation" };

/** `query <key> --help`, `help query <key>`, or an operation's `--help`: help with an application half. */
export function applicationSubject(args: ParsedArgs): Subject | undefined {
  if (args.kind === "operation-key" || args.kind === "verb-noun") return { kind: "operation" };
  const path = args.command === "help" ? args.positionals : [args.command ?? "", ...args.positionals];
  if (path[0]?.toLowerCase() === "query" && path[1] !== undefined) return { kind: "query", key: path[1] };
  return undefined;
}

/**
 * The static help, then what the application says about the subject (AC-61.1, AC-61.2), from the
 * cache when it can (AC-61.3). Help never fails for want of an application: without one, or without
 * the metadata, the static part is printed with one line saying what could not be described and how
 * to fix it, and the exit is 0 (AC-61.5).
 */
export async function showApplicationHelp(args: ParsedArgs, io: Io, subject: Subject, context: (args: ParsedArgs) => Ctx): Promise<ExitCode> {
  const asJson = args.flags.output === "json" || args.flags.output === "ndjson";
  const named = subject.kind === "query" ? `query ${subject.key}` : `${String(args.command)}${args.kind === "verb-noun" && args.positionals[0] !== undefined ? ` ${args.positionals[0]}` : ""}`;
  let described: AppHelp | undefined;
  let unavailable: string | undefined;
  let remedy = "name the application with --url or -i, log in, or run the command online once to fill the cache";
  try {
    // Metadata and permission reads only; --explain does not apply to help, which sends no request
    // of its own. A copy of the flags says so, so the caller's parsed arguments stay as typed.
    const ctx = context({ ...args, flags: { ...args.flags, explain: false } });
    described = subject.kind === "query" ? await describeQuery(ctx, subject.key) : await describeOperation(ctx);
  } catch (err) {
    unavailable = err instanceof Error ? err.message : String(err);
    // An error that knows its own way out says it; the generic remedy is for a missing application.
    if (err instanceof CliError && err.hint !== undefined) remedy = err.hint;
  }

  if (asJson) {
    const help = staticHelpDocument(subject);
    renderDocument(
      { ...help, application: described?.doc ?? null, ...(unavailable !== undefined ? { applicationUnavailable: unavailable } : {}) },
      { format: args.flags.output as OutputFormat, write: io.out },
    );
    return ExitCode.Ok;
  }
  showHelp(args, io);
  if (described !== undefined) io.out(described.text);
  else io.err(`\nnote: could not describe ${named} for this application: ${unavailable ?? "unknown"}\n${remedy.replace(/\n?$/, "\n")}`);
  return ExitCode.Ok;
}

/** The structured static help a subject's JSON help starts from: the query command, or the operations topic. */
function staticHelpDocument(subject: Subject): Record<string, unknown> {
  if (subject.kind === "operation") return { schemaVersion: 1, topic: "operations", text: TOPICS["operations"] };
  const spec = findCommand(["query"]);
  return { schemaVersion: 1, ...(spec !== undefined ? { command: helpAsJson(spec) } : {}) };
}
