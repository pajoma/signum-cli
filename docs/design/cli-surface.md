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
| `signum <OperationKey>` | m2 | **Operations are first-class commands** — see §2.1. All mutation lives here. |
| `signum lookup <Type> <text>` | m3 | Resolve a human string to a `Lite` (`findLiteLike`). |
| `signum api <method> <path>` | m2 | Raw request escape hatch. |

### 2.1 Operations are first-class commands

Operations are not a generic "run this thing" — they are the application's **named business actions**,
and the *only* way anything is mutated ([`operations.md`](../stories/operations.md)). Hiding them behind
a `run` verb would make the most important concept in the API the least visible one. So the operation
key **is** the command:

```bash
signum Order.Ship --lite "Order;42"
signum UserOperation.Save -f user.json
signum Order.Create --arg-lite Customer="Customer;7"     # construct: no target
```

**Why this is unambiguous.** Operation keys always contain a dot — `Key = declaringType.Name + "." +
fieldName` (`Signum/Basics/Symbol.cs:22`, verified) — and **no built-in command ever contains one**. So
dispatch is a single rule with no collision possible, now or as we add commands:

> If the first argument contains a `.`, it is an operation key. Otherwise it is a built-in command.

This also means an app can name an operation container `Query` or `Get` without shadowing anything: the
built-in is `query`, the operation is `Query.Something`.

**Discovery is part of being first-class.** All read-only, so all m1:

```bash
signum operations                 # every operation the app exposes
signum operations Order           # just this type's
signum explain Order.Ship         # arguments, target kind, canExecute reasons
signum Order.Ship --help          # same, reached the way you'd expect
```

**Resolution rules** (REQ-041, STORY-41):

- A full key (`OrderOperation.Ship`) is used verbatim.
- A bare name (`Ship`) resolves against the target type's operations from cached metadata; **ambiguity
  lists candidates and exits non-zero** rather than guessing.
- A namespace-qualified key (`MyApp.Operations.OrderOperation.Ship`) is rejected with an explanation —
  keys are *not* namespace-qualified, and this is a common wrong guess.
- Unknown keys suggest near-matches from metadata.

**Targets** follow the wire's own distinction (`executeEntity` vs `executeLite`): `--lite` / `--id` for
an identity, `-f` for a full entity graph, `--lite` repeated or `-f -` for the multi variants. No target
at all means `construct`.

**Not in m1.** Every operation command is m2 — m1 is read-only and cannot mutate. `signum operations`
and `signum explain <Key>` *are* m1, because listing and describing operations is discovery, not
mutation.

### Tooling commands (noun-verb)

| Command | Milestone | Purpose |
|---|---|---|
| `signum auth login` · `logout` · `status` | **m1** | Credentials. `status` is the first thing to run when something breaks. |
| `signum auth token` | m2 | Print the stored token (guarded; see §7). |
| `signum config get-contexts` · `use-context` · `set-context` · `current-context` | m2 | Target selection. |
| `signum mcp` | m3 | Serve the command set over MCP on stdio. |
| `signum de-pseudonymize <ref…>` | m2 | Human-only resolution of `ref:` handles (AC-53.4). Refused under an agent context. |
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
signum Order.Ship --lite "Order;42" --dry-run=server          # permitted?
signum Order.Ship --lite "Order;42" --yes
signum UserOperation.Save -f user.json
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
| `signum <OperationKey>` (no verb) | `run`, `operation execute`, `exec`, `op` | Operations are the app's named business actions and the only mutation path; a generic verb would make the most important concept the least visible. The dot in every key (`Symbol.cs:22`) makes dispatch unambiguous against built-ins, so no verb is needed. Also sidesteps the `kubectl run` collision entirely. |
| `signum query` | `get` for both | Queries and entity retrieval are different endpoints with different shapes; one verb would blur `queryKey` and `Type`. |
| `signum explain` | `describe` | kubectl's `describe` dumps an *instance*; `explain` walks a *schema*. We mean the schema. `describe` stays free for a future instance-detail view. |
| `context` | `profile` | It bundles URL + credential + metadata cache, matching kubectl's meaning precisely. |
| `--filter` | `--selector`/`-l` | kubectl selectors are label equality; ours is a full expression language ([filter syntax](filter-expression-syntax.md)). Reusing `-l` would promise the wrong semantics. |

## 9. m1 surface, complete

Everything m1 needs, and nothing more:

```
signum version
signum auth login --with-token | --url <url>
signum auth status
signum types
signum queries
signum explain <Type>[.<token>] | <OperationKey>
signum operations [<Type>]
signum query <queryKey> [--filter …] [--column …] [--order …] [--top N] [--all] [--count]
signum get <Type> <id> | <Lite>  [--exists]

globals: --url  -o/--output  --json  --explain  -v  --no-color  --timeout
         --caller-context
```

That is 9 commands. It authenticates, discovers (including *which* operations exist and what they take),
queries, and retrieves — with trustworthy output and meaningful exit codes — and it cannot mutate
anything.

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
