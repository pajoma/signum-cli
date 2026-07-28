# Live verification runbook

**For:** an agent or engineer with `signum` installed and network access to a real Signum
application. **Not** runnable in the dev environment — that machine has no access to any app.

**Why this exists:** REQ-077. **Nothing in this repository has ever run against a live Signum
application.** Every wire claim in `docs/http-api.md` is read from framework source, and every
integration test runs against a mock whose fixtures encode what that source *says* the wire looks
like. `test/integration.test.ts` states this in its own header.

So this run is not a smoke test. It is the step that converts 51 requirements from *implemented* to
*delivered*, and the step that decides whether the fixtures are right. **Where the live application
disagrees with a fixture, the application wins and the fixture changes.**

---

## Rules — read before running anything

These are not optional and they are not merely style.

1. **The token is a credential. It never appears in your transcript, in a file, or in a commit.**
   Put it in an environment variable and reference it. Never echo it. Never paste it into a message
   even truncated. If you think you have leaked one, say so immediately — it is rotatable, but only
   if someone knows.

2. **Report structure, never content.** You are verifying *shapes*: field names, types, whether a
   cell is an index or a value. You are not verifying data. Never paste a row, an entity, a customer
   name, an id, or a `toStr` into your output. The jq recipes below exist to make this easy.

3. **The application holds real personal data.** It is a production business system. Treat every
   value as confidential by default.

4. **You are an AI caller, and the CLI is designed to refuse you data.** That refusal is a *feature*
   under test (ADR 0007, AC-51.1). Verify it fires. Do **not** routinely bypass it with
   `--i-understand-data-goes-to-a-model` — the one place a bypass is needed is marked below, and it
   should be run by the human, or with their explicit go-ahead, on the narrowest query available.

5. **Read only.** m1 has no write commands. Do not `curl` a `POST api/operation/*` route to "see what
   happens". Do not `--refresh`-loop anything. One request per check.

6. **Keep the application's identity out of anything committed.** The hostname, and possibly the
   type names, identify a customer. Use `$SIGNUM_URL` in commands and placeholders in any fixture
   you propose. Ask the human before committing real type names.

---

## Setup

```bash
export SIGNUM_URL="https://<app>"          # ask the human
export SIGNUM_CONFIG_DIR="$(mktemp -d)"    # isolate from any existing credential
signum version
```

Obtain a token (human does this, once):

1. Sign in to the web application in a browser.
2. Console: `sessionStorage.getItem("authToken")`
3. `export SIGNUM_TOKEN='<paste>'` — **in the shell, not in a file, not in the transcript.**

> `SIGNUM_TOKEN` is deliberately never persisted, so nothing lands on disk. If you would rather
> store it, `printf %s "$SIGNUM_TOKEN" | signum auth login --url "$SIGNUM_URL" --with-token` writes
> it to `$SIGNUM_CONFIG_DIR/credential.json` at mode 0600.

---

## Phase 1 — anonymous, no credential (safest; start here)

Unset the token first: `unset SIGNUM_TOKEN`.

| # | Command | What must hold | Fixture it validates |
|---|---|---|---|
| 1.1 | `curl -s -o /dev/null -w '%{http_code}\n' "$SIGNUM_URL/api/reflection/types"` | `200`. This is the anonymous-discovery promise (AC-61.4) | — |
| 1.2 | `curl -s -o /dev/null -w '%{http_code}\n' "$SIGNUM_URL/api/auth/openIDEndpoints"` | **The outstanding probe from ADR 0008.** `404` with 1.1 at `200` ⇒ OpenID module absent, ADR 0008 stands. **Both 404** ⇒ wrong base URL, and OpenID loopback is back on the table | ADR 0008 |
| 1.3 | `signum types --json \| head -40` | Succeeds with no credential. Type names only — **do not** paste the full list if it names customers | `REFLECTION` |
| 1.4 | `signum queries --json` | **Expect an empty or near-empty list.** `AuthServer.cs:143-157` clears `queryDefined` for any query the caller may not run, and an anonymous caller may run none. An empty list here is the *correct* result, not a bug | the role-dependence claim |
| 1.5 | `signum cache show` | One entry, scope `anon` | cache split (#76) |
| 1.6 | `signum types --offline --json \| head -5` | Same data, no network | AC-24.4 |

**Record the reflection document's shape** (structure only — this is the highest-value artefact of
the whole run):

```bash
curl -s -H 'accept: application/json' "$SIGNUM_URL/api/reflection/types" \
  | jq -r '[paths(scalars) | map(if type=="number" then "[]" else . end) | join(".")]
           | unique | .[0:60][]'
```

Compare the key paths against `REFLECTION` in `test/integration.test.ts`. Specifically confirm:
`queryDefined` present-and-true only (never `false` — it is `[JsonIgnore(WhenWritingDefault)]`),
plus the `members` / `operations` / `kind` / `niceName` key names.

---

## Phase 2 — authenticated

`export SIGNUM_TOKEN='<token>'` again.

| # | Command | What must hold |
|---|---|---|
| 2.1 | `signum auth status` | Reports your username. Credential source `SIGNUM_TOKEN (environment…)`. **The token must not appear anywhere in the output** (AC-06.3) |
| 2.2 | `signum auth status --json` | `authenticated: true`, `user` set, `credential: "environment"` |
| 2.3 | `signum queries --json` | **Now non-empty**, unlike 1.4. This is the single cleanest confirmation that `queryDefined` is role-dependent and that splitting the cache by auth state was necessary |
| 2.4 | `signum cache show` | **Two** entries now — `anon` and `auth` — for the same URL |
| 2.5 | `signum types -v --json > /dev/null` | Trace shows `> Authorization: <redacted>`. **If a real token appears here, stop: that is a REQ-074 leak and a release blocker** |

Pick a query key from 2.3 for the rest. **Prefer the least personal thing available** — a config,
status, or lookup type over anything customer-shaped. Note it as `$Q`.

---

## Phase 3 — the correctness question (`ResultTable`)

This is what the whole project's correctness story rests on (REQ-022, STORY-21). A defect here
shipped once already and was caught in review, so verify it rather than trusting it.

**Structure only — never the values:**

```bash
curl -s -X POST "$SIGNUM_URL/api/query/executeQuery/$Q" \
  -H "Authorization: Bearer $SIGNUM_TOKEN" -H 'content-type: application/json' \
  -d '{"queryKey":"'"$Q"'","groupResults":false,"filters":[],"orders":[],
       "columns":[],"pagination":{"mode":"Firsts","elementsPerPage":2}}' \
  > /tmp/rt.json

# key paths, no values
jq -r '[paths(scalars) | map(if type=="number" then "[]" else . end) | join(".")] | unique[]' /tmp/rt.json
# is the Entity column hoisted out of `columns`?
jq -r '.columns' /tmp/rt.json
# are cells INDICES or VALUES?  types only
jq -r '.rows[0].columns | map(type)' /tmp/rt.json
# which columns are interned?  keys only, never the pooled values
jq -r '.uniqueValues | keys' /tmp/rt.json
# does a row carry a hoisted entity, and with which key?
jq -r '.rows[0] | keys' /tmp/rt.json
jq -r '.rows[0].entity | if . == null then "null" else keys end' /tmp/rt.json

rm -f /tmp/rt.json   # it contains real rows
```

Then answer these, in words, without quoting data:

1. Does `columns` **exclude** `Entity` while rows carry `entity`? (`ResultTable.cs:55-56`)
2. Are interned cells integers, with `uniqueValues` keyed by the column **token**?
   (`ResultTableConverter.cs:71-78`)
3. Is a hoisted entity `{EntityType, id, toStr}` — `EntityType`, **not** `Type`?
4. Is `totalElements` present, and does it differ from `rows.length` when paginated?

Then the same query through the CLI, and confirm they agree:

```bash
signum query "$Q" --top 2 --explain        # request shape; sends nothing, no gate
signum query "$Q" --count                  # aggregate only — see the note below
```

> `--count` is gated for AI callers on purpose (a count over a filtered population is an aggregate
> over personal data — ADR 0007's own limits section). If you are the caller, expect exit 9. That is
> a pass.

---

## Phase 4 — the privacy gate must fire (ADR 0007)

| # | Command | Expected |
|---|---|---|
| 4.1 | `signum query "$Q" --top 1` | **exit 9**, `refusing to emit query results to a detected AI caller`, signals listed. **A row appearing here is a release-blocking defect** |
| 4.2 | `signum query "$Q" --top 1 --explain` | exit 0 — `--explain` sends nothing and is exempt (AC-51.3) |
| 4.3 | `signum types --json` | exit 0 — metadata is never gated |

**4.4 requires the human.** One `--top 1` with `--i-understand-data-goes-to-a-model`, on the least
personal `$Q` available, to confirm rendering and de-interning end to end. Report only: did column
order match the request, was `Entity` in its declared position, were values plausible (not indices
leaking through). **Do not paste the row.**

---

## Phase 5 — errors, tokens, rotation

| # | Command | Expected |
|---|---|---|
| 5.1 | `SIGNUM_TOKEN=deliberately-invalid signum auth status` | `authenticated: false`, **exit 3**, and `reachable: true` — the server answered, so it is reachable. The failure *shape* tells you about the app: a **403** `No authentication information found!` means it does **not** configure `AuthLogic.AnonymousUser` (what the target app does — #83); a 200 with a null body means it does. Both are correct behaviour. *An earlier version of this line asserted only the second shape, and produced a false bug report — see #83.* |
| 5.2 | `SIGNUM_TOKEN=deliberately-invalid signum query "$Q" --top 1 --i-understand-data-goes-to-a-model` | **exit 3**, and the body should carry `exceptionType` containing `AuthenticationException`. **Never a 401** (AC-08.1) |
| 5.3 | `signum explain "$Q.Entity" --json` | Live `subTokens`. **Newest and least-verified code in the repo** (#77) — compare the `QueryTokenTS` key names against `SUB_TOKENS` in `test/integration.test.ts` |
| 5.4 | `signum explain "$Q.NoSuchToken"` | **exit 2**, `invalid query token`, with a `Did you mean:` suggestion. Confirms `FormatException` really arrives as HTTP 500 and is reclassified rather than surfacing as exit 1 |
| 5.5 | `signum get "$Q" 1 --exists` (or a known id) | `true`/`false` shape from `api/exists` |
| 5.6 | Run any authenticated command twice, ~30+ min apart, with `-v` | Watch for `< New_Token: <redacted> (adopting)`. Tokens never expire but rotate (`AuthTokensServer.cs:85-94`). Seeing it once proves AC-04.4 live. Not seeing it is inconclusive, not a failure |

---

## What to report back

Keep it to structure and verdicts. A compact table is ideal:

```
PHASE 1: 1.1 pass · 1.2 <code>/<code> · 1.4 <n> queries anon · ...
PHASE 3: columns excludes Entity? Y/N · interned cells integer? Y/N · entity key EntityType/Type
FIXTURE MISMATCHES: <field> — fixture says X, live says Y
```

Then, explicitly:

- **Any fixture mismatch**, with the field name and both shapes. These are the valuable findings.
- **Anything that exited 1** ("unexpected — please report it"). Exit 1 is always a CLI bug.
- **Any credential appearing in output.** Highest severity; stop and report.
- **1.2's two status codes**, verbatim — they decide ADR 0008.

Do **not** open a PR changing fixtures from this run without the human confirming which type names
may be committed. Propose the diff; let them approve it.

---

## Known-unverified list, for context

Everything below is currently believed-true from source reading alone. This run is the first chance
to check any of it:

- `TypeInfoTS` field names, and that `queryDefined` is absent-or-true (`ReflectionServer.cs:474`)
- `queryDefined` being rewritten per caller (`AuthServer.cs:143-157`) — phases 1.4 vs 2.3
- `ResultTable` interning and `Entity` hoisting — phase 3
- `QueryTokenTS` field names from `subTokens`/`parseTokens` — 5.3
- `FormatException` arriving as 500 rather than 400 — 5.4
- 403-never-401 with `exceptionType` as the discriminator — 5.2
- `New_Token` rotation appearing at all — 5.6
- Lite key `TypeName;id`, and entity `Type` vs Lite `EntityType`
