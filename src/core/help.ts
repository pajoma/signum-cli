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
import { OUTPUT_FORMATS, type OutputFormat } from "./output.ts";

export interface FlagSpec {
  name: string;
  alias?: string;
  arg?: string;
  summary: string;
  /** When given, this flag narrows its command's formats to these — `--lites` returns references, not rows. */
  formats?: readonly OutputFormat[];
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
  /**
   * The `-o` formats this command can write. An explicit format always wins (REQ-050), so one the
   * command cannot honour is refused rather than quietly replaced by another. Omitted: a document,
   * which has no rows for csv, tsv or name to write — see DOCUMENT_FORMATS.
   */
  formats?: readonly OutputFormat[];
}

/** What a command that prints a document (a status, an entity, a description) can write. */
export const DOCUMENT_FORMATS: readonly OutputFormat[] = ["table", "json", "ndjson"];

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "url", arg: "<url>", summary: "Target application base URL (or SIGNUM_URL)" },
  { name: "instance", alias: "i", arg: "<name>", summary: "Target a registered instance (or SIGNUM_INSTANCE); see `signum instance`" },
  { name: "output", alias: "o", arg: "<fmt>", summary: `Output format: ${OUTPUT_FORMATS.join(", ")}` },
  { name: "json", summary: "Alias for --output json" },
  { name: "explain", summary: "Print the request instead of sending it (metadata may be fetched)" },
  { name: "verbose", alias: "v", summary: "HTTP tracing, credentials redacted; an AI caller needs the ack flag" },
  { name: "no-color", summary: "Disable colour (also honours NO_COLOR)" },
  { name: "timeout", arg: "<seconds>", summary: "Request timeout" },
  { name: "caller-context", arg: "<ctx>", summary: "Override caller detection: interactive|automated|agent" },
  { name: "offline", summary: "Never fetch metadata; use the cache (or SIGNUM_OFFLINE=1)" },
  { name: "pseudonymize", arg: "<mode>", summary: "off|heuristic|strict — may tighten; loosening needs the ack flag" },
  { name: "help", alias: "h", summary: "Show help for any command" },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    summary: "Show help, or long-form help on a topic",
    usage: "signum help [<topic>]",
    milestone: "m1",
    // Derived, not a second hand-maintained list — the drift risk AC-62.2 exists to prevent.
    get description() { return `Topics: ${topicNames().join(", ")}.`; },
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
      "signum auth login --url https://app.example",
      "signum auth logout",
    ],
    subcommands: [
      {
        name: "login",
        summary: "Store a bearer token handed over from a browser session",
        usage: "signum auth login --url <url> [--with-token]",
        milestone: "m1",
        description:
          "The target application uses Entra SSO with no Signum.Rest module, so a browser token " +
          "handoff is the only viable mechanism. Sign in to the web app, then in the browser " +
          "console run:\n\n    sessionStorage.getItem(\"authToken\")\n\n" +
          "At a terminal you are prompted for it and it is not echoed. Piping works too. It is " +
          "never read from an argument, which would leave it in your shell history and the process " +
          "list — passing one there is refused, not ignored.\n\n" +
          "--with-token is optional while the handoff is the only mechanism this application " +
          "supports; it becomes how you choose one when others exist.",
        flags: [{ name: "with-token", summary: "Browser-handoff token (optional; the only mechanism today)" }],
        examples: [
          "signum auth login --url https://app.example",
          "signum auth login --url https://app.example --with-token < token.txt",
          'printf %s "$TOKEN" | signum auth login --url https://app.example --with-token',
        ],
      },
      {
        name: "status",
        summary: "Show whether you are authenticated, as whom, against what",
        usage: "signum auth status",
        milestone: "m1",
        description:
          "The first thing to run when something is not working: reachability, the target, where the " +
          "credential comes from, who you are, and the application's version. Never prints a token.",
        examples: ["signum auth status", "signum auth status --json"],
      },
      {
        name: "whoami",
        summary: "Same as `auth status`",
        usage: "signum auth whoami",
        milestone: "m1",
        examples: ["signum auth whoami"],
      },
      {
        // Implemented in runAuth since m1 but never declared here, so it was absent from
        // SUBCOMMANDS, had no `--help`, and `signum help auth logout` fell back to the topic.
        name: "logout",
        summary: "Remove a stored credential from this machine",
        usage: "signum auth logout [--url <url> | -i <name> | --all]",
        milestone: "m1",
        description:
          "Credentials are stored per target. Without --url or -i this removes the default " +
          "target's (the most recent login); --all removes every one.\n\n" +
          "Local only. Signum does not revoke issued tokens: api/auth/logout clears a cookie " +
          "and performs no revocation, so the token stays valid server-side until the user's " +
          "password hash or state changes.",
        flags: [{ name: "all", summary: "Remove the stored credential for every target" }],
        examples: ["signum auth logout", "signum auth logout --url https://app.example", "signum auth logout --all"],
      },
    ],
  },
  {
    name: "types",
    summary: "List the types the application exposes: entities, enums, symbols",
    usage: "signum types [<pattern>] [--kind <kind>]",
    milestone: "m1",
    formats: OUTPUT_FORMATS,
    description:
      "Reflection lists more than entities: enums, messages, queries and symbol containers " +
      "(operations and permissions are symbols). `signum explain <Type>` shows an enum's values " +
      "or a container's symbols. Permission containers are not marked as such by the server; " +
      "where Signum.Authorization is installed, a permission you are denied is left out.",
    flags: [{ name: "kind", arg: "<kind>", summary: "Only this kind: entity, enum, message, query, symbol" }],
    examples: ["signum types", "signum types order --json", "signum types --kind enum", "signum types --kind symbol"],
  },
  {
    name: "queries",
    summary: "List the queries the application exposes",
    usage: "signum queries [<pattern>]",
    milestone: "m1",
    formats: OUTPUT_FORMATS,
    examples: ["signum queries"],
  },
  {
    name: "operations",
    summary: "List invokable operations, with shadowed verbs flagged",
    usage: "signum operations [<Type>]",
    milestone: "m1",
    formats: OUTPUT_FORMATS,
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
      "authentication needed, and it works offline. An application with Signum.Authorization " +
      "lists no entity to a caller who is not logged in, so there an entity needs a login.\n\n" +
      "A dotted token path (`signum explain Order.Entity.Customer`) is resolved LIVE against the " +
      "query's own description, so it validates the path and lists what may follow it. That call " +
      "DOES need a credential and cannot come from cache — api/query/subTokens is not anonymous, " +
      "unlike the reflection endpoint.\n\n" +
      "The first segment is the query key and the rest is the token, which is how Signum reads a " +
      "dotted token: relative to the query, not to a type.",
    flags: [
      { name: "privacy", summary: "Show which members would be pseudonymized, and why (REQ-059)" },
    ],
    examples: [
      "signum explain Order",
      "signum explain Order --privacy",
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
    formats: OUTPUT_FORMATS,
    description:
      "Results, totals and --count include only the rows your permissions allow. The server " +
      "removes the others silently and the response carries no marker that it did, so a result " +
      "is complete for you, not necessarily for the database (AC-08.6). A page that is not the " +
      "whole result says so on stderr in every format (\"50 of 56 rows visible to you\"), and " +
      "stdout carries only the rows (AC-21.5).",
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
      { name: "lites", summary: "Return matching entity references (api/query/lites); --top/--all set the count",
        formats: ["table", "json", "ndjson", "name"] },
      { name: "entities", summary: "Return matching whole entities (api/query/entities); json or ndjson",
        formats: DOCUMENT_FORMATS },
      { name: "resolve", summary: "Show entity columns by name instead of Type;id (adds .ToString)" },
      { name: "as-command", summary: "Print the command for a human to run; emit no data (REQ-078)" },
    ],
    examples: [
      'signum query Order --filter "State = Shipped" --top 20',
      'signum query Order --filter "Entity.Customer.Name ~ Acme" -o csv',
      'signum query Order --filter "State in Shipped,Delivered"',
      "signum query Order --count",
      'signum query Order --filter "State = Shipped" --lites --top 10',
      "signum query Order --entities --top 5 --json",
      "signum query Order --resolve --top 20",
      'signum query Order --filter "State = Shipped" --as-command',
    ],
  },
  {
    name: "get",
    summary: "Retrieve one entity by type and id, or by Lite key",
    usage: "signum get <Type> <id> | signum get <Lite>",
    milestone: "m1",
    flags: [
      { name: "exists", summary: "Check presence only; print nothing" },
      { name: "as-command", summary: "Print the command for a human to run; emit no data (REQ-078)" },
    ],
    examples: ["signum get Order 42", 'signum get "Order;42" --json'],
  },
  {
    name: "unmask",
    summary: "Resolve local ref_ handles back to the records they stand for",
    usage: "signum unmask <ref_...> [...] | --in <path> | --list | --clear",
    milestone: "m2",
    description:
      "Pseudonymized output emits entity identities as opaque local handles (ref_...) rather than " +
      "Type;id, so an agent can act on a record it cannot identify. This resolves them back, for a " +
      "HUMAN auditing what was read or acted on.\n\n" +
      "Nothing here touches the network: the surrogate-to-real mapping is local by construction and " +
      "never leaves the machine. It is stored 0600 beside the credential, per profile, and is valid " +
      "only for the surrogate secret that produced it.\n\n" +
      "A handle is accepted anywhere a Lite key is, so `signum get ref_7f3a1c2b4d5e` works and is " +
      "resolved locally before the request is built.\n\n" +
      "--in resolves handles inside FILES, which is the point of the handles: an agent writes a " +
      "report it cannot read, and this turns it into one you can. A folder is walked recursively; " +
      "binaries, symlinks and files over 8 MiB are skipped and reported. Files are read and written " +
      "as UTF-8 whatever the platform codepage is.\n\n" +
      "By default a handle becomes the entity's DISPLAY STRING where one is known, and falls back to " +
      "the Type;id identity where it is not - saying so, per handle, rather than quietly emitting a " +
      "key where you asked for a name. --labels identity always substitutes the key; --labels fetch " +
      "asks the server for the labels that are missing, one round trip per entity type, and caches " +
      "them. Everything else here touches no network.\n\n" +
      "What the store holds: handles.json maps a handle to its identity AND, by default, to the " +
      "display string captured when the handle was minted. That makes it a store of NAMES - real " +
      "personal data at rest, 0600 beside the credential, removable with --clear. Set " +
      "\"storeLabels\": false in privacy.json to keep identities only.\n\n" +
      "Handles in FILE and FOLDER names are resolved too — docs/ref_cccc/report-ref_aaaa.md leaks " +
      "two identities in the path alone, whatever the contents say. By default the sibling copy is " +
      "written at the resolved path; --in-place renames the originals instead, deepest first, and " +
      "never over an existing name. A skipped binary is still reported when its NAME carries a " +
      "handle, since renaming it needs no reading.\n\n" +
      "By default the input is left alone and a sibling copy is written (report.md -> " +
      "report.local.md), because the input is usually generated, tracked, and deliberately free of " +
      "identities. --in-place overrides that. Handles that cannot resolve are left exactly as they " +
      "are and named in the report, never passed over quietly.\n\n" +
      "Writing a name into a file is durable in a way that printing one is not, so --in warns when " +
      "an output file is inside a git work tree and not ignored. That is the actual footgun: a " +
      "commit full of real names in a repository that deliberately contained none.",
    flags: [
      { name: "in", summary: "Resolve handles in this file, or every text file under this folder", arg: "path" },
      { name: "labels", summary: "identity | stored (default) | fetch - what to substitute", arg: "mode" },
      { name: "glob", summary: "Only files whose name matches, e.g. '*.md' (* and ? only)", arg: "pattern" },
      { name: "dry-run", summary: "Report what would change and write nothing" },
      { name: "in-place", summary: "Rewrite and rename the originals instead of writing .local. siblings" },
      { name: "list", summary: "How many handles are stored (never what they mean)" },
      { name: "forget-labels", summary: "Drop every stored display string, keeping the identities" },
      { name: "clear", summary: "Forget them all - every outstanding handle stops resolving" },
      { name: "yes", summary: "Skip the confirmation for --clear" },
    ],
    examples: [
      "signum unmask ref_7f3a1c2b4d5e",
      "signum unmask --in report.md --dry-run",
      "signum unmask --in docs --glob '*.md'",
      "signum unmask --list",
      "signum unmask --clear",
    ],
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
  {
    name: "instance",
    summary: "Register short names for target applications, used as -i <name>",
    usage: "signum instance <add|list|remove|path>",
    milestone: "m2",
    description:
      "A registered name stands in for --url anywhere: `signum -i renew types`. The name is always " +
      "yours to choose; it is never derived from the URL.\n\n" +
      "Names are stored in instances.json in the config directory, owner-only. A stored login " +
      "is still matched by URL, so -i reaches it exactly when --url with the same address would. " +
      "Nothing here touches the network.",
    examples: [
      "signum instance add renew https://renew.example.org",
      "signum instance add staging https://staging.example.org",
      "signum instance list",
    ],
    subcommands: [
      {
        name: "add",
        summary: "Register a URL under a name you choose",
        usage: "signum instance add <name> <url>",
        milestone: "m2",
        examples: ["signum instance add renew https://renew.example.org", "signum instance add local http://localhost:5000"],
      },
      {
        name: "list",
        summary: "List registered instances",
        usage: "signum instance list",
        milestone: "m2",
        examples: ["signum instance list", "signum instance list --json"],
      },
      {
        name: "remove",
        summary: "Forget a name; the stored login, if any, is kept",
        usage: "signum instance remove <name>",
        milestone: "m2",
        examples: ["signum instance remove renew"],
      },
      {
        name: "path",
        summary: "Print the instances file path, bare, for scripting",
        usage: "signum instance path",
        milestone: "m2",
        examples: ["signum instance path"],
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

/** What a command path can write with the flags in use, and what limited it. */
export interface FormatSupport {
  formats: readonly OutputFormat[];
  /** The flags in use that narrowed the command's own formats, e.g. `lites`. */
  narrowedBy: string[];
  /** The command declares no formats of its own: it prints a document, not rows. */
  document: boolean;
}

/**
 * The formats `path` can write: its own list, else its command's, else a document's, narrowed by
 * every flag in use that declares formats of its own.
 */
export function formatSupport(path: readonly string[], used: (flag: string) => boolean = () => false): FormatSupport {
  const spec = findCommand(path);
  const declared = spec?.formats ?? findCommand(path.slice(0, 1))?.formats;
  let formats = declared ?? DOCUMENT_FORMATS;
  const narrowedBy: string[] = [];
  for (const f of spec?.flags ?? []) {
    const own = f.formats;
    if (own === undefined || !used(f.name)) continue;
    formats = formats.filter((format) => own.includes(format));
    narrowedBy.push(f.name);
  }
  return { formats, narrowedBy, document: declared === undefined };
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
  out.push("  signum --url https://app.example types      # explore; entities may need a login");
  out.push("  signum auth login --url https://app.example    # prompts for the token");
  out.push("  signum auth status                          # who am I, against what");
  out.push("");
  out.push("HELP TOPICS");
  // Listed, not hinted at. They were previously discoverable only by making a mistake — the error
  // for an unknown topic printed the list, and nothing else did.
  out.push(`  ${topicNames().join("  ")}`);
  out.push("  signum help <topic>");
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

/** Topic names, sorted — an arbitrary order in a list a human scans reads as noise. */
export function topicNames(): string[] {
  return Object.keys(TOPICS).sort();
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
    "  Under a detected agent, values whose member name looks personal are replaced by",
    "  STABLE SURROGATES rather than blanked, so an agent can still group and correlate",
    "  rows without reading them. Modes:",
    "",
    "    off         no replacement (the default for a human at a terminal)",
    "    heuristic   member-name heuristics, English and German (default under an agent)",
    "    strict      allowlist only — everything not permitted is replaced",
    "",
    "  See what WOULD be replaced, and why:   signum explain <Type> --privacy",
    "  Configure it:                          <config-dir>/privacy.json",
    "                                         { \"mode\": \"strict\", \"allow\": [\"State\"] }",
    "",
    "  TO READ SOME MEMBERS AND NOTHING ELSE, list them under \"allow\" with mode strict,",
    "  rather than turning pseudonymization off. An allowed member shows its value: a",
    "  reference with its display text, a list item by item, in query and get alike.",
    "  What a reference or an embedded value CONTAINS is still judged on its own, so",
    "  allowing Customer does not show the customer's email. Everything else stays",
    "  masked, including each record's own title (toStr) and its Entity column, which",
    "  stays a handle. An allow entry matches that member name at any depth, in every",
    "  type. No acknowledgement is needed, because the file is written by a human.",
    "",
    "  The policy is resolved from that file and the caller context — it is NOT a",
    "  per-call parameter. --pseudonymize may TIGHTEN it freely; loosening it under a",
    "  detected agent needs --i-understand-data-goes-to-a-model and is logged, because",
    "  the caller asking for weaker protection is the caller that wants the data.",
    "",
    "  Surrogates are stable per profile, so the same value reads the same across",
    "  commands. Entity identities, a reference or an Id column, become opaque handles",
    "  (ref_...) rather than labels or ids, so an agent can act on a record it cannot",
    "  identify:",
    "",
    "    signum get ref_7f3a1c2b4d5e         resolved locally, never sent to the server",
    "    signum unmask ref_7f3a...  what it stands for (human only)",
    "    signum unmask --in docs    resolve handles inside files (human only)",
    "    signum unmask --forget-labels   drop the names, keep the identities",
    "    signum unmask --clear      forget every handle",
    "",
    "  WHAT THE HANDLE STORE HOLDS. <config-dir>/handles.json maps each handle to the",
    "  identity it stands for AND, by default, to the entity's display string, captured",
    "  when the handle was minted. That second part makes it a store of NAMES — real",
    "  personal data at rest — which is what lets `unmask --in` turn an agent's report",
    "  into one a human can read instead of a page of Type;id. It is 0600 beside the",
    "  credential and `unmask --clear` forgets all of it. To keep identities only:",
    "",
    "    privacy.json   { \"storeLabels\": false }",
    "",
    "  With that set, `unmask` falls back to Type;id and says which handles it could",
    "  not name; `--labels fetch` can still resolve them per run without writing them",
    "  down. Nothing about labels changes what an AGENT sees — a label is masked in",
    "  agent-facing output either way, and the store is never emitted.",
    "",
    "  LIMITS, and they are real: free text is never scanned, so a comment field",
    "  containing a name defeats this entirely. Heuristics both miss and misfire.",
    "  A surrogate over a column with FEW DISTINCT VALUES is reversible by counting:",
    "  three of one surrogate and one each of two others maps straight back onto the",
    "  real values for anyone who knows the domain. Stability is what makes grouping",
    "  work and what makes that possible; it cannot be fixed, only known about.",
    "  Aggregates leak — \"the only user with Java and COBOL\" identifies a person even",
    "  when every value is a surrogate. Metadata carries context of its own.",
    "",
    "  Pseudonymized data remains personal data under GDPR Art. 4(5). This tool reduces",
    "  exposure; it is NOT a compliance control, and it never claims to be.",
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
    formats: c.formats ?? DOCUMENT_FORMATS,
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
