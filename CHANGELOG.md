# Changelog

Notable changes to signum-cli. Versions are [SemVer](https://semver.org/), and `package.json` is the
source of truth: a release tag `v<version>` must match it (see the README's release section).

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
