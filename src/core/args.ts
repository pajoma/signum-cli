/**
 * Argument parsing and command dispatch.
 *
 * design/cli-surface.md §2.1, §3
 *
 * Dispatch order (the invariant to preserve):
 *   1. first argument contains a '.'  ⇒ canonical operation key
 *   2. matches a built-in             ⇒ built-in (BUILT-INS ALWAYS WIN)
 *   3. otherwise                      ⇒ resolve <verb> <Type> against metadata
 *
 * Two invariants: no built-in command may contain a '.', and the built-in verb set stays
 * small, fixed and lowercase — every addition can shadow an application's operation.
 */

import { UsageError, type ExitCode } from "./errors.ts";
import { parseOutputFormat, type OutputFormat } from "./output.ts";
import { knownFlagNames } from "./help.ts";
import { nearest } from "./text.ts";

/** The complete built-in verb set. Adding to this can shadow an app's operation verb. */
export const BUILT_INS = [
  "help",
  "version",
  "auth",
  "types",
  "queries",
  "operations",
  "explain",
  "query",
  "get",
  "cache",
  "unmask",
] as const;

export type BuiltIn = (typeof BUILT_INS)[number];

export function isBuiltIn(name: string): name is BuiltIn {
  return (BUILT_INS as readonly string[]).includes(name.toLowerCase());
}

/** Enforced by test: no built-in may contain a dot, or dispatch rule 1 breaks. */
export function builtInsSatisfyDispatchInvariant(): boolean {
  return BUILT_INS.every((b) => !b.includes("."));
}

export interface GlobalFlags {
  url: string | undefined;
  output: OutputFormat | undefined;
  explain: boolean;
  verbose: boolean;
  noColor: boolean;
  help: boolean;
  timeoutMs: number | undefined;
  callerContext: string | undefined;
  /**
   * `--version`, which everyone types first. It resolves to the `version` COMMAND rather than a
   * separate path, so the two can never drift.
   *
   * There is no `-V`: flag names are lowercased before dispatch, so `-V` would collide with `-v`
   * (verbose). Silently printing help for `--version` — which is what happened before — is worse
   * than not supporting it, because it looks like it worked.
   */
  version: boolean;
  /** STORY-51 acknowledgement (AC-51.2). Deliberately unmissable. */
  allowAgentData: boolean;
  /**
   * Requested pseudonymization mode (REQ-057). May TIGHTEN freely; loosening under a detected agent
   * needs `allowAgentData` and is logged — see privacy.ts `resolvePolicy` (AC-52.10).
   */
  pseudonymize: string | undefined;
  /**
   * Never touch the network for metadata; use whatever is cached (AC-24.4). Global rather than
   * per-command because `loadMetadata` is what honours it, and query/get call it too for
   * pre-flight validation — restricting the flag to the discovery commands would leave
   * "works fully offline" false for exactly the commands a warm cache is most useful to.
   */
  offline: boolean;
}

export interface ParsedArgs {
  /** `builtin` | `operation-key` | `verb-noun` | `none` */
  kind: "builtin" | "operation-key" | "verb-noun" | "none";
  /** Built-in name, canonical operation key, or the verb for verb-noun. */
  command: string | undefined;
  /** Remaining positional arguments after the command. */
  positionals: string[];
  flags: GlobalFlags;
  /** Repeatable/unknown flags, kept for command-specific parsing. */
  options: Map<string, string[]>;
  booleans: Set<string>;
  /**
   * Every flag name actually TYPED on the command line, before environment fallbacks are applied.
   *
   * Needed to tell an explicit `--url` from one inherited from `SIGNUM_URL` or a stored credential:
   * REQ-078's echo reproduces what the caller gave, and printing a customer's hostname nobody asked
   * for would be gratuitous.
   */
  rawFlagNames: Set<string>;
}

const FLAGS_WITH_VALUE = new Set([
  "url", "output", "o", "timeout", "caller-context", "pseudonymize",
  "filter", "filter-json", "column", "order", "top", "page", "page-size",
  "context", "pseudonymize", "arg", "arg-string", "arg-lite", "arg-json",
  "lite", "id", "filename", "f",
  "in", "glob",
]);

/** Boolean flags — listing one above would make it demand a value. */
export const BOOLEAN_FLAGS = new Set([
  "with-token", "exists", "count", "all", "yes", "y", "raw", "group",
  "resolve", "privacy", "list", "clear", "as-command", "dry-run", "in-place",
]);

/** Invariant: a flag cannot need a value and be boolean-only at once. Checked by test. */
export function flagSetsAreDisjoint(): boolean {
  return [...BOOLEAN_FLAGS].every((f) => !FLAGS_WITH_VALUE.has(f));
}

function emptyFlags(): GlobalFlags {
  return {
    url: undefined,
    output: undefined,
    explain: false,
    verbose: false,
    noColor: false,
    help: false,
    timeoutMs: undefined,
    callerContext: undefined,
    version: false,
    allowAgentData: false,
    pseudonymize: undefined,
    offline: false,
  };
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const flags = emptyFlags();
  const options = new Map<string, string[]>();
  const booleans = new Set<string>();
  const rawFlagNames = new Set<string>();
  const positionals: string[] = [];

  const push = (name: string, value: string) => {
    const list = options.get(name);
    if (list === undefined) options.set(name, [value]);
    else list.push(value);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2 && arg !== "-")) {
      const bare = arg.replace(/^--?/, "");
      const eq = bare.indexOf("=");
      const name = (eq === -1 ? bare : bare.slice(0, eq)).toLowerCase();
      rawFlagNames.add(name);
      let value = eq === -1 ? undefined : bare.slice(eq + 1);

      if (value === undefined && FLAGS_WITH_VALUE.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("--") && next.length > 2)) {
          throw new UsageError(`flag --${name} requires a value`);
        }
        value = next;
        i++;
      }

      switch (name) {
        case "help": case "h": flags.help = true; break;
        case "explain": flags.explain = true; break;
        case "verbose": case "v": flags.verbose = true; break;
        case "no-color": flags.noColor = true; break;
        case "json": flags.output = "json"; break;
        case "url": flags.url = value; break;
        case "output": case "o": flags.output = parseOutputFormat(value as string); break;
        case "caller-context": flags.callerContext = value; break;
        case "i-understand-data-goes-to-a-model": flags.allowAgentData = true; break;
        case "offline": flags.offline = true; break;
        case "version": flags.version = true; break;
        case "pseudonymize": flags.pseudonymize = value; break;
        case "timeout": {
          const ms = Number(value);
          if (!Number.isFinite(ms) || ms <= 0) throw new UsageError(`--timeout must be a positive number of seconds`);
          flags.timeoutMs = ms * 1000;
          break;
        }
        default:
          if (value === undefined) {
            booleans.add(name);
          } else if (BOOLEAN_FLAGS.has(name)) {
            // H2 (Brooks review): a boolean flag given `=value` (e.g. --exists=true) must
            // register as the boolean, not land in `options` where flag() never looks —
            // otherwise it reads as "not passed" and is silently ignored.
            const v = value.toLowerCase();
            if (v === "true" || v === "1" || v === "yes") booleans.add(name);
            else if (v === "false" || v === "0" || v === "no") { /* explicitly unset */ }
            else throw new UsageError(`--${name} is a boolean flag; expected true or false, got '${value}'`);
          } else {
            push(name, value);
          }
      }
      continue;
    }

    positionals.push(arg);
  }

  if (env["SIGNUM_ALLOW_AGENT_DATA"] === "1") flags.allowAgentData = true;
  if (env["SIGNUM_OFFLINE"] === "1") flags.offline = true;
  if (flags.pseudonymize === undefined) {
    const fromEnv = env["SIGNUM_PSEUDONYMIZE"];
    if (fromEnv !== undefined && fromEnv !== "") flags.pseudonymize = fromEnv;
  }
  if (flags.callerContext === undefined) {
    const fromEnv = env["SIGNUM_CALLER_CONTEXT"];
    if (fromEnv !== undefined && fromEnv !== "") flags.callerContext = fromEnv;
  }
  if (flags.url === undefined) {
    const fromEnv = env["SIGNUM_URL"];
    if (fromEnv !== undefined && fromEnv !== "") flags.url = fromEnv;
  }

  // `--version` with no command IS the version command. Resolving it here rather than in cli.ts
  // means one implementation, one output shape, and no chance of the two disagreeing.
  if (flags.version && positionals.length === 0) {
    return { kind: "builtin", command: "version", positionals: [], flags, options, booleans, rawFlagNames };
  }

  const first = positionals[0];
  if (first === undefined) {
    return { kind: "none", command: undefined, positionals: [], flags, options, booleans, rawFlagNames };
  }

  // 1. dot ⇒ canonical operation key
  if (first.includes(".")) {
    return { kind: "operation-key", command: first, positionals: positionals.slice(1), flags, options, booleans, rawFlagNames };
  }
  // 2. built-ins always win
  if (isBuiltIn(first)) {
    return { kind: "builtin", command: first.toLowerCase(), positionals: positionals.slice(1), flags, options, booleans, rawFlagNames };
  }
  // 3. verb-noun operation
  return { kind: "verb-noun", command: first, positionals: positionals.slice(1), flags, options, booleans, rawFlagNames };
}

/**
 * Reject a flag the target command does not declare, rather than silently ignoring it
 * (QA finding: `--filer` instead of `--filter` previously ran the query unfiltered with
 * exit 0 — exactly the silent-wrong-data-on-production risk this project is built against).
 *
 * Only per-command flags need declaring here: global flags (`--url`, `-o`, `--json`, …) are
 * already peeled off into the typed `flags` struct by `parseArgs` and never reach
 * `options`/`booleans`, so they can't collide with this check.
 */
export function assertKnownFlags(args: ParsedArgs, path: readonly string[]): void {
  const known = knownFlagNames(path);
  const used = new Set<string>([...args.options.keys(), ...args.booleans]);
  const unknown = [...used].filter((f) => !known.has(f));
  if (unknown.length === 0) return;

  const withSuggestions = unknown.map((u) => {
    const near = nearest(u, known);
    return near !== undefined ? `--${u} (did you mean --${near}?)` : `--${u}`;
  });
  throw new UsageError(
    `unknown flag${unknown.length > 1 ? "s" : ""} for '${path.join(" ")}': ${withSuggestions.join(", ")}`,
    { hint: `Run \`signum ${path.join(" ")} --help\` for the flags this command accepts.` },
  );
}

export interface ExitSignal {
  code: ExitCode;
}
