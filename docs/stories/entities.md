# User Stories — Entities

Stories for retrieving and round-tripping entities. Unlike [requirements](../requirements.md),
stories carry **acceptance criteria**.

Wire contract: [`../http-api.md`](../http-api.md). Operations that *mutate* entities are in
[`operations.md`](operations.md) — there is no save endpoint, so every write is an operation.

---

## STORY-30 — Retrieve an entity

Traces to: REQ-030 · Priority: `m1`

**As an operator**, I want to fetch one entity by type and id, or by its `Lite` key, so that I can
inspect the real stored state of a record.

**Acceptance Criteria:**
- AC-30.1: `signum get <Type> <id>` issues `GET api/entity/{type}/{id}`.
- AC-30.2: A `Lite` key is accepted in place of type+id: `signum get "Order;42"` (`TypeName;id`). Quote it — an unquoted `;` is a shell command separator.
- AC-30.3: `--pack` uses `entityPack`/`entityPackLight` to return the entity together with `canExecute`, so a user can see what they may do to it in one call.
- AC-30.4: The type argument accepts the **clean** name (`Order`) and the entity class name (`OrderEntity`), resolving both via cached metadata.
- AC-30.5: `signum get <Type> <id> --exists` wraps `api/exists`; `signum get <Type>` with no id wraps `api/fetchAll`, is always bounded, and warns on a TTY that it is unfiltered ([CLI surface](../design/cli-surface.md)).
- AC-30.6: Output honours STORY-22's TTY rules: readable when watched, JSON when piped.
- AC-30.7: A missing entity exits with the not-found code (REQ-051), distinct from an auth or transport failure.

---

## STORY-31 — Round-trip without corruption

Traces to: REQ-031 · Priority: `m2`

**As an operator** doing a targeted data fix, I want to fetch an entity, edit one field, and write it
back with everything else untouched, so that I can trust the CLI with real records.

This is the second correctness story (STORY-21 is the first). Signum's entity JSON has several
non-obvious invariants, and violating any of them either throws or — worse — silently drops data.

**Acceptance Criteria:**
- AC-31.1: `Type` carries the **clean** name on entities (`RoleEntity` → `"Role"`), while `Lite`s carry `EntityType`. Mixing them throws server-side, so the CLI never emits both and never substitutes one for the other.
- AC-31.2: `ticks` is serialized as a **string**, not a number, and is preserved verbatim from the fetch.
- AC-31.3: `MList<T>` round-trips as `[{rowId, element}]`, preserving `rowId` for existing rows so the server updates rather than replaces them.
- AC-31.4: Special properties are emitted **first** in the object, and unknown keys are never added — the server rejects them.
- AC-31.5: Embedded entities, mixins, enums, `DateOnly`/`DateTime`/`TimeSpan`, `decimal`, and `byte[]` all survive a fetch → write cycle unchanged. Covered by a round-trip test per kind.
- AC-31.6: A fetch → write with **no edits** produces a byte-identical entity server-side. This is the single most valuable test in the suite: it proves the CLI is not silently lossy.
- AC-31.7: `--edit <token>=<value>` applies a targeted change without the user hand-writing JSON; `--patch @file` merges a JSON fragment.

---

## STORY-32 — Edits actually save

Traces to: REQ-032 · Priority: `m2`

**As an operator**, I want my change to be persisted, so that a command reporting success has
actually written something.

`modified: true` must be propagated up the **whole entity graph**, not just set on the changed leaf.
The browser client does this via `GraphExplorer.propagateAll` in `ajaxPostRaw`. Omit it and the
server accepts the request, reports success, and **silently discards the change** — a failure mode
that looks exactly like success.

**Acceptance Criteria:**
- AC-32.1: On any write, `modified` is set on the changed node **and every ancestor** up to the root entity.
- AC-32.2: Propagation is implemented once, in the serialization layer, so no command can forget it.
- AC-32.3: A test modifies a field nested inside an embedded entity inside an `MList` row and asserts the change persists. Depth is the point — a shallow test would pass while the bug remained.
- AC-32.4: A write that results in no actual change is reported as such rather than as a successful save, so "success" always means something happened.

---

## STORY-33 — Lose a race safely

Traces to: REQ-033 · Priority: `m2`

**As an operator** writing to a live system, I want a concurrent modification to fail loudly, so that
I never silently overwrite somebody else's change.

**Acceptance Criteria:**
- AC-33.1: `ticks` from the fetch is sent back unchanged on write, giving optimistic concurrency.
- AC-33.2: A conflict arrives as HTTP **500** with `exceptionType == "Signum.Engine.ConcurrencyException"` (`Signum/Engine/Exceptions.cs:341`). The CLI detects it specifically and reports "the record changed since you read it", **never** as a generic server error.
- AC-33.3: A concurrency conflict has its **own exit code** (REQ-051), so scripts can retry-with-refetch.
- AC-33.4: The CLI **never** auto-refetches and retries. That would silently resolve the conflict in favour of the caller, defeating the mechanism. Retry is the caller's explicit decision.
- AC-33.5: `--force` may skip concurrency checking where the API permits, but only with an explicit flag and a TTY confirmation.

---

## STORY-34 — Check before writing

Traces to: REQ-034 · Priority: `m3`

**As an operator**, I want to validate an entity before attempting to persist it, so that I see
problems before any mutation happens.

**Acceptance Criteria:**
- AC-34.1: `--validate-only` posts to `api/validateEntity` and reports results without writing.
- AC-34.2: Validation messages are surfaced per property, with the property route named.
- AC-34.3: Validation failure exits with the validation code (REQ-051), distinct from a permission or concurrency failure.
- AC-34.4: Localized validation messages are passed through as the server returns them, not re-worded.

---

## Traceability

| Story | Requirements | Milestone |
|---|---|---|
| STORY-30 Retrieve an entity | REQ-030 | `m1` |
| STORY-31 Round-trip without corruption | REQ-031 | `m2` |
| STORY-32 Edits actually save | REQ-032 | `m2` |
| STORY-33 Lose a race safely | REQ-033 | `m2` |
| STORY-34 Check before writing | REQ-034 | `m3` |
