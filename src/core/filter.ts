/**
 * Filter expression parser.
 *
 * REQ-021 · STORY-20 · docs/design/filter-expression-syntax.md
 *
 * Lowers the CLI's filter DSL onto the exact wire shape of `QueryRequestTS.filters`
 * (`FilterConditionTS` | `FilterGroupTS`, `FilterJsonConverter.cs:79-129`).
 *
 * This file is deliberately hand-rolled (no parser-combinator dependency, per ADR 0005/0006's
 * "keep the dependency tree small") because the grammar is small:
 *
 *   expr    = orExpr
 *   orExpr  = andExpr { "or" andExpr }
 *   andExpr = primary { "and" primary }
 *   primary = "(" expr ")" | condition
 *   condition = token operator [ valueList ]
 *
 * Two wire constraints shape this, and neither is a stylistic choice:
 *   - There is NO general `not`. `FilterGroupOperation` is `And | Or` only (`Filter.cs:12-16`).
 *     Negation exists solely as negated operators (`DistinctTo`, `NotContains`, `IsNotIn`, …).
 *   - `IsIn`/`IsNotIn` cannot express null — a documented framework limitation, not a parser
 *     gap, so a `null` inside `in`/`notIn` is a clear error, never a silently dropped element.
 */

import { UsageError } from "./errors.ts";
import { parseLiteKey } from "../commands/get.ts";

// ── wire shapes ─────────────────────────────────────────────────────────────

/**
 * Complete `FilterOperation` list, declaration order (`Filter.cs:557-617`, verified against
 * the generated `Signum.DynamicQuery.ts:33-59` union — 25 members, including `BetweenNoEnd`,
 * which the original design doc's table omitted). Enum parsing on the server is
 * `.ToEnum<FilterOperation>()` on the raw string, so these spellings must be exact.
 */
export type FilterOperationName =
  | "EqualTo" | "DistinctTo" | "GreaterThan" | "GreaterThanOrEqual" | "LessThan" | "LessThanOrEqual"
  | "Contains" | "StartsWith" | "EndsWith" | "Like" | "NotContains" | "NotStartsWith" | "NotEndsWith"
  | "NotLike" | "IsIn" | "IsNotIn" | "ComplexCondition" | "FreeText"
  | "TsQuery" | "TsQuery_Plain" | "TsQuery_Phrase" | "TsQuery_WebSearch"
  | "SmartSearch" | "Between" | "BetweenNoEnd";

export interface FilterConditionWire {
  token: string;
  operation: FilterOperationName;
  value: unknown;
}

export interface FilterGroupWire {
  groupOperation: "And" | "Or";
  filters: FilterWire[];
}

export type FilterWire = FilterConditionWire | FilterGroupWire;

// ── operator tables ──────────────────────────────────────────────────────────

const SYMBOL_OPERATORS: Record<string, FilterOperationName> = {
  "=": "EqualTo",
  "!=": "DistinctTo",
  ">": "GreaterThan",
  ">=": "GreaterThanOrEqual",
  "<": "LessThan",
  "<=": "LessThanOrEqual",
  "~": "Contains",
  "!~": "NotContains",
};

/**
 * No symbol for startsWith/endsWith: the obvious candidates are `^` and `$`, and `$` is
 * shell-expanded, so a `$`-based operator would be a silent trap. Asymmetric sugar (`^`
 * without `$`) is worse than none, so both stay name-only (design doc §Operators).
 */
const NAMED_OPERATORS: Record<string, FilterOperationName> = {
  eq: "EqualTo", equalto: "EqualTo",
  ne: "DistinctTo", distinctto: "DistinctTo",
  gt: "GreaterThan",
  gte: "GreaterThanOrEqual",
  lt: "LessThan",
  lte: "LessThanOrEqual",
  contains: "Contains",
  notcontains: "NotContains",
  startswith: "StartsWith",
  endswith: "EndsWith",
  notstartswith: "NotStartsWith",
  notendswith: "NotEndsWith",
  like: "Like",
  notlike: "NotLike",
  in: "IsIn",
  notin: "IsNotIn",
  between: "Between",
  // Found while implementing (verified in Filter.cs's declaration order) but not in the
  // original design table. Semantics of the "no end" half are unconfirmed against a live
  // server, so it accepts 1 or 2 values rather than assuming a fixed arity. [INFERENCE]
  betweennoend: "BetweenNoEnd",
  complexcondition: "ComplexCondition",
  freetext: "FreeText",
  tsquery: "TsQuery",
  tsqueryplain: "TsQuery_Plain",
  tsqueryphrase: "TsQuery_Phrase",
  tsquerywebsearch: "TsQuery_WebSearch",
  smartsearch: "SmartSearch",
};

const LIST_OPERATORS = new Set<FilterOperationName>(["IsIn", "IsNotIn", "Between", "BetweenNoEnd"]);

const AGGREGATE_SEGMENTS = new Set([
  "Count", "Sum", "Min", "Max", "Average", "CountDistinct", "CountNull", "CountNotNull", "CountTrue",
]);

/** Bracket-aware dot split, mirroring `QueryUtils.cs:370` exactly (verified in docs/http-api.md). */
const TOKEN_SPLIT = /(?<!\[[^\]]*)\.(?![^[]*\])/;

// ── tokenizer ────────────────────────────────────────────────────────────────

type TokKind = "lparen" | "rparen" | "comma" | "sym" | "word" | "string";
interface Tok { kind: TokKind; text: string; pos: number }

const WS = /\s/;
/** Characters that end a bareword even with no surrounding whitespace (AC: symbolic ops need no spaces). */
function isBarewordStop(ch: string): boolean {
  return WS.test(ch) || ch === "(" || ch === ")" || ch === "," || ch === '"' || ch === "'"
    || ch === "=" || ch === ">" || ch === "<" || ch === "~" || ch === "!";
}

class ParseFailure extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i] as string;

    if (WS.test(c)) { i++; continue; }
    if (c === "(") { toks.push({ kind: "lparen", text: c, pos: i }); i++; continue; }
    if (c === ")") { toks.push({ kind: "rparen", text: c, pos: i }); i++; continue; }
    if (c === ",") { toks.push({ kind: "comma", text: c, pos: i }); i++; continue; }

    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let out = "";
      while (i < n && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < n) {
          const next = input[i + 1] as string;
          if (next === quote || next === "\\" || next === ",") {
            out += next;
            i += 2;
            continue;
          }
        }
        out += input[i];
        i++;
      }
      if (i >= n) {
        throw new ParseFailure(`unterminated quoted string starting at column ${start + 1}`, start);
      }
      i++; // closing quote
      toks.push({ kind: "string", text: out, pos: start });
      continue;
    }

    // Symbolic operators, longest match first — no space required around them.
    const two = input.slice(i, i + 2);
    if (two === "!=" || two === ">=" || two === "<=" || two === "!~") {
      toks.push({ kind: "sym", text: two, pos: i });
      i += 2;
      continue;
    }
    if (c === "=" || c === ">" || c === "<" || c === "~") {
      toks.push({ kind: "sym", text: c, pos: i });
      i++;
      continue;
    }

    // Bareword: token name, value, or the `and`/`or` keywords.
    const start = i;
    let out = "";
    while (i < n) {
      const ch = input[i] as string;
      if (isBarewordStop(ch)) break;
      if (ch === "\\" && i + 1 < n) {
        const next = input[i + 1] as string;
        if (next === '"' || next === "\\" || next === ",") {
          out += next;
          i += 2;
          continue;
        }
      }
      out += ch;
      i++;
    }
    if (out === "") {
      throw new ParseFailure(`unexpected character '${c}' at column ${start + 1}`, start);
    }
    toks.push({ kind: "word", text: out, pos: start });
  }

  return toks;
}

// ── AST ──────────────────────────────────────────────────────────────────────

export type FilterNode =
  | { kind: "condition"; token: string; operator: FilterOperationName; value: unknown; pos: number }
  | { kind: "and"; terms: FilterNode[] }
  | { kind: "or"; terms: FilterNode[] };

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.i]; }
  private advance(): Tok {
    const t = this.toks[this.i];
    if (t === undefined) throw new ParseFailure("unexpected end of filter expression", this.endPos());
    this.i++;
    return t;
  }
  private endPos(): number {
    const last = this.toks[this.toks.length - 1];
    return last === undefined ? 0 : last.pos + last.text.length;
  }
  private isKeyword(word: "and" | "or"): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === "word" && t.text.toLowerCase() === word;
  }

  parseExpr(): FilterNode {
    const node = this.parseOr();
    if (this.peek() !== undefined) {
      const t = this.peek() as Tok;
      throw new ParseFailure(`unexpected '${t.text}' at column ${t.pos + 1} (missing 'and'/'or'?)`, t.pos);
    }
    return node;
  }

  private parseOr(): FilterNode {
    const terms = [this.parseAnd()];
    while (this.isKeyword("or")) {
      this.advance();
      terms.push(this.parseAnd());
    }
    return terms.length === 1 ? (terms[0] as FilterNode) : { kind: "or", terms };
  }

  private parseAnd(): FilterNode {
    const terms = [this.parsePrimary()];
    while (this.isKeyword("and")) {
      this.advance();
      terms.push(this.parsePrimary());
    }
    return terms.length === 1 ? (terms[0] as FilterNode) : { kind: "and", terms };
  }

  private parsePrimary(): FilterNode {
    const t = this.peek();
    if (t === undefined) throw new ParseFailure("expected a filter condition", this.endPos());
    if (t.kind === "lparen") {
      this.advance();
      const inner = this.parseOr();
      const close = this.peek();
      if (close === undefined || close.kind !== "rparen") {
        throw new ParseFailure(`unclosed '(' opened at column ${t.pos + 1}`, t.pos);
      }
      this.advance();
      return inner;
    }
    return this.parseCondition();
  }

  private parseCondition(): FilterNode {
    const tokenTok = this.advance();
    if (tokenTok.kind === "word" && (tokenTok.text.toLowerCase() === "and" || tokenTok.text.toLowerCase() === "or")) {
      throw new ParseFailure(`expected a filter condition, found reserved word '${tokenTok.text}'`, tokenTok.pos);
    }
    if (tokenTok.kind === "lparen" || tokenTok.kind === "rparen" || tokenTok.kind === "comma" || tokenTok.kind === "sym") {
      throw new ParseFailure(`expected a token, found '${tokenTok.text}' at column ${tokenTok.pos + 1}`, tokenTok.pos);
    }

    const opTok = this.peek();
    if (opTok === undefined) {
      throw new ParseFailure(`expected an operator after '${tokenTok.text}'`, this.endPos());
    }
    if (opTok.kind !== "sym" && opTok.kind !== "word") {
      throw new ParseFailure(`expected an operator after '${tokenTok.text}', found '${opTok.text}'`, opTok.pos);
    }
    this.advance();
    const operator = resolveOperator(opTok);

    let value: unknown;
    if (LIST_OPERATORS.has(operator)) {
      const items = this.parseValueList();
      if (operator === "Between" && items.length !== 2) {
        throw new ParseFailure(`'between' requires exactly two values, got ${items.length}`, opTok.pos);
      }
      if (operator === "BetweenNoEnd" && (items.length < 1 || items.length > 2)) {
        throw new ParseFailure(`'betweenNoEnd' takes one or two values, got ${items.length}`, opTok.pos);
      }
      if ((operator === "IsIn" || operator === "IsNotIn") && items.some((v) => v === null)) {
        throw new ParseFailure(
          `'${opTok.text}' cannot include null — this is a Signum limitation, not a parser gap. ` +
          `Try: '${tokenTok.text} = null or ${tokenTok.text} ${opTok.text} (...)'`,
          opTok.pos,
        );
      }
      value = items;
    } else {
      value = this.parseSingleValue();
    }

    return { kind: "condition", token: tokenTok.text, operator, value, pos: tokenTok.pos };
  }

  private parseValueList(): unknown[] {
    const vals = [this.parseSingleValue()];
    while (this.peek()?.kind === "comma") {
      this.advance();
      vals.push(this.parseSingleValue());
    }
    return vals;
  }

  private parseSingleValue(): unknown {
    const t = this.peek();
    if (t === undefined) throw new ParseFailure("expected a value", this.endPos());
    if (t.kind === "lparen" || t.kind === "rparen" || t.kind === "comma" || t.kind === "sym") {
      throw new ParseFailure(`expected a value, found '${t.text}' at column ${t.pos + 1}`, t.pos);
    }
    this.advance();
    return coerceValue(t);
  }
}

function resolveOperator(t: Tok): FilterOperationName {
  if (t.kind === "sym") {
    const op = SYMBOL_OPERATORS[t.text];
    if (op === undefined) throw new ParseFailure(`unknown operator symbol '${t.text}'`, t.pos);
    return op;
  }
  const op = NAMED_OPERATORS[t.text.toLowerCase()];
  if (op === undefined) {
    throw new ParseFailure(
      `unknown operator '${t.text}'. Valid: ${Object.keys(SYMBOL_OPERATORS).join(" ")} ` +
      `${Object.keys(NAMED_OPERATORS).join(", ")}`,
      t.pos,
    );
  }
  return op;
}

/**
 * A value's JS shape is inferred from its own lexical form, not the token's declared type —
 * full type-aware coercion needs live `subTokens` (REQ-012, m2). Quoted text is always a
 * literal string except for the Lite heuristic below; unquoted keywords are recognized.
 */
function coerceValue(t: Tok): unknown {
  if (t.kind === "string") {
    return tryLiteValue(t.text) ?? t.text;
  }
  const w = t.text;
  const lw = w.toLowerCase();
  if (lw === "null") return null;
  if (lw === "true") return true;
  if (lw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(w)) return Number(w);
  return tryLiteValue(w) ?? w; // enum member, ISO date, or plain string — server re-kinds dates itself
}

/**
 * `"Order;42"` must become the wire's Lite object form, not a bare string — the reference
 * doc is explicit that "a Lite filter value uses the object form; the minimum is
 * {"EntityType":"Order","id":42}". This is a genuine implementation detail the design doc's
 * Values table didn't spell out; documented here and worth folding back into that doc.
 */
function tryLiteValue(s: string): { EntityType: string; id: number | string } | undefined {
  const parsed = parseLiteKey(s);
  if (parsed === undefined) return undefined;
  const id: number | string = /^\d+$/.test(parsed.id) ? Number(parsed.id) : parsed.id;
  return { EntityType: parsed.type, id };
}

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** Whether `--group` was passed — aggregate tokens need `groupResults: true` (constraint 5). */
  groupEnabled: boolean;
}

function validateToken(token: string, opts: ValidateOptions): void {
  const segments = token.split(TOKEN_SPLIT);

  // `.Nested` is discoverable via subTokens but unusable in executeQuery (constraint 6).
  if (segments.includes("Nested")) {
    throw new UsageError(`token '${token}' uses '.Nested', which cannot be used in a query filter`, {
      hint: "'.Nested' is discoverable via metadata but the server rejects it in executeQuery. Restructure the filter to avoid it.",
    });
  }

  const last = segments[segments.length - 1];
  if (last !== undefined && AGGREGATE_SEGMENTS.has(last) && !opts.groupEnabled) {
    throw new UsageError(`token '${token}' looks like an aggregate ('${last}') but --group was not given`, {
      hint: "Aggregate tokens require --group, or the request will fail server-side. See `signum help filter`.",
    });
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/** Parse one `--filter` string into an AST. Throws `UsageError` with a column-anchored message. */
export function parseFilterExpression(input: string): FilterNode {
  let toks: Tok[];
  try {
    toks = tokenize(input);
  } catch (e) {
    throw asUsageError(input, e);
  }
  if (toks.length === 0) throw new UsageError("empty --filter expression");
  try {
    return new Parser(toks).parseExpr();
  } catch (e) {
    throw asUsageError(input, e);
  }
}

function asUsageError(input: string, e: unknown): UsageError {
  if (!(e instanceof ParseFailure)) throw e instanceof Error ? e : new Error(String(e));
  const caret = " ".repeat(e.pos) + "^";
  let hint = `${input}\n${caret}`;
  // Constraint 1: an unquoted leading '(' always opens a group, never a cast token.
  if (input.trimStart().startsWith("(")) {
    hint +=
      "\n\nA query token beginning with '(' (a cast, e.g. '(Order).Customer.Name') must be quoted, " +
      'or it is parsed as a group: --filter \'"(Order).Customer.Name" = 5\'.';
  }
  return new UsageError(`could not parse filter: ${e.message}`, { hint });
}

function collectAndTerms(node: FilterNode): FilterNode[] {
  return node.kind === "and" ? node.terms.flatMap(collectAndTerms) : [node];
}

function lower(node: FilterNode, opts: ValidateOptions): FilterWire {
  if (node.kind === "condition") {
    validateToken(node.token, opts);
    return { token: node.token, operation: node.operator, value: node.value };
  }
  if (node.kind === "and") return { groupOperation: "And", filters: node.terms.map((t) => lower(t, opts)) };
  return { groupOperation: "Or", filters: node.terms.map((t) => lower(t, opts)) };
}

/**
 * Compose parsed `--filter` expressions (and, by the caller, any `--filter-json` items) into
 * the flat top-level array the server ANDs implicitly. Only the OUTERMOST and is flattened —
 * design doc: "a top-level list of conditions with no explicit operator is emitted as a flat
 * array, not wrapped in a redundant group." An AND nested inside an OR stays an explicit
 * group, since flattening there would change the expression's meaning.
 */
export function lowerFilterExpressions(nodes: readonly FilterNode[], opts: ValidateOptions): FilterWire[] {
  return nodes.flatMap(collectAndTerms).map((n) => lower(n, opts));
}
