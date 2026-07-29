# User Stories — Querying

Stories for the read surface of `signum-cli`. Unlike [requirements](../requirements.md), stories
carry **acceptance criteria**.

Filter syntax spec: [`../design/filter-expression-syntax.md`](../design/filter-expression-syntax.md).
Wire contract: [`../http-api.md`](../http-api.md). Claims about framework behaviour are cited to
`file:line`.

---

## STORY-20 — Run a query

Traces to: REQ-020, REQ-021 · Priority: `m1`

**As an operator**, I want to run a query against the target app with filters, chosen columns and a
sort, so that I can answer a question about production data without opening the web UI.

**Acceptance Criteria:**
- AC-20.1: `signum query <queryKey>` issues `POST api/query/executeQuery/{queryKey}` and renders the result.
- AC-20.2: `--filter` accepts the expression syntax; repeating it `and`s the expressions.
- AC-20.3: `--column` selects columns by token, repeatable and order-preserving. Omitted, the query's default columns are used.
- AC-20.4: `--order <token>` sorts ascending, `--order -<token>` descending, mapping to `OrderType.Ascending|Descending` (`Order.cs:41-45`). Repeatable, precedence in the order given.
- AC-20.5: `--filter-json` accepts a raw `FilterTS[]` from a file (`path` or `@path`) and composes with `--filter` by `and`. `-` (stdin) is `m2`: request building is synchronous and stdin needs an async read, so it currently raises a clean usage error pointing at the file form rather than pretending to work.
- AC-20.6: `--explain` prints the composed `QueryRequestTS` and exits **without sending it**.
- AC-20.7: The **query key** is validated against cached metadata before the request, so a typo costs no round trip, and against the same definition `signum queries` lists from. Named **`--column` and `--order`** tokens are validated via `api/query/parseTokens` before the request, in one round trip for both slots, with the server's own list of valid continuations in the error (#95). **Filter tokens are not yet** — extracting them from a lowered filter tree, including `--filter-json`, is the remaining piece; REQ-012 landing removed the blocker that deferred all three, so this is now unfinished work rather than a milestone boundary. *(Amended: an earlier version deferred column/order validation to `m2` on the REQ-012 dependency. That dependency shipped, and the deferral outlived it — validation was in fact already happening, but only as an accident of the `--resolve` flag, so the same invalid column produced a precise error or a generic one depending on an unrelated flag.)*
- AC-20.8: Enum, date, number, boolean, `null` and `Lite` values are parsed **culture-invariantly**. *(Amended: the "regardless of `--culture`" clause is dropped for m1 — no `--culture` flag exists yet (REQ-055, `m2`). Invariance is unconditional today, which is the stronger property; the clause returns with the flag.)*

---

## STORY-21 — Trust the numbers

Traces to: REQ-022 · Priority: `m1`

**As an operator** acting on query output, I want the values to be the real values, so that I never
make a decision on a mis-decoded result.

This is the correctness story. `ResultTable` is **column-interned**: `rows[i].columns[j]` may be an
*index* into `uniqueValues[columns[j]]` rather than a value, and the `Entity` column is hoisted out
into `rows[i].entity` (`ResultTableConverter.cs:71-78`). Decoded wrong, the CLI emits
plausible-looking rows containing the wrong data — the worst possible failure for a tool people
script against.

**Acceptance Criteria:**
- AC-21.1: De-interning happens in exactly **one** place, before any output path — table, CSV, TSV, JSON, NDJSON, and MCP tool results all consume the normalized form.
- AC-21.2: The hoisted `Entity` column is reinserted at its declared position, so column order matches what the user asked for.
- AC-21.3: Round-trip tests cover both an interned and a non-interned response, plus a response where an interned column contains `null`.
- AC-21.4: A response whose column index is out of range for `uniqueValues` fails loudly. It is never rendered as null or blank.
- AC-21.5: `totalElements` is reported distinctly from the number of rows returned, so a paginated result is never mistaken for a complete one.

---

## STORY-22 — Read it, or pipe it

Traces to: REQ-024, REQ-050 · Priority: `m1`

**As a developer at a terminal and as a script**, I want output that is readable when I am watching
and structured when I am piping, so that the same command serves both without a flag dance.

**Acceptance Criteria:**
- AC-22.1: TTY on stdout → aligned table with colour. Not a TTY → JSON. Explicit `--json`/`--csv`/`--tsv`/`--ndjson` always wins.
- AC-22.2: Data on stdout, diagnostics on stderr, always — piping is never corrupted by a warning.
- AC-22.3: `NO_COLOR` is respected; `--no-color` also available.
- AC-22.4: Wide values are truncated **only** in the human table form, with truncation visibly marked. Machine formats are never truncated.
- AC-22.5: `--ndjson` streams one row per line so large results do not buffer in memory.
- AC-22.6: An empty result is a success (exit 0) with an explicit "no rows" on stderr for humans and an empty array/stream for machines.

---

## STORY-23 — Page through, or take everything

Traces to: REQ-024 · Priority: `m1`

**As an operator** extracting a large result, I want pagination handled for me, so that I get every
row without writing a loop or melting the server.

`PaginationMode` is `All | Firsts | Paginate` (`QueryRequest.cs:122-129`).

**Acceptance Criteria:**
- AC-23.1: `--top N` → `Firsts`; `--page N --page-size M` → `Paginate`; `--all` → transparent paging.
- AC-23.2: Default is a bounded page, never `All`. An unbounded query must be asked for explicitly — this protects a shared production server from a careless first command.
- AC-23.3: `m2` — `--all` pages until exhausted and **streams** rather than accumulating. **Not delivered in m1:** `--all` sends `PaginationMode.All` and lets the server return everything in one response, which is correct but buffers it. The client-side paging loop is m2.
- AC-23.4: `m2` — With `--all`, if `totalElements` implies a very large result, a TTY user is warned and asked to confirm; non-interactively it proceeds (a script asked for it). **Not delivered in m1** — depends on AC-23.3's paging loop to know the size before transferring.
- AC-23.5: `m2` — Interrupting `--all` mid-stream leaves already-emitted output valid — no partial trailing record. **Vacuous until AC-23.3 lands:** nothing streams today, so output is written only after the whole response has arrived.
- AC-23.6: `--count` uses `queryValue` to return only the count, with no row transfer.

---

## STORY-24 — Discover what I can ask

Traces to: REQ-010, REQ-011 (`m1`), REQ-012 (`m2`) · Priority: `m1`, **partially**

> **Milestone split:** AC-24.1/3/4/5/6 are m1 — they render the cached `api/reflection/types`
> document. AC-24.2 (live `subTokens`/`parseTokens`) is m2 with REQ-012.

**As a developer or agent** meeting an unfamiliar Signum app, I want to discover its queries, types
and valid tokens, so that I can write a correct filter without reading the app's source.

**Acceptance Criteria:**
- AC-24.1: Commands list the app's queries, types, and each type's members, entity kind, and operations, from the cached `api/reflection/types`.
- AC-24.2: A token-explore command lists valid continuations of a token prefix via `POST api/query/subTokens`, and validates a full token via `parseTokens`.
- AC-24.3: The metadata cache is **per-target and per auth state**, keyed by `Last-Modified`, revalidated with `If-Modified-Since`, and explicitly clearable via `signum cache clear`. *(Amended: "per-profile" → "per-target"; named profiles are REQ-001/`m2`. The auth-state split is not cosmetic — `AuthServer.cs:143-157` rewrites `queryDefined` per caller and `ReflectionServer.LastModified` is process-wide, so one document would be revalidated with a 304 and handed to the wrong caller.)*
- AC-24.4: With a warm cache, discovery works **fully offline**.
- AC-24.5: `--json` output is stable enough to drive shell completion and MCP tool schemas.
- AC-24.6: Metadata is presented as a **positive capability list only**. Operations forbidden to the user *vanish* from `canExecute` with no reason given (`OperationLogic.cs:456`), so absence is never reported as "does not exist".
- AC-24.7: `.Nested` tokens are marked unusable in `executeQuery` where they appear in `subTokens` output (`FilterJsonConverter.cs:87-153`).

---

## STORY-25 — Group and aggregate

Traces to: REQ-023 · Priority: `m3`

**As an operator**, I want counts and sums grouped by a column, so that I can get a summary without
exporting every row.

**Acceptance Criteria:**
- AC-25.1: `--group` sets `groupResults: true`.
- AC-25.2: Aggregate tokens are supported: `Count`, `Sum`, `Min`, `Max`, `Average`, `CountDistinct`, `CountNull`, `CountNotNull`, `CountTrue`.
- AC-25.3: An aggregate token without `--group` is a **clear client-side error**, not a forwarded request that fails server-side.
- AC-25.4: `SubTokensOptions` differing per slot is respected — a token legal as a column is not assumed legal as a filter or order.
- AC-25.5: Aggregates work in `--filter` (HAVING semantics) as well as in columns.

---

## STORY-26 — Resolve an entity by name

Traces to: REQ-026 · Priority: `m3`

**As an operator**, I want to name an entity the way a human would rather than by id, so that I can
write a filter without first looking up a primary key.

**Acceptance Criteria:**
- AC-26.1: A lookup command wraps `api/query/findLiteLike?types=&subString=&count=` and returns matching `Lite`s.
- AC-26.2: Output includes the `TypeName;id` key in a form directly pasteable into a filter.
- AC-26.3: An ambiguous match lists candidates and exits non-zero rather than picking one.
- AC-26.4: Machine output is stable, so an agent can chain lookup into a subsequent query.

---

## STORY-27 — Temporal queries

Traces to: REQ-025 · Priority: `m3`

**As an auditor** on a `Signum.TimeMachine`-enabled app, I want to query data as it was at a past
moment, so that I can reconstruct history.

**Acceptance Criteria:**
- AC-27.1: `--as-of <instant>` sets `systemTime` on the request.
- AC-27.2: Apps without temporal support fail with a clear "not enabled" message, not a generic 500.
- AC-27.3: The effective `systemTime` is echoed in human output, so a temporal result is never mistaken for current data.
- AC-27.4: Postgres emulates temporal tables via a PL/pgSQL trigger while SQL Server uses native temporal tables; any behavioural difference found in testing is documented rather than papered over.

---

## Traceability

| Story | Requirements | Milestone |
|---|---|---|
| STORY-20 Run a query | REQ-020, REQ-021 | `m1` |
| STORY-21 Trust the numbers | REQ-022 | `m1` |
| STORY-22 Read it, or pipe it | REQ-024, REQ-050 | `m1` |
| STORY-23 Page through | REQ-024 | `m1` |
| STORY-24 Discover what I can ask | REQ-010, REQ-011, REQ-012 | `m1` |
| STORY-25 Group and aggregate | REQ-023 | `m3` |
| STORY-26 Resolve by name | REQ-026 | `m3` |
| STORY-27 Temporal queries | REQ-025 | `m3` |

## Not covered here

- Writes and operations — a separate story set, not yet written.
- Output of entity *documents* (as opposed to query rows) — belongs with the entity stories.
- MCP tool exposure of these commands — REQ-060/061, tracked with the MCP work.
