# Design — CLI surface

The command surface of `signum`. Modelled on `gh` and `kubectl`, which disagree about structure in a
way that turns out to be decisive here.

**Status:** DRAFT for review. Nothing implemented. Commands marked **m1** are the
[first milestone](../requirements.md); the rest are specified so the shape is coherent, not because
they are next.

---

## 1. Why verb-first, mostly

`gh` is **noun-verb** (`gh pr list`, `gh issue create`). `kubectl` is **verb-noun**
(`kubectl get pods`, `kubectl describe node`).

The difference is not stylistic — it follows from whether the noun set is fixed. `gh` knows every noun
it will ever have: PRs, issues, repos, releases. `kubectl` does not: resource types are supplied by the
cluster at runtime, discovered via `api-resources`.

**Signum is the kubectl case.** The type and query names come from the target application, discovered
at runtime from `api/reflection/types`. We cannot ship a `signum order ...` subcommand, because
`Order` is one customer's noun. So data commands are **verb-first**, with the app's noun as an
argument.

But tool-management nouns *are* fixed — authentication, contexts, the MCP server. Those get
`gh`-style **noun-verb** groups. kubectl does exactly the same thing with `kubectl config <verb>`.

```
signum <verb> <app-noun> [args]      # data      — kubectl-shaped
signum <tool-noun> <verb> [args]     # tooling   — gh-shaped
```

## 2. Command tree

### Data commands (verb-first)

| Command | Milestone | Purpose |
|---|---|---|
| `signum query <queryKey>` | **m1** | Run a dynamic query. The workhorse. `--count` returns only the count via `queryValue` (AC-23.6). |
| `signum get <Type> <id>` · `signum get <Lite>` | **m1** | Retrieve one entity. Accepts `Order;42` or a `ref:` handle. `--exists` checks presence only (`api/exists`). |
| `signum get <Type>` | m2 | No id ⇒ bounded listing (`api/fetchAll`), kubectl-style. Always bounded; warns on a TTY that it is unfiltered. |
| `signum explain <Type>[.<token>]` | **m1** | Describe a type, its members, and valid next query tokens. |
| `signum types` · `signum queries` | **m1** | List what the app offers. |
| `signum operations [<Type>]` | **m1** | List invokable operations. Read-only discovery, so it lands with REQ-011. |
| `signum <verb> <Type> [id]` | m2 | **Operations are first-class commands** — `signum ship order 42`. See §2.1. All mutation lives here. Canonical form: `signum <OperationKey>`. |
| `signum lookup <Type> <text>` | m3 | Resolve a human string to a `Lite` (`findLiteLike`). |
| `signum api <method> <path>` | m2 | Raw request escape hatch. |

### 2.1 Operations are first-class commands

Operations are the application's **named business actions** and the *only* way anything is mutated
([`operations.md`](../stories/operations.md)). They are not a generic "run this thing", so they get no
generic verb. Instead they read as what they are:

```bash
signum create order
signum ship order 42
signum save user -f user.json
signum cancel workflow 17 --yes
signum import-public-holidays holiday-calendar 3
```

This is the same `<verb> <noun> [name]` shape as `kubectl delete pod my-pod`, and it keeps the whole
data surface verb-first rather than making mutation the one place with a different grammar.

**It decomposes from the wire, not from a convention we invented.** An operation key is
`declaringType.Name + "." + fieldName` (`Signum/Basics/Symbol.cs:22`), and containers are consistently
named `<Something>Operation` with PascalCase verb fields — verified across the framework:
`WorkflowOperation.Activate`, `UserOperation.Save`, `HolidayCalendarOperation.ImportPublicHolidays`. So
the field name *is* the verb.

**The noun comes from metadata, not from parsing the container name.** Operations are registered against
an entity type, and `api/reflection/types` tells us which. Deriving `Order` by stripping `Operation` off
`OrderOperation` would be guesswork; looking up which type the operation belongs to is a fact. This
matters for the irregular cases.

#### Dispatch, in order

1. **First argument contains a `.`** ⇒ canonical operation key (see below).
2. **Otherwise it matches a built-in** (`query`, `get`, `explain`, `auth`, …) ⇒ built-in. **Built-ins
   always win.**
3. **Otherwise** ⇒ resolve `<verb> <Type>` against cached operation metadata.

Rule 2 is the cost of this shape. If an app declares `OrderOperation.Get`, then `signum get order`
means the *built-in* retrieve, and the operation is shadowed. That is a real ambiguity the earlier
dot-only design did not have, and it is accepted because the ergonomics are worth it. It is handled, not
ignored:

- Shadowed operations are **flagged in `signum operations <Type>`** output, so you find out from
  discovery rather than from surprise.
- They remain reachable by canonical key.
- The built-in set is small, fixed, and lowercase; collisions will be rare.

#### Canonical form

The dotted key stays as the unambiguous form, and is what `--explain` prints, what the MCP tool layer
uses, and what to write in scripts where a future built-in might shadow a verb:

```bash
signum OrderOperation.Ship --lite "Order;42"     # canonical
signum ship order 42                             # ergonomic, same call
```

#### Matching rules

- **Case-insensitive and kebab-tolerant** in both positions: `signum create order`,
  `signum create Order`, `signum import-public-holidays holiday-calendar` and
  `signum ImportPublicHolidays HolidayCalendar` are all the same command. Output always renders the
  app's own PascalCase.
- The target is positional — `signum ship order 42` — with `--lite`, `--id` and `-f` available when
  positional is ambiguous or a full entity graph is needed.
- **No target ⇒ construct.** `signum create order` maps to `construct`, matching `kubectl create`.
- An unknown verb for a known type lists that type's operations; an unknown type suggests near matches.
- **Ambiguity is never guessed** — two operations resolving to the same verb on one type is an error
  naming both canonical keys (STORY-41).

#### Discovery is part of being first-class — and it is m1

All read-only, so it ships in the read-only milestone even though *invoking* an operation is m2:

```bash
signum operations                 # every operation the app exposes
signum operations Order           # just this type's, with shadowed verbs flagged
signum explain Order.Ship         # arguments, target kind, canExecute reasons
signum ship order --help          # same, reached the way you would expect
```

### Tooling commands (noun-verb)

| Command | Milestone | Purpose |
|---|---|---|
| `signum auth login` · `logout` · `status` | **m1** | Credentials. `status` is the first thing to run when something breaks. |
| `signum auth token` | m2 | Print the stored token (guarded; see §7). |
| `signum config get-contexts` · `use-context` · `set-context` · `current-context` | m2 | Target selection. |
| `signum mcp` | m3 | Serve the command set over MCP on stdio. |
| `signum unmask <ref…>` | m2 | Human-only resolution of `ref:` handles (AC-53.4). Refused under an agent context. |
| `signum auth key create` · `show` | m3 | API-key provisioning. Not applicable to the target app — no `Signum.Rest` ([target profile](../target-application.md)). |
| `signum completion <shell>` | m3 | Shell completion. |
| `signum version` | **m1** | Version, and the target app's version when reachable. |

### Deliberate omissions

- **No `apply`/declarative reconciliation.** kubectl's defining feature, and wrong here: Signum has no
  desired-state model, and every mutation must go through a named operation
  ([`operations.md`](../stories/operations.md)). A `signum apply` would imply semantics the server does
  not offer.
- **No `--watch`.** There is no server push in the API; nothing to watch. Streaming is `--output ndjson`
  over a paged read instead.
- **No `edit`.** kubectl's `$EDITOR` round-trip is attractive but collides with `modified` propagation
  and `ticks` concurrency (STORY-32, STORY-33). Revisit once writes are proven.

## 2.2 Help at every level

Help is not an afterthought here, because **half the command tree does not exist until you point the
CLI at an application**. `signum query --help` can be written by us; `signum ship order --help` cannot —
it has to be generated from the target app's metadata.

So help has two layers, and the split determines what works when:

| Layer | Source | Works offline? | Needs auth? |
|---|---|---|---|
| **Static** — built-in commands, flags, topics | compiled in | yes | no |
| **Dynamic** — app types, queries, operations, tokens | metadata cache | with a warm cache | **no** — see below |

**Dynamic help needs no credentials.** `GET api/reflection/types` is `[SignumAllowAnonymous]`
(verified), so `signum --url https://app query Order --help` works *before* logging in. Someone
evaluating the tool can explore an app's entire surface without an account. That is worth protecting as
a property.

### The levels

| # | Invocation | Shows |
|---|---|---|
| 0 | `signum`, `signum --help` | what the tool is, command groups, global flags, next steps |
| 1 | `signum query --help` | that command's flags, with executable examples |
| 2 | `signum auth --help`, `signum auth login --help` | group contents, then subcommand detail |
| 3 | `signum query <queryKey> --help` | **that query's** columns, default order, filterable tokens |
| 3 | `signum ship order --help` | **that operation's** arguments, target kind, `canExecute` reasons |
| 4 | `signum explain <Type>[.<token>]` | schema walk — members, kinds, valid next tokens |
| 5 | `signum help <topic>` | long-form: `filter`, `tokens`, `output`, `exit-codes`, `auth`, `contexts`, `pseudonymization` |
| 6 | *(on error)* | the help that would have prevented it — see below |

Level 3 is the one that makes this CLI usable against an app nobody has documented. `--help` on a
concrete noun is not a generic blurb; it is that application's actual schema.

### Rules

- **Help never requires authentication, and never requires a context.** Static help works with no
  configuration at all; dynamic help needs only a URL or a warm cache.
- **Degrade, never fail.** With no metadata available, level 3 prints the static portion plus one line
  saying what it could not resolve and how (`--url`, or refresh the cache). It does not error.
- **`--help` goes to stdout and exits 0.** An *unknown* command goes to stderr and exits 2 (usage). Help
  that was asked for is output; help that follows a mistake is a diagnostic.
- **Every help has examples**, `gh`-style, and they are executable exactly as written. Examples that
  drift from reality are worse than none, so they are covered by the docs test (REQ-077).
- **`-o json` works on any help**, emitting a structured description of commands, flags, and arguments.
  This is the **same source the MCP tool schemas are generated from** (REQ-061) — help and tool
  discovery must never be two hand-maintained descriptions of one command set.
- **Errors route to help.** An unknown token names the nearest valid ones and points at
  `signum explain <Type>`; an unparseable filter cites the rule it broke and points at
  `signum help filter`; an ambiguous operation verb lists candidates. This is level 6, and it is where
  help is actually read.
- **Shadowed operation verbs are disclosed** in `signum operations <Type>` and in level-3 help for the
  shadowing built-in, so the collision described in §2.1 is discoverable rather than mysterious.

### Why `-o json` help matters more than usual

Three of the four consumer types read help programmatically — an agent deciding which command to call,
the MCP layer building tool schemas, and shell completion. A CLI whose help is only prose forces each of
them to reimplement knowledge that already exists. One structured source, many renderings.

## 3. Global flags

| Flag | Milestone | Notes |
|---|---|---|
| `--context <name>` | m2 | Which target app. kubectl naming. |
| `--url <url>` | **m1** | Target directly, bypassing contexts. m1 has no context store yet. |
| `-o, --output <fmt>` | **m1** | `table`, `json`, `csv`, `tsv`, `ndjson`, `name`. |
| `--json` | **m1** | Alias for `-o json`, for `gh` muscle memory. |
| `--explain` | **m1** | Print the request that *would* be sent; send nothing. |
| `--dry-run=client\|server` | m2 | `client` ≡ `--explain`. `server` checks `canExecute` (REQ-043). |
| `-f, --filename <path\|->` | m2 | Input from file or stdin. `@file` also accepted. |
| `-y, --yes` | m2 | Skip confirmation. Required for mutations without a TTY. |
| `-v, --verbose` | **m1** | HTTP tracing, credentials redacted (AC-11.2). |
| `--no-color` | **m1** | Also honours `NO_COLOR`. |
| `--timeout <dur>` | **m1** | |
| `--caller-context <ctx>` | **m1** | Override agent detection. Loosening is logged (AC-50.4). |
| `--pseudonymize=off\|heuristic\|strict` | m2 | Default `heuristic` under a detected agent. |

**`--dry-run` deserves note.** kubectl's `client`/`server` split maps *exactly* onto a distinction we
already needed: `client` builds the request locally and shows it; `server` asks the app whether the
operation would be permitted, via `canExecute`. Borrowing the vocabulary means users already know what
it means.

## 4. Output model

kubectl's `-o` wins over `gh`'s `--json <fields> --jq <expr>`: it is one flag, it covers more formats,
and it is the more widely known idiom.

- **TTY → `table`. Not a TTY → `json`.** Explicit `-o` always wins (AC-22.1).
- Data on **stdout**, diagnostics on **stderr**, always (AC-22.2).
- `-o name` prints bare `Lite` keys, one per line, for piping into `xargs`.
- `-o ndjson` streams; nothing buffers (AC-22.5).

`-o jsonpath=` and a `--jq` post-filter are **deferred** — both need an expression engine, and `-o json`
piped into real `jq` covers it. Revisit only if the MCP path needs server-side projection.

## 5. Exit codes

`gh` uses 1 and 4; kubectl mostly uses 1. Neither is enough for REQ-051, because scripts and agents need
to distinguish "retry might help" from "stop".

| Code | Meaning | Retry? |
|---|---|---|
| 0 | Success | — |
| 1 | Unexpected error | no |
| 2 | Usage error — bad flags, unparseable filter | no |
| 3 | Not authenticated (403 + `AuthenticationException`) | after re-auth |
| 4 | Not authorized (403 + `UnauthorizedAccessException`) | **no** |
| 5 | Not found | no |
| 6 | Validation failed (400 `ValidationProblemDetails`) | after fixing input |
| 7 | Concurrency conflict (`ConcurrencyException`) | **yes**, after refetch |
| 8 | Transport/timeout | yes |
| 9 | Blocked by policy (agent context without acknowledgement, AC-51.1) | no |

3 and 4 must be distinguished even though **the server returns 403 for both** — the discriminator is
`exceptionType` (AC-08.2). This is the single most important thing the exit-code table encodes.

## 6. Worked examples

```bash
# ── m1: read-only ────────────────────────────────────────────────
signum auth login --with-token < token.txt
signum auth status

signum types                                  # what does this app have?
signum queries
signum explain Order                          # members and entity kind
signum explain Order.Entity.Customer          # valid next tokens

signum query Order --filter "State = Shipped" --top 20
signum query Order \
  --filter "Entity.Customer.Name ~ Acme and (State = Shipped or State = Delivered)" \
  --column Entity --column OrderDate --order -OrderDate \
  -o csv > orders.csv

signum get Order 42
signum get "Order;42" -o json | jq .toStr

signum query Order --filter "State = Stuck" -o name | head   # Lite keys for piping
signum query Order --filter "Total > 1000" --explain          # show request, send nothing

# ── m2: writes ───────────────────────────────────────────────────
signum operations Order                                       # (m1 — discovery)
signum explain Order.Ship                                     # (m1 — args + canExecute)
signum ship order 42 --dry-run=server                         # permitted?
signum ship order 42 --yes
signum save user -f user.json
signum create order --arg-lite Customer="Customer;7"
signum OrderOperation.Ship --lite "Order;42"                  # canonical form
signum api GET /api/entity/Order/42                           # escape hatch

# ── agent / scripted ─────────────────────────────────────────────
signum query Order --filter "State = Stuck" -o ndjson | while read -r row; do …; done
echo $?                                                       # 7 ⇒ refetch and retry
signum mcp                                                    # m3: serve over stdio
```

## 7. Conventions inherited, and where we differ

**From `gh`:**
- `auth login` / `logout` / `status` naming, and `status` as the universal diagnostic.
- Interactive when a TTY is present, fully flag-driven when not.
- A raw API escape hatch (`gh api` → `signum api`), which matters more here because the Signum API is
  generic and will always outrun our command coverage.
- `--json` accepted as an alias, purely for muscle memory.

**From `kubectl`:**
- Verb-first for runtime-discovered nouns.
- `-o` as the single output selector.
- `explain` for schema discovery — an unusually good fit, since Signum's QueryToken tree is exactly the
  kind of nested schema `kubectl explain` was built to walk.
- `--dry-run=client|server`.
- Contexts, rather than gh's flatter auth model, because a Signum target is a URL *plus* a credential
  *plus* a metadata cache — that is a context, not an account.

**Where we deliberately differ:**
- **`signum auth token` is guarded.** `gh auth token` prints the token freely. Ours requires
  `--yes` on a TTY and refuses outright under a detected agent context, because the whole point of
  ADR 0007 is keeping credentials out of a model's context.
- **No implicit "current namespace" equivalent.** kubectl's implicit namespace causes wrong-target
  accidents; given mutations here hit business data, the active context is **printed in every
  confirmation prompt** (AC-46.1) rather than left implicit.
- **Mutations fail without a TTY unless `--yes`.** kubectl happily deletes non-interactively. Ours
  refuses rather than prompting, so a script can never hang *and* never mutate by accident (AC-46.3).

## 8. Naming decisions

| Chosen | Over | Why |
|---|---|---|
| `signum <verb> <Type>` — `signum create order` | `run <Key>`, `operation execute`, `exec`, `op`, bare `<OperationKey>` | Operations are the app's named business actions and the only mutation path; a generic verb makes the most important concept the least visible. Verb-noun keeps the whole data surface one grammar and reads like `kubectl delete pod`. The dotted key remains as the canonical unambiguous form. |
| `signum query` | `get` for both | Queries and entity retrieval are different endpoints with different shapes; one verb would blur `queryKey` and `Type`. |
| `signum explain` | `describe` | kubectl's `describe` dumps an *instance*; `explain` walks a *schema*. We mean the schema. `describe` stays free for a future instance-detail view. |
| `context` | `profile` | It bundles URL + credential + metadata cache, matching kubectl's meaning precisely. |
| `--filter` | `--selector`/`-l` | kubectl selectors are label equality; ours is a full expression language ([filter syntax](filter-expression-syntax.md)). Reusing `-l` would promise the wrong semantics. |

## 9. m1 surface, complete

Everything m1 needs, and nothing more:

```
signum help [<topic>]               # topics: filter, tokens, output, exit-codes, auth, …
signum <any command> --help         # static; dynamic where a Type/queryKey is named
signum version
signum auth login --with-token | --url <url>
signum auth status
signum types
signum queries
signum explain <Type>[.<token>] | <OperationKey>
signum operations [<Type>]          # invokable actions; shadowed verbs flagged
signum query <queryKey> [--filter …] [--column …] [--order …] [--top N] [--all] [--count]
signum get <Type> <id> | <Lite>  [--exists]

globals: --url  -o/--output  --json  --explain  -v  --no-color  --timeout
         --caller-context
```

That is 10 commands. It authenticates, discovers (including *which* operations exist and what they take),
queries, retrieves, and **explains itself at every level — without credentials** — with trustworthy output
and meaningful exit codes. It cannot mutate anything.

## 10. Open questions

1. ~~`run` vs `op` as the mutation verb~~ — **resolved**: no verb. Operations are first-class commands (§2.1).
2. **Should `query` accept a bare `Type`** and infer the queryKey? Convenient, and it hides a real
   distinction. Leaning no.
3. **Do we need `-o wide`?** kubectl's default-plus-extra-columns idea may not map to a query whose
   columns are already user-chosen.
4. **User-defined aliases** (`gh alias set`) — worth it, or does `-o name` plus shell functions cover it?
5. **`signum api`** — should it apply pseudonymization? It bypasses our rendering path, so it may also
   bypass ADR 0007's protections. Leaning yes, with a `--raw` override that is refused under an agent
   context.
