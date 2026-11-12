# Changelog

Notable changes to signum-cli. Versions are [SemVer](https://semver.org/), and `package.json` is the
source of truth: a release tag `v<version>` must match it (see the README's release section).

## Unreleased

### Changed

- **Handles and surrogates are now per target application** (#121). The same record has a
  different `ref_` handle in each application, and a handle minted against one never resolves
  against another — before, a handle from a test instance resolved against production, to the
  record with the same id there. So handles and surrogates minted before this change no longer
  resolve or match for queries and operations; re-run the query to get fresh ones. `unmask` still
  reads the old store, so documents written with old handles stay readable.

### Added

- **Writes: operations can be executed** (milestone m2; #112, #113, #114, #115, #116, #117). Every
  change in a Signum app, saving included, is an operation, run as `signum ship order 42` or by its
  canonical key, `signum OrderOperation.Ship --lite "Order;42"`. See `signum help operations`.
  - The server decides the route: an operation that takes the entity (`canBeModified`, e.g. a Save)
    gets the freshly fetched entity, with `--edit Member=value` applied and marked; any other gets
    only the record's identity. An edit on an identity-only operation is refused, never dropped.
  - Nothing changes without confirmation: at a terminal you are asked, naming the operation, the
    record and the application; without one (a script, an agent) the command fails unless `--yes` is
    given. Every attempt is recorded in `<config-dir>/audit.log`, with the real record behind a handle.
  - `--dry-run` asks the server whether this login may run it (exit 0 or 4) and sends no operation;
    `--explain` prints the exact request.
  - `--arg`, `--arg-string`, `--arg-lite` and `--arg-json` build the arguments in the order typed.
    An object the server would silently receive as `null` is refused, and a date-shaped string, which
    the server reads as a date, is warned about.
  - A validation failure is exit 6 with the server's field messages; a stale record is exit 7, with
    `ticks` sent back exactly as fetched; a refusal is exit 4, noting that the API runs only what the
    UI may.
  - A detected AI agent needs its own acknowledgement to change data,
    `--i-understand-an-agent-is-writing` or `SIGNUM_ALLOW_AGENT_WRITES=1`, besides `--yes`; the one
    for reading data does not count. Without it the write is refused with exit 9 (AC-46.7).
  - Construct, construct-from and delete operations (#118). A Save that may run on a new record
    creates one when no record is named: `signum save order --edit Name=Acme --yes`. A constructor's
    result is reported as unsaved when it is; a delete's prompt says it cannot be undone, and a
    missing record is a clean not-found.
  - Operations over many records (#119): name several, `signum approve order 42 43 44` or repeated
    `--lite`, and one request reports one outcome per record. A partial failure is the new exit
    code 10 and lists which failed and why; all failing is 1. The confirmation names the count, and
    from 10 records (or any delete of several) the count must be typed back. `--dry-run` answers per
    record.
  - Values over many records (#119, AC-45.4): `--edit Member=value` with several records sets the
    member on each, and `--setters-json` takes the setter list itself for MList rows and new
    entities. Only for an operation that saves the entity it is given, and named in the confirmation.
  - Each record's outcome is shown and logged the moment the server reports it. Ctrl-C stops a batch
    and reports how far it got; the new exit code 130 means interrupted (AC-45.6).
  - `--lite` and `--id` read a list of records from `@file` or `-` (stdin), including the rows of
    `query -o ndjson`, so a query's answer can be piped into the operation that acts on it.
  - `--progress` runs one record through `executeLiteWithProgress` and shows the server's progress
    (AC-45.2).
- **Profiles: several applications, kept apart** (#121). A profile is a target: an instance or a
  URL, its credential, its metadata cache and its handle store. `signum auth switch <instance>`
  makes one the default; `--url`/`-i`, then `SIGNUM_URL`/`SIGNUM_INSTANCE`, still come first, and
  setting both variables is now refused rather than one silently winning. `auth status` lists every
  profile and marks the active one and the default, and a write's confirmation names the instance
  beside the URL.
- **`--explain` on every command that sends a request** (#122), not only `query`, `get` and
  operations: `auth login` and `auth status`, `version`, the discovery commands, `unmask --labels
  fetch`. It is enforced in the HTTP client, so a command added later gets it too. Every preview
  now shows the request's headers, credentials redacted. `--trace` is an alias of `--verbose`.
- **`get --pack` and `get <Type>`** (#138). `signum get Order 42 --pack` returns the entity with
  `canExecute`, what this login may do to it, in one call. `signum get Country` lists every record
  of a master-data type (`--top n`, default 50, or `--all`); a transactional type is refused in
  favour of `query --entities`, which pages.
- **Structured input from files and stdin** (#120). `-f <file|@file|->` saves an edited entity
  document: write it with `signum get Order;42 -o json`, change what you need, and
  `signum save order -f order.json --yes` applies only what you changed — also to a pseudonymized
  copy, whose surrogates and handles are recognised and never written back. A document written
  before the record changed is a conflict (exit 7); one without an id creates a record, so a
  constructor's output can be piped into the Save that stores it. `--filter-json -` now reads stdin.
  One reader serves every such flag: UTF-8 whatever the codepage (invalid bytes are refused), a
  missing file is a usage error naming it, and two flags both reading stdin are refused.
- **`query --all` pages and streams** (AC-23.3–23.5). It fetched everything in one response; now it
  asks for a page at a time (1000 rows, `--page-size` to change it) and writes each as it arrives.
  At a terminal, a result of 10 000 rows or more is confirmed first (`--yes` skips the question).
  Ctrl-C stops between pages with the output still valid, and exits 130. A result that changes
  while it is paged is reported, since a row may then be missed or repeated.

## 0.2.1 — 2026-10-23

A patch release of the read-only core. Four of the fixes come from using 0.2.0 against a live
application (#149 to #152); #157 was found while fixing #152. Two concern privacy under an AI
caller: an `Id` column no longer reaches it as the real database id (#157), and an allowlist in
`privacy.json` now reads some members and nothing else (#152).

### Fixed

- `query` says that a page is partial in every output format, not only in `-o table` (#149). JSON,
  the default on a pipe, used to carry no marker, so 50 rows of 56 looked like the whole result.
  The "N of M rows visible to you" line goes to stderr, so stdout still carries only the rows.
- `get` no longer rejects an entity whose response lists `temporalId` after the data members
  (#150). The serializer moves special members ahead of the data members itself, so such an entity
  can also be sent back. A response that breaks one of the other rules now says it came from the
  server, rather than that the CLI refused to send it.
- Output to a pipe is no longer cut off after 64 KiB (#151). The CLI exited before stdout had
  drained, so a script or agent reading more than that got truncated JSON with exit 0. It now ends
  once every write has reached the pipe.
- `get` shows an allowlisted reference with its display text under `strict`, as `query` does
  (#152). It used to mask it. What the reference or an embedded value contains is still judged
  member by member, so allowing `Customer` does not reveal the customer's email. `privacy.json`
  with `"mode": "strict"` and an `allow` list now reads some members and nothing else on every
  command, and the warning printed when pseudonymization is loosened to `off` points to it.
- An `Id` column (`--column Entity.Id`, `Id`, `Entity.Customer.Id`) no longer gives an AI caller
  the real database id under the default policy (#157), and the stderr note no longer says nothing
  was replaced. The id becomes the record's `ref_` handle, the same one its `Entity` column gets,
  when the server's property route names the type; otherwise it is masked as a plain value.

## 0.2.0 — 2026-10-21

The first full release: milestone **m1**, the read-only core. It follows the pre-releases
`0.1.0-b.1` to `0.1.0-b.5`. Every m1 requirement was run against a live Signum application before
release (REQ-077, `test/*.live.test.ts`); the one exception is noted under exit codes.

### Commands

- `auth login | status | logout`: the browser token handoff, one stored credential per target, and
  `SIGNUM_TOKEN` for non-interactive runs. A token the server rotates is stored.
- `instance add | list | remove`: register a target by name and use it with `-i <name>`.
- `types`, `queries`, `operations`, `explain`: discovery from the application's reflection
  metadata, including enums, symbols and query tokens.
- `query`: filters, columns, orders, paging and counts, plus `--lites` and `--entities`. Tokens and
  filter values are checked before anything is sent.
- `get`: retrieve an entity by type and id or by Lite key, or check it with `--exists`.
- `unmask`: turn pseudonymized handles back into the records they stand for, locally.
- `cache`, `version`.

### Behaviour

- **Output:** a table at a terminal and JSON in a pipe. `-o table|json|csv|tsv|ndjson|name` always
  wins, or is refused (exit 2) by a command that cannot write that format. Honours `NO_COLOR`.
  Data goes to stdout and diagnostics to stderr.
- **Exit codes 0–9** ([CLI surface §5](docs/design/cli-surface.md)). "Not authenticated" (3) and
  "not authorized" (4) are told apart even though the server answers 403 for both. Exit 4 is
  covered by the offline tests only: the live application's login was denied nothing.
- **AI callers** are detected, and row data reaches them only pseudonymized
  ([ADR 0007](docs/decisions/0007-ai-caller-detection-and-pseudonymization.md)). Detection is not a
  security boundary.
- **Metadata cache:** per target, revalidated with `If-Modified-Since`, anonymous and logged-in
  documents kept apart, and usable `--offline`.
- **Without a login,** an application with Signum.Authorization shows no entity at all. The CLI says
  so, and points to `signum auth login` rather than calling a hidden type unknown.
- **Help** works with no configuration, credential or network. `-o json` gives structured help.

### Known limitations

- Read only: saving entities and executing operations are milestone m2.
- `signum query <key> --help` shows the command's static help; help per query is m2. Use
  `signum explain <Query>` meanwhile.
- The binaries are not signed with a Developer ID or notarized, so macOS quarantines a downloaded
  one (REQ-073, #43).
- No license has been chosen yet (`package.json`: `UNLICENSED`).
