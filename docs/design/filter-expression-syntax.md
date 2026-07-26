# Design — filter expression syntax

Spec for the CLI's query filter surface. Satisfies
[REQ-021](https://github.com/pajoma/signum-cli/issues/13); acceptance criteria in
[`../stories/query.md`](../stories/query.md).

**Status:** IMPLEMENTED (`src/core/filter.ts`, tests in `test/filter.test.ts` and `test/integration.test.ts`). Two corrections below, found while implementing. Still not validated against a real Signum application — only against a mock server built from the framework source (see `test/integration.test.ts`'s own caveat).

## Why this needs designing rather than deciding

This is the CLI's primary interface. Three of the four consumer types write filters directly — an
operator at a terminal, a script, and an LLM agent — and the fourth (MCP) exposes it as a tool
parameter. Everything else in the CLI is comparatively mechanical; this is where the ergonomics live.

It must lower **exactly** onto `QueryRequestTS.filters`, which is a *tree* of two node types
(`FilterJsonConverter.cs:79-129`):

```csharp
public class FilterConditionTS : FilterTS
{
    public required string token;
    public FilterOperation operation;
    public object? value;
}

public class FilterGroupTS : FilterTS
{
    public FilterGroupOperation groupOperation;   // And | Or
    public string? token;
    public required List<FilterTS> filters;
}
```

## Constraints the wire imposes

Not preferences — these are properties of the server, and the syntax must not promise past them.

1. **There is no NOT.** `FilterGroupOperation` is `And | Or` only (`Filter.cs:12-16`). Negation
   exists solely as *negated operators* (`DistinctTo`, `NotContains`, `NotStartsWith`, `NotEndsWith`,
   `NotLike`, `IsNotIn`). So the syntax deliberately offers **no general `not`** — offering one would
   mean silently rewriting the user's intent, or failing on expressions that look valid.
2. **`IsIn` cannot express null.** Documented framework limitation. `x in (a, b, null)` must be a
   clear error, not a silently dropped element.
3. **Operations are type-dependent.** The server derives valid operations per token via
   `QueryUtils.GetFilterOperations(token)` (`QueryUtils.cs:101`). `StartsWith` on a number is
   meaningless. The CLI validates against cached metadata where it can and lets the server arbitrate
   otherwise.
4. **Some operations are backend-specific.** `ComplexCondition` and `FreeText` are SQL Server
   full-text; `TsQuery`, `TsQuery_Plain`, `TsQuery_Phrase`, `TsQuery_WebSearch` are PostgreSQL;
   `SmartSearch` is vector search over embeddings. These get **named forms only** — no symbolic
   sugar — because they are neither portable nor guessable.
5. **Aggregates need `groupResults: true`**, and `SubTokensOptions` differ per slot, so the same
   token string is not necessarily legal in a filter, a column, and an order.
6. **`.Nested` tokens are unusable** in `executeQuery` even though `subTokens` offers them
   (`FilterJsonConverter.cs:87-153`). Reject early with an explanation.

## Grammar

```ebnf
expr        = orExpr ;
orExpr      = andExpr { "or" andExpr } ;
andExpr     = primary { "and" primary } ;
primary     = "(" expr ")" | condition ;
condition   = token , operator , [ valueList ] ;
valueList   = value { "," value } ;
token       = bareToken | quotedString ;
value       = quotedString | bareValue | "null" | "true" | "false" ;
```

- `and` binds tighter than `or`. Parentheses override. Keywords are case-insensitive.
- Repeating `--filter` is equivalent to `and`-ing the expressions — a convenience for shells and for
  building commands up programmatically.
- Whitespace around operators is optional for symbolic forms, required for named forms.

### Lowering

| Expression | Wire |
|---|---|
| a single `condition` | one `FilterConditionTS` |
| `and` of N | `FilterGroupTS{groupOperation:"And", filters:[…]}` |
| `or` of N | `FilterGroupTS{groupOperation:"Or", filters:[…]}` |
| nested parens | nested `FilterGroupTS` |

A top-level list of conditions with no explicit operator is emitted as a flat array (the server
`and`s them), **not** wrapped in a redundant group.

> `FilterGroupTS.token` — the optional group-level token, used by the UI for
> `Any`/`All` collection semantics — is **not** exposed in v1. It needs its own design, and
> guessing it would produce wrong results silently. Tracked as an open question.

## Operators

Symbolic forms are sugar for the most common cases. **Every** operation is reachable by its name, so
the syntax has no expressive gap.

| Symbol | Name(s) | `FilterOperation` |
|---|---|---|
| `=` | `eq`, `equalTo` | `EqualTo` |
| `!=` | `ne`, `distinctTo` | `DistinctTo` |
| `>` | `gt` | `GreaterThan` |
| `>=` | `gte` | `GreaterThanOrEqual` |
| `<` | `lt` | `LessThan` |
| `<=` | `lte` | `LessThanOrEqual` |
| `~` | `contains` | `Contains` |
| `!~` | `notContains` | `NotContains` |
| — | `startsWith` | `StartsWith` |
| — | `endsWith` | `EndsWith` |
| — | `notStartsWith` | `NotStartsWith` |
| — | `notEndsWith` | `NotEndsWith` |
| — | `like` | `Like` |
| — | `notLike` | `NotLike` |
| — | `in` | `IsIn` |
| — | `notIn` | `IsNotIn` |
| — | `between` | `Between` |
| — | `betweenNoEnd` | `BetweenNoEnd` |
| — | `complexCondition` | `ComplexCondition` (SQL Server FTS) |
| — | `freeText` | `FreeText` (SQL Server FTS) |
| — | `tsQuery`, `tsQueryPlain`, `tsQueryPhrase`, `tsQueryWebSearch` | `TsQuery*` (Postgres FTS) |
| — | `smartSearch` | `SmartSearch` (vector) |

No symbol is given to `startsWith`/`endsWith`: the obvious candidates are `^` and `$`, and **`$` is
shell-expanded**, so a `$`-based operator would be a trap. Asymmetric sugar (`^` without `$`) is
worse than none.

`in`, `notIn`, `between`, and `betweenNoEnd` take a `valueList`. `between` requires **exactly
two** values. `betweenNoEnd` was found in `Filter.cs`'s declaration order during implementation —
the original table above omitted it — and its "no end" semantics are unconfirmed against a live
server, so the CLI accepts one or two values for it rather than assuming a fixed arity. **[INFERENCE]**

## Values

| Kind | Form | Notes |
|---|---|---|
| string | bare, or `"…"` / `'…'` | quote when it contains whitespace, a comma, or a leading `(` |
| number | `100`, `-3.5` | `.` decimal separator, **culture-invariant on input** |
| boolean | `true` / `false` | |
| null | `null` | illegal inside `in`/`notIn` (constraint 2) |
| enum | member name, e.g. `Shipped` | validated against metadata |
| date / datetime | ISO 8601, e.g. `2026-07-25`, `2026-07-25T14:30:00` | invariant on input regardless of `--culture` |
| `Lite<T>` | `"Order;42"` — `TypeName;id` | quote it: unquoted `;` is a shell command separator |
| entity by id | `42` against a `Lite` token | CLI resolves to the token's type |

**Found while implementing, not in the original table above:** a `Lite` value cannot be sent as the
bare string `"Order;42"`. The wire format requires the object form — the reference doc is explicit
that "a Lite filter value uses the object form; the minimum is `{"EntityType":"Order","id":42}`". So
the parser lowers any quoted (or bare) value matching the `TypeName;id` pattern to
`{ EntityType, id }` before it reaches the request body; a numeric id is sent as a number, anything
else (e.g. a Guid) as a string. This is a heuristic on the value's own lexical shape, same as every
other value in this table — it is not aware of the target token's declared type.

Escaping inside a quoted value: `\"`, `\\`, `\,`. A literal comma in an `in` list **must** be
escaped or the value quoted.

Input parsing is deliberately invariant — a filter's meaning must not depend on the machine's locale.
`--culture` affects **output rendering only** (REQ-055).

## Two syntax collisions, and how they resolve

Worth stating plainly because both produce confusing failures if unhandled.

**1. Cast tokens versus grouping parentheses.** QueryTokens may contain a parenthesised cast, e.g.
`(Order).Customer.Name`. A leading `(` is therefore ambiguous with a group.

> **Rule:** a token beginning with `(` **must be quoted**: `--filter '"(Order).Customer.Name" = 5'`.
> Unquoted, a leading `(` always opens a group. The error message for a failed parse names this rule
> explicitly.

**2. Operation tokens contain `#`.** Operations escape their own dot as `#`, e.g.
`Entity.[Operations].Order#Save`. `#` is a comment character in many shells, so such a token must be
quoted. This is a shell concern, not a grammar one, but the docs must say so.

Bracketed segments (`[Operations]`, `[EntityType]`) need no special handling — `[` and `]` are only
glob characters, harmless inside a quoted argument.

## Examples

```bash
# equality; repeated --filter is AND
signum query Order --filter "State = Shipped" --filter "Total >= 100"

# explicit and/or with grouping
signum query Order \
  --filter "Entity.Customer.Name ~ Acme and (State = Shipped or State = Delivered)"

# named operators, shell-safe without symbols
signum query Order --filter "Entity.Customer.Name startsWith A"

# lists and ranges
signum query Order --filter "State in Shipped,Delivered,Invoiced"
signum query Order --filter "OrderDate between 2026-01-01,2026-06-30"

# null
signum query Order --filter "ShippedDate = null"

# Lite value — quote because of the semicolon
signum query OrderDetails --filter "Order = 'Order;42'"

# collection and date-part tokens
signum query Order --filter "Details.Any.Product.Name ~ Widget"
signum query Order --filter "OrderDate.Year = 2026"

# aggregate (implies --group)
signum query Order --group --column "Entity.Customer" --column "Total.Sum" \
  --filter "Total.Sum > 10000"

# escape hatch: exact wire fidelity
signum query Order --filter-json @filters.json
echo '[{"token":"State","operation":"EqualTo","value":"Shipped"}]' \
  | signum query Order --filter-json -
```

## `--filter-json` escape hatch

`--filter-json` accepts a raw `FilterTS[]` from a file or stdin, bypassing the DSL entirely.

It exists for three reasons: agents can emit structured JSON more reliably than they can quote a
shell expression; anything the DSL cannot express (group-level tokens, future operations) stays
reachable without waiting for a parser change; and it gives a stable contract for programmatic
callers that should not depend on DSL evolution.

`--filter` and `--filter-json` may be combined — the results are `and`-ed. `--explain` prints the
final composed tree either way.

## Errors

Filter mistakes are the most common failure mode, so diagnostics are part of the design, not an
afterthought.

- **Parse error** → column offset, the offending fragment, and the applicable rule (e.g. the
  quoted-cast rule above). Exit code: usage class (REQ-051).
- **Unknown token** → nearest valid alternatives from the metadata cache, since `subTokens` gives the
  legal continuations of a prefix. This is the single highest-value error message in the CLI.
- **Operator not valid for token type** → the operations the server would accept for that token.
- **`null` inside `in`** → names constraint 2 and suggests `token = null or token in (…)`.
- **Aggregate token without `--group`** → says `--group` is required rather than forwarding a request
  that will fail server-side.
- **`.Nested` token** → rejected client-side with the reason.

Wherever possible, validate against the cached metadata *before* the round trip, so a typo costs no
network call and no server-side exception log entry.

## Rejected alternatives

- **JMESPath / JQ-style.** Wrong shape — those query *result* documents; we need to build a
  server-side filter tree. Would imply capabilities the API does not have.
- **Raw JSON only.** Honest and zero-ambiguity, but hostile to the human-at-a-terminal consumer. Kept
  as the escape hatch instead.
- **A flag per operator** (`--eq`, `--gt`, …). No sane way to express grouping, and it multiplies the
  flag surface.
- **SQL-like `WHERE` string.** Sets an expectation of SQL semantics — joins, subqueries, arbitrary
  expressions — that DynamicQuery does not offer.
- **Mirroring the UI's `FindOptions` URL format.** Compact and already understood by Signum
  developers, but positional, cryptic, and unusable by agents.

## Open questions

1. **Group-level tokens** (`FilterGroupTS.token`) for `Any`/`All` collection semantics — deferred
   from v1, needs its own design. What is the intended surface?
2. Should `--filter` accept a **file/stdin** form too (`--filter @file`) for very long expressions?
3. Is `~` for `Contains` intuitive enough, or should `contains` be the only spelling? `~` reads as
   "matches" to some and "approximately" to others.
4. `SmartSearch` (vector search) probably needs parameters beyond a single value — investigate before
   exposing it.
5. Should the CLI **auto-add `--group`** when it sees an aggregate token, rather than erroring? Erring
   is proposed, on the grounds that silently changing query semantics is worse than a clear message.
