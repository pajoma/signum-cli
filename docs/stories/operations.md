# User Stories — Operations

Stories for the mutation surface. Unlike [requirements](../requirements.md), stories carry
**acceptance criteria**.

**There is no save endpoint.** Every mutation in Signum — including saving — is an *operation*, so
this file is the entire write surface. Retrieval and JSON fidelity are in
[`entities.md`](entities.md).

---

## Two constraints the API imposes

Both were found by reading the controller and both shape the design.

### Only UI-visible operations are invokable

`OperationController` hardcodes `inUserInterface: true` when asserting permission
(`OperationController.cs:142` → `OperationLogic.AssertOperationAllowed`, `OperationLogic.cs:341-347`).
Every HTTP invocation is therefore judged as though it came from the web UI, and an operation hidden
from the UI **cannot be invoked over the API at all** — by this CLI or any other client. There is no
client-side workaround; it is a property of the server.

### `args` are coerced by JSON shape, with three traps

`BaseOperationRequest.ConvertObject` (`OperationController.cs:~165-200`) discriminates purely on the
JSON value kind:

| JSON | Becomes | Trap |
|---|---|---|
| string | `DateTime` if it parses as one, then `DateTimeOffset`, else `string` | **A date-shaped string silently becomes a date.** `"2026-01-01"` can never be passed as a string. |
| number | **always `decimal`** | never `int`/`long`/`double`; an operation expecting `int` relies on downstream conversion |
| object with `EntityType` | `Lite<Entity>` | |
| object with `Type` | `ModifiableEntity` | so embedded and model entities work, not just root entities |
| object with **neither** | app-registered `CustomOperationArgsConverters`, else **`null`** | **silently null** if the app registered no converter — no error |
| array | recursive list | |
| true/false/null | as expected | |

The two silent behaviours — date coercion and the null fallthrough — are the reason AC-42.3 and
AC-42.4 exist.

---

## STORY-40 — Execute an operation

Traces to: REQ-040 · Priority: `m2`

**As an operator**, I want to run a named operation on a record, so that I can drive the application's
own business logic rather than editing data behind its back.

**Acceptance Criteria:**
- AC-40.1: Operations are invoked as `signum <verb> <Type> [id]` — `signum ship order 42`, `signum create order`, `signum save user -f user.json` — with `--lite`/`--id`/`-f` available when positional is ambiguous. The dotted key (`signum OrderOperation.Ship --lite "Order;42"`) is the canonical equivalent ([CLI surface](../design/cli-surface.md) §2.1).
- AC-40.2: The CLI selects `executeEntity` when it holds a modified entity graph and `executeLite` when it holds only an identity — matching how the browser decides via `canBeModified`.
- AC-40.3: Saving is expressed as an operation (e.g. `UserOperation.Save`); there is no separate `save` command implying an endpoint that does not exist.
- AC-40.4: The response `EntityPackTS` is rendered, including the refreshed `canExecute`.
- AC-40.5: A `403` carrying `UnauthorizedAccessException` is reported as "not permitted", and the message notes that operations hidden from the UI are not invokable over the API at all.
- AC-40.6: Validation failure on `executeEntity` returns `400` with `ValidationProblemDetails`, surfaced per property.

---

## STORY-41 — Name an operation without guessing

Traces to: REQ-041 · Priority: `m2`

**As a developer or agent**, I want to refer to an operation by a name I can discover, so that I do
not have to know Signum's symbol conventions.

Keys are `ContainerClassName.FieldName` — **not** namespace-qualified (`Signum/Basics/Symbol.cs:22`:
`this.Key = declaringType.Name + "." + fieldName;`). So `UserOperation.Save`, never
`Signum.Authorization.UserOperation.Save`.

**Acceptance Criteria:**
- AC-41.1: A fully-qualified key is accepted verbatim.
- AC-41.2: A bare operation name (`Save`) is resolved against the target type's operations from cached metadata.
- AC-41.3: An ambiguous short name **lists the candidates and exits non-zero**. It never picks one. Two operations resolving to the same verb on one type is likewise an error naming both canonical keys.
- AC-41.7: Verb and type matching is **case-insensitive and kebab-tolerant** (`import-public-holidays holiday-calendar` ≡ `ImportPublicHolidays HolidayCalendar`); output renders the app's own PascalCase.
- AC-41.8: An operation whose verb is shadowed by a built-in (e.g. `XOperation.Get`) is **flagged as shadowed** in `signum operations <Type>` output and remains reachable by canonical key. Built-ins always win dispatch.
- AC-41.4: An unknown key suggests near-matches from metadata for that type.
- AC-41.5: If a namespace-qualified key is supplied, the CLI explains the actual format rather than forwarding a request that will fail.
- AC-41.6: `signum operations [<Type>]` lists invokable operations (read-only, so it ships in m1 with REQ-011), and `signum explain <OperationKey>` describes one — noting that the list is a **positive capability list only** — operations forbidden to this user vanish from `canExecute` with no reason (`OperationLogic.cs:456`), so absence never means "does not exist".

---

## STORY-42 — Pass arguments correctly

Traces to: REQ-042 · Priority: `m2`

**As an operator**, I want to pass arguments to an operation and have them arrive as the intended
types, so that a correct-looking command is not silently misinterpreted.

**Acceptance Criteria:**
- AC-42.1: `--arg` is repeatable and order-preserving; `args` is emitted as a JSON array in that order.
- AC-42.2: Lites, entities, numbers, booleans, null, and arrays are all expressible unambiguously, with explicit typing available (e.g. `--arg-string`, `--arg-lite`, `--arg-json`) rather than relying on inference alone.
- AC-42.3: **A date-shaped string cannot be sent as a string.** The server coerces it (`ConvertObject`, string branch). The CLI detects a date-shaped value passed via `--arg-string` and **warns**, because the coercion is invisible and unavoidable.
- AC-42.4: An object argument carrying neither `EntityType` nor `Type` becomes **`null`** server-side unless the app registered a `CustomOperationArgsConverters` entry. The CLI **refuses to send such an object** by default and explains why, because the server neither errors nor warns — the argument simply arrives null.
- AC-42.5: Numbers always arrive as `decimal`; documented so nobody debugs an "int" that is not one.
- AC-42.6: `--arg-json` accepts raw JSON for full fidelity, bypassing all inference.
- AC-42.7: `--explain` shows the exact `args` array as it will be sent.

---

## STORY-43 — Find out before doing

Traces to: REQ-043 · Priority: `m2`

**As an operator or agent**, I want to know whether an operation would be permitted before invoking
it, so that I can check safely against production.

**Acceptance Criteria:**
- AC-43.1: `--dry-run` reports whether the operation would be permitted, using `canExecute` from `entityPack`, and **never invokes it**.
- AC-43.2: When blocked, the reason string from `canExecute` is shown verbatim.
- AC-43.3: For many targets, `api/operation/stateCanExecutes` is used to check in one round trip (request carries `OperationKeys[]` + `Lites[]`, `OperationController.cs:357-358`).
- AC-43.4: `--dry-run` exit code distinguishes "would succeed" from "would be blocked", so scripts can gate on it.
- AC-43.5: The output states plainly that a dry run checks **permission**, not business-rule success — an operation can be permitted and still fail on execution.
- AC-43.6: `--explain` and `--dry-run` compose: show the request *and* the permission verdict, still sending nothing.

---

## STORY-44 — Create and delete

Traces to: REQ-044 · Priority: `m3`

**As an operator**, I want to construct new records and delete existing ones, so that the CLI covers
the full lifecycle rather than only updates.

**Acceptance Criteria:**
- AC-44.1: `construct` posts `ConstructOperationRequest`, which requires an explicit **`Type`** (`OperationController.cs:118-121`) — there is no entity to infer it from.
- AC-44.2: `constructFromEntity` / `constructFromLite` / `constructFromMany` are all reachable, taking their source as an entity, a lite, or a list of lites.
- AC-44.3: `deleteEntity` / `deleteLite` are supported, and delete always requires confirmation per STORY-46.
- AC-44.4: A constructed entity is rendered so its new id is immediately usable in a following command.
- AC-44.5: Construct returning `null` (the operation declined to produce an entity) is reported as such, not as a crash.

---

## STORY-45 — Act on many records

Traces to: REQ-045 · Priority: `m3`

**As an operator** fixing a batch, I want to run one operation across many records with progress and
per-item outcomes, so that I can act at scale and know exactly what happened.

**Acceptance Criteria:**
- AC-45.1: `executeMultiple`, `deleteMultiple`, and `constructFromMultiple` accept a list of lites from `--lite` (repeatable), `@file`, or stdin.
- AC-45.2: `executeLiteWithProgress` streams **NDJSON**; the CLI renders live progress on a TTY and passes the stream through under `--ndjson`.
- AC-45.3: One item failing does **not** abort the batch. A per-item outcome table is produced, and the exit code reflects partial failure distinctly from total failure.
- AC-45.4: Declarative property setters are supported — `MultiOperationRequest.Setters` is a list of `PropertySetter { Property, Setters, … }` applied via `MultiSetter.SetSetters` (`OperationController.cs:222,304-320`), including nesting for embedded entities and `MList` rows.
- AC-45.5: Bulk operations always require confirmation on a TTY, always print the target count first, and support `--dry-run` across the whole set.
- AC-45.6: Interrupting mid-batch leaves already-emitted per-item results valid, and the CLI reports how many were processed.

---

## STORY-46 — Do not let me destroy things by accident

Traces to: REQ-046 · Priority: `m2`

**As an operator** with production credentials, I want the CLI to make destructive actions
deliberate, so that a mistyped command cannot quietly cause damage.

**Acceptance Criteria:**
- AC-46.1: Any mutation prompts for confirmation when stdout is a TTY, showing the operation, the target count, the **profile name and target URL** (a wrong-environment mistake is the likeliest one), and `--dry-run` output where cheap.
- AC-46.2: `--yes` bypasses confirmation.
- AC-46.3: With no TTY and no `--yes`, the CLI **fails** rather than prompting — a script must never hang, and must never mutate by default.
- AC-46.4: A profile marked *protected* (AC-05.5) requires `--yes` even non-interactively.
- AC-46.5: Deletes and bulk operations require typed confirmation, not a bare y/n, when the target count exceeds a threshold.
- AC-46.6: Every mutation is logged locally — operation, target, profile, timestamp, outcome — with no credentials, so an operator can reconstruct what they did.

---

## Traceability

| Story | Requirements | Milestone |
|---|---|---|
| STORY-40 Execute an operation | REQ-040 | `m2` |
| STORY-41 Name an operation | REQ-041 | `m2` |
| STORY-42 Pass arguments correctly | REQ-042 | `m2` |
| STORY-43 Find out before doing | REQ-043 | `m2` |
| STORY-44 Create and delete | REQ-044 | `m3` |
| STORY-45 Act on many records | REQ-045 | `m3` |
| STORY-46 Destructive-action guard | REQ-046 | `m2` |
