/**
 * Help at every level.
 *
 * REQ-014 · STORY-60, STORY-62 · design/cli-surface.md §2.2
 *
 * ONE structured source, many renderings (AC-62.2): prose for humans, JSON for agents,
 * MCP tool schemas and shell completion later. Never two hand-maintained descriptions of
 * the same command set — that is exactly how the spec and stories drifted once already.
 *
 * Static help works with no config, no credentials and no network (AC-60.2).
 */

import { EXIT_CODE_DESCRIPTIONS, ExitCode } from "./errors.ts";
import { OUTPUT_FORMATS } from "./output.ts";

export interface FlagSpec {
  name: string;
  alias?: string;
  arg?: string;
  summary: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  milestone: "m1" | "m2" | "m3";
  description?: string;
  flags?: FlagSpec[];
  examples?: string[];
  subcommands?: CommandSpec[];
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "url", arg: "<url>", summary: "Target application base URL (or SIGNUM_URL)" },
  { name: "output", alias: "o", arg: "<fmt>", summary: `Output format: ${OUTPUT_FORMATS.join(", ")}` },
  { name: "json", summary: "Alias for --output json" },
  { name: "explain", summary: "Print the request that would be sent; send nothing" },
  { name: "verbose", alias: "v", summary: "HTTP tracing, credentials redacted" },
  { name: "no-color", summary: "Disable colour (also honours NO_COLOR)" },
  { name: "timeout", arg: "<seconds>", summary: "Request timeout" },
  { name: "caller-context", arg: "<ctx>", summary: "Override caller detection: interactive|automated|agent" },
  { name: "offline", summary: "Never fetch metadata; use the cache (or SIGNUM_OFFLINE=1)" },
  { name: "help", alias: "h", summary: "Show help for any command" },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    summary: "Show help, or long-form help on a topic",
    usage: "signum help [<topic>]",
    milestone: "m1",
    description: `Topics: ${["filter", "tokens", "output", "exit-codes", "auth", "contexts", "pseudonymization"].join(", ")}.`,
    examples: ["signum help", "signum help exit-codes", "signum help filter"],
  },
  {
    name: "version",
    summary: "Print the CLI version, and the target app's version when reachable",
    usage: "signum version",
    milestone: "m1",
    examples: ["signum version", "signum version --url https://app.example --json"],
  },
  {
    name: "auth",
    summary: "Authenticate against a Signum application",
    usage: "signum auth <login|status|logout>",
    milestone: "m1",
    // A command group needs its own examples too (AC-60.4) — landing on `signum auth --help`
    // and being shown only a list of subcommand names is one step short of useful.
    examples: [
      "signum auth status",
      "signum auth login --url https://app.example --with-token < token.txt",
      "signum auth logout",
    ],
    subcommands: [
      {
        name: "login",
        summary: "Store a bearer token handed over from a browser session",
        usage: "signum auth login --url <url> --with-token",
        milestone: "m1",
        description:
          "The target application uses Entra SSO with no Signum.Rest module, so a browser token " +
          "handoff is the only viable mechanism. Sign in to the web app, then in the browser " +
          "console run:\n\n    sessionStorage.getItem(\"authToken\")\n\n" +
          "and pipe the value in. The token is read from stdin only — never from an argument, " +
          "which would leak it into shell history.",
        flags: [{ name: "with-token", summary: "Read the token from stdin" }],
        examples: [
          "signum auth login --url https://app.example --with-token < token.txt",
          'printf %s "$TOKEN" | signum auth login --url https://app.example --with-token',
        ],
      },
      {
        name: "status",
        summary: "Show whether you are authenticated, as whom, against what",
        usage: "signum auth status",
        milestone: "m1",
        description: "The first thing to run when something is not working. Never prints a token.",
        examples: ["signum auth status", "signum auth status --json"],
      },
      {
        // Implemented in runAuth since m1 but never declared here, so it was absent from
        // SUBCOMMANDS, had no `--help`, and `signum help auth logout` fell back to the topic.
        name: "logout",
        summary: "Remove the stored credential from this machine",
        usage: "signum auth logout",
        milestone: "m1",
        description:
          "Local only. Signum does not revoke issued tokens: api/auth/logout clears a cookie " +
          "and performs no revocation, so the token stays valid server-side until the user's " +
          "password hash or state changes.",
        examples: ["signum auth logout"],
      },
    ],
  },
  {
    name: "types",
    summary: "List the entity types the application exposes",
    usage: "signum types [<pattern>]",
    milestone: "m1",
    examples: ["signum types", "signum types order --json"],
  },
  {
    name: "queries",
    summary: "List the queries the application exposes",
    usage: "signum queries [<pattern>]",
    milestone: "m1",
    examples: ["signum queries"],
  },
  {
    name: "operations",
    summary: "List invokable operations, with shadowed verbs flagged",
    usage: "signum operations [<Type>]",
    milestone: "m1",
    description:
      "Read-only discovery, so it ships in m1 even though invoking an operation is m2. " +
      "An operation whose verb collides with a built-in is marked SHADOWED and remains " +
      "reachable by its canonical key.",
    examples: ["signum operations", "signum operations Order"],
  },
  {
    name: "explain",
    summary: "Describe a type, a query token path, or an operation",
    usage: "signum explain <Type>[.<token>] | <OperationKey>",
    milestone: "m1",
    description:
      "One segment (`signum explain Order`) reads the cached reflection document: no " +
      "authentication needed, and it works offline.\n\n" +
      "A dotted token path (`signum explain Order.Entity.Customer`) is resolved LIVE against the " +
      "query's own description, so it validates the path and lists what may follow it. That call " +
      "DOES need a credential and cannot come from cache — api/query/subTokens is not anonymous, " +
      "unlike the reflection endpoint.\n\n" +
      "The first segment is the query key and the rest is the token, which is how Signum reads a " +
      "dotted token: relative to the query, not to a type.",
    examples: [
      "signum explain Order",
      "signum explain Order.Entity.Customer",
      "signum explain Order.Entity --json",
      "signum explain OrderOperation.Ship",
    ],
  },
  {
    name: "query",
    summary: "Run a dynamic query",
    usage: "signum query <queryKey> [--filter <expr>] [--column <token>] [--order <token>]",
    milestone: "m1",
    flags: [
      { name: "filter", arg: "<expr>", summary: "Filter expression; repeatable (AND). See `signum help filter`" },
      { name: "filter-json", arg: "<file|@file|->", summary: "Raw FilterTS[] JSON; combines with --filter (AND)" },
      { name: "column", arg: "<token>", summary: "Column to select; repeatable, order preserved" },
      { name: "order", arg: "<token>", summary: "Sort token; prefix with - for descending" },
      { name: "top", arg: "<n>", summary: "Return only the first n rows" },
      { name: "page", arg: "<n>", summary: "Page number (1-based); use with --page-size" },
      { name: "page-size", arg: "<n>", summary: "Rows per page; default 50" },
      { name: "all", summary: "Fetch every row, unbounded — only one of --top/--page/--all at a time" },
      { name: "group", summary: "Set groupResults; required for aggregate tokens (Total.Sum, …)" },
      { name: "count", summary: "Return only the row count" },
      { name: "resolve", summary: "Show entity columns by name instead of Type;id (adds .ToString)" },
    ],
    examples: [
      'signum query Order --filter "State = Shipped" --top 20',
      'signum query Order --filter "Entity.Customer.Name ~ Acme" -o csv',
      'signum query Order --filter "State in Shipped,Delivered"',
      "signum query Order --count",
      "signum query Order --resolve --top 20",
    ],
  },
  {
    name: "get",
    summary: "Retrieve one entity by type and id, or by Lite key",
    usage: "signum get <Type> <id> | signum get <Lite>",
    milestone: "m1",
    flags: [{ name: "exists", summary: "Check presence only; print nothing" }],
    examples: ["signum get Order 42", 'signum get "Order;42" --json'],
  },
  {
    name: "cache",
    summary: "Inspect or clear the cached application metadata",
    usage: "signum cache <show|clear|path>",
    milestone: "m1",
    description:
      "Discovery, dynamic help and pre-flight query validation all read a cached copy of " +
      "api/reflection/types. This command makes that cache visible and removable — with " +
      "--offline it is the only thing the CLI will read.\n\n" +
      "Anonymous and authenticated documents are cached separately: reflection answers depend " +
      "on who is asking, so one fetched before login reports nothing as queryable.",
    examples: ["signum cache show", "signum cache clear", "signum cache path"],
    subcommands: [
      {
        name: "show",
        summary: "List cached documents: target, scope, age, size",
        usage: "signum cache show",
        milestone: "m1",
        examples: ["signum cache show", "signum cache show --json"],
      },
      {
        name: "clear",
        summary: "Delete cached documents, all of them or one target's",
        usage: "signum cache clear [--url <url>]",
        milestone: "m1",
        description: "Clearing a target removes both its anonymous and authenticated documents.",
        examples: ["signum cache clear", "signum cache clear --url https://app.example"],
      },
      {
        name: "path",
        summary: "Print the cache directory, bare, for scripting",
        usage: "signum cache path",
        milestone: "m1",
        examples: ["signum cache path", 'ls "$(signum cache path)"'],
      },
    ],
  },
];

/**
 * Flag names (without leading dashes) a command/subcommand declares, for unknown-flag
 * rejection (QA finding). Global flags never reach this check — parseArgs already special-
 * cases them into the typed `flags` struct, so they never land in `options`/`booleans`.
 */
export function knownFlagNames(path: readonly string[]): Set<string> {
  const spec = findCommand(path);
  const names = new Set<string>();
  for (const f of spec?.flags ?? []) {
    names.add(f.name.toLowerCase());
    if (f.alias !== undefined) names.add(f.alias.toLowerCase());
  }
  return names;
}

export function findCommand(path: readonly string[]): CommandSpec | undefined {
  let list = COMMANDS;
  let found: CommandSpec | undefined;
  for (const segment of path) {
    found = list.find((c) => c.name === segment.toLowerCase());
    if (found === undefined) return undefined;
    list = found.subcommands ?? [];
  }
  return found;
}

function renderFlags(flags: readonly FlagSpec[]): string[] {
  const left = flags.map((f) => {
    const alias = f.alias !== undefined ? `-${f.alias}, ` : "    ";
    return `  ${alias}--${f.name}${f.arg !== undefined ? " " + f.arg : ""}`;
  });
  const width = Math.max(...left.map((l) => l.length));
  return flags.map((f, i) => `${(left[i] as string).padEnd(width)}  ${f.summary}`);
}

export function renderOverview(): string {
  const out: string[] = [];
  out.push("signum — command-line client for Signum Framework applications");
  out.push("");
  out.push("USAGE");
  out.push("  signum <command> [args] [flags]");
  out.push("  signum <verb> <Type> [id]        # operations are first-class: signum ship order 42");
  out.push("");
  out.push("COMMANDS");
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const c of COMMANDS) out.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  out.push("");
  out.push("GLOBAL FLAGS");
  out.push(...renderFlags(GLOBAL_FLAGS));
  out.push("");
  out.push("GETTING STARTED");
  out.push("  signum --url https://app.example types      # explore without logging in");
  out.push("  signum auth login --url https://app.example --with-token");
  out.push("  signum auth status");
  out.push("");
  out.push("  signum help <topic>   for filter syntax, exit codes, output formats, and more");
  return out.join("\n") + "\n";
}

export function renderCommand(spec: CommandSpec, path: readonly string[]): string {
  const out: string[] = [];
  out.push(`signum ${path.join(" ")} — ${spec.summary}`);
  out.push("");
  out.push("USAGE");
  out.push(`  ${spec.usage}`);
  if (spec.description !== undefined) {
    out.push("");
    out.push(spec.description);
  }
  if (spec.subcommands !== undefined && spec.subcommands.length > 0) {
    out.push("");
    out.push("SUBCOMMANDS");
    const w = Math.max(...spec.subcommands.map((c) => c.name.length));
    for (const c of spec.subcommands) out.push(`  ${c.name.padEnd(w)}  ${c.summary}`);
  }
  if (spec.flags !== undefined && spec.flags.length > 0) {
    out.push("");
    out.push("FLAGS");
    out.push(...renderFlags(spec.flags));
  }
  if (spec.examples !== undefined && spec.examples.length > 0) {
    out.push("");
    out.push("EXAMPLES");
    for (const e of spec.examples) out.push(`  ${e}`);
  }
  out.push("");
  out.push("Run `signum help` for global flags.");
  return out.join("\n") + "\n";
}

export const TOPICS: Record<string, string> = {
  "exit-codes": [
    "EXIT CODES",
    "",
    ...Object.entries(EXIT_CODE_DESCRIPTIONS).map(([code, desc]) => `  ${code}  ${desc}`),
    "",
    "Codes 3 and 4 are distinct even though the server returns HTTP 403 for both",
    "authentication and authorization failures. The discriminator is the exceptionType",
    "in the response body. Retry after re-auth on 3; never retry on 4.",
  ].join("\n"),
  output: [
    "OUTPUT",
    "",
    `  Formats: ${OUTPUT_FORMATS.join(", ")}`,
    "",
    "  When stdout is a TTY the default is 'table'; otherwise it is 'json', so piping",
    "  produces machine-readable output without a flag. An explicit -o always wins.",
    "",
    "  Data goes to stdout and diagnostics to stderr, always, so a pipeline is never",
    "  corrupted by a warning. Values are truncated only in the human table form.",
    "",
    "  -o name prints bare Lite keys (TypeName;id), one per line, for piping to xargs.",
  ].join("\n"),
  auth: [
    "AUTHENTICATION",
    "",
    "  The target application uses Entra SSO and has no Signum.Rest module, which leaves",
    "  exactly one viable mechanism: hand over a bearer token from a browser session.",
    "",
    "    1. Sign in to the web application in your browser.",
    "    2. In the browser console:  sessionStorage.getItem(\"authToken\")",
    "    3. signum auth login --url <url> --with-token   (paste, or pipe from stdin)",
    "",
    "  The token is read from stdin only, never from a command-line argument.",
    "",
    "  Non-interactively (CI), set SIGNUM_TOKEN instead of logging in. It takes precedence over",
    "  a stored credential, is never written to disk, and cannot receive a rotation — so refresh",
    "  it when it stops working.",
    "",
    "  Tokens do not expire, but the server rotates them: it returns a replacement in a",
    "  New_Token response header, which this CLI adopts automatically. Ignoring rotation",
    "  would freeze your role permanently, so it is not optional.",
    "",
    "  Auth failures are HTTP 403, never 401 — see `signum help exit-codes`.",
  ].join("\n"),
  pseudonymization: [
    "PSEUDONYMIZATION AND AI CALLERS",
    "",
    "  This CLI detects when it is being driven by an AI agent and defaults to safer",
    "  behaviour. Detection is a heuristic, NOT a security boundary: every signal is",
    "  spoofable, so it is used only to choose a stricter default, and it fails closed.",
    "",
    "  Under a detected agent context, commands that emit row data refuse to run unless",
    "  you pass --i-understand-data-goes-to-a-model. Metadata and help are unaffected.",
    "",
    "  Full pseudonymization — stable surrogates rather than redaction — is not yet",
    "  implemented. It is tracked as REQ-057.",
    "",
    "  Note: pseudonymized data remains personal data under GDPR Art. 4(5). This tool",
    "  reduces exposure; it is not by itself a compliance control.",
  ].join("\n"),
  filter: [
    "FILTER SYNTAX",
    "",
    "  --filter accepts an expression; repeating the flag ANDs the expressions.",
    "",
    '    signum query Order --filter "State = Shipped"',
    '    signum query Order --filter "Total >= 100 and (State = Shipped or State = Delivered)"',
    "",
    "  Operators:  =  !=  >  >=  <  <=  ~ (contains)  !~ (not contains)",
    "              and named: startsWith, endsWith, like, in, notIn, between, …",
    "",
    "  There is no NOT: the server's filter groups are And/Or only, so negation is",
    "  expressed by negated operators such as != and notContains.",
    "",
    "  Values parse culture-invariantly. Quote a token that begins with '(' — a leading",
    "  parenthesis otherwise opens a group.",
    "",
    "  Not yet implemented in this milestone; see REQ-021.",
  ].join("\n"),
  tokens: [
    "QUERY TOKENS",
    "",
    "  A token is a dotted path: Entity.Customer.Name, OrderDate.Year, Details.Any.Product",
    "",
    "  Discover them with:  signum explain <QueryKey>[.<token>]",
    "",
    "  That walks the application's own query description one segment at a time, validating",
    "  the path and listing valid continuations. It needs a credential and a network call —",
    "  token discovery is not anonymous and is not cached, unlike `signum types`.",
    "",
    "  A '.Nested' token is offered by discovery but REJECTED by a query: the server lists",
    "  tokens with SubTokensOptions.All while filters never allow CanNested. Continuations",
    "  that cannot be used are marked.",
    "",
    "  Collections offer Element, Any, All, Count, RowId. Dates offer Year, Month,",
    "  MonthStart. Operations escape their own dot as '#': Entity.[Operations].Order#Save",
    "",
    "  The separator splits only on dots outside brackets, so [Operations] stays intact.",
  ].join("\n"),
  contexts: [
    "CONTEXTS",
    "",
    "  A context bundles a target URL, a credential, and a metadata cache.",
    "",
    "  Named contexts are m2 (REQ-001). In this milestone use --url, or set SIGNUM_URL.",
    "",
    "  The metadata cache is per-target and inspectable:",
    "",
    "    signum cache show                 what is cached, for which target, how old",
    "    signum cache clear [--url <url>]  drop it",
    "    signum --offline <command>        never fetch; use the cache only",
    "",
    "  Anonymous and authenticated documents are cached separately, because the server's",
    "  reflection answer depends on who is asking: one fetched before you logged in reports",
    "  nothing as queryable.",
  ].join("\n"),
};

/**
 * Structured help — the single source for agents, MCP schemas and completion (AC-62.1).
 * Pass a spec to scope the output to one command instead of the whole tree.
 */
export function helpAsJson(scope?: CommandSpec): unknown {
  const strip = (c: CommandSpec): unknown => ({
    name: c.name,
    summary: c.summary,
    usage: c.usage,
    milestone: c.milestone,
    description: c.description ?? null,
    flags: c.flags ?? [],
    examples: c.examples ?? [],
    subcommands: (c.subcommands ?? []).map(strip),
  });
  if (scope !== undefined) return strip(scope);

  return {
    // Bump on any breaking change to this shape — it is a public contract (AC-62.3).
    schemaVersion: 1,
    commands: COMMANDS.map(strip),
    globalFlags: GLOBAL_FLAGS,
    topics: Object.keys(TOPICS),
    exitCodes: Object.entries(EXIT_CODE_DESCRIPTIONS).map(([code, description]) => ({
      code: Number(code),
      description,
    })),
    dispatch: {
      rule: "1) first arg containing '.' is a canonical operation key; 2) built-ins always win; 3) otherwise <verb> <Type>",
      builtIns: COMMANDS.map((c) => c.name),
    },
    notes: {
      okExitCode: ExitCode.Ok,
      containsNoDataValues: true,
    },
  };
}
