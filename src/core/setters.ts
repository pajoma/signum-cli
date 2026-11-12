/**
 * Property setters over many records (AC-45.4, #119).
 *
 * The multi endpoints do not take entities. They take `MultiOperationRequest.Setters`, a list of
 * `PropertySetter { property, operation, value, … }` that the server applies to each record after
 * retrieving it and before running the operation (`OperationController.cs:211-256`, `MultiSetter`
 * at `:368-497`). The server checks each property for write permission as it applies it
 * (`AssertCanWrite`), so a setter is never a way around the record's own rules.
 *
 * Two ways in:
 *   - `--edit Member.Path=value` over many records, the same flag and meaning as for one record,
 *     becomes a `Set`. A dotted path reaches into an embedded entity, as `PropertyRoute.AddMany`
 *     splits it (`PropertyRoute.cs:64-70`). A position in an MList has no setter — rows are chosen by
 *     a predicate, not an index — so it is refused, naming the JSON form.
 *   - `--setters-json` takes the setter list itself, for everything else: MList rows added, changed
 *     or removed by predicate, a new embedded or referenced entity. It is checked here for shape, so
 *     a mistake is a usage error rather than the server's `UnexpectedValueException`.
 *
 * Property names are case-sensitive on the server (`PropertyRoute.GetMember`, reflection on the CLR
 * type), so `--edit name=…` is spelled as reflection spells it. A handle in a value resolves locally
 * to the Lite it stands for (AC-53.2), so it never reaches the server.
 */

import type { ArgValue } from "./operations.ts";
import { UsageError } from "./errors.ts";
import { JsonNumber } from "./json.ts";
import type { MemberInfo, TypeInfo } from "./metadata.ts";
import { isHandle, resolveHandle } from "./reidentify.ts";
import { parseLiteKey } from "./text.ts";

/** `PropertySetter` (`OperationController.cs:307-316`), as the web client writes it (`Operations.tsx:357-365`). */
export interface PropertySetter {
  property: string;
  operation?: PropertyOperation;
  filterOperation?: string;
  value?: unknown;
  entityType?: string;
  predicate?: PropertySetter[];
  setters?: PropertySetter[];
}

/** `PropertyOperation` (`Signum.Operations.ts:45-53`). */
export const PROPERTY_OPERATIONS = [
  "Set", "AddElement", "AddNewElement", "ChangeElements", "RemoveElement", "RemoveElementsWhere", "ModifyEntity", "CreateNewEntity",
] as const;
export type PropertyOperation = (typeof PROPERTY_OPERATIONS)[number];

/** `FilterOperation` for a predicate (`Signum.DynamicQuery.ts:34-56`), as far as an in-memory compare supports it. */
const FILTER_OPERATIONS = new Set([
  "EqualTo", "DistinctTo", "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual",
  "Contains", "StartsWith", "EndsWith", "Like", "NotContains", "NotStartsWith", "NotEndsWith", "NotLike", "IsIn", "IsNotIn",
]);

/** Which setter fields each operation needs (`MultiSetter.SetSetters`, `OperationController.cs:376-461`). */
const NEEDS: Record<PropertyOperation, { setters?: true; predicate?: true; value?: true }> = {
  Set: { value: true },
  AddElement: { value: true },
  AddNewElement: { setters: true },
  ChangeElements: { setters: true, predicate: true },
  RemoveElement: { value: true },
  RemoveElementsWhere: { predicate: true },
  ModifyEntity: { setters: true },
  CreateNewEntity: { setters: true },
};

const JSON_HINT =
  'For MList rows use --setters-json, e.g. \'[{"property":"Roles","operation":"ChangeElements",' +
  '"predicate":[{"property":"Role","filterOperation":"EqualTo","value":{"EntityType":"RASCIRole","id":3}}],' +
  '"setters":[{"property":"RASCI","operation":"Set","value":"R"}]}]\'.';

function lite(key: { type: string; id: string }): Record<string, unknown> {
  return { EntityType: key.type, id: /^\d+$/.test(key.id) ? new JsonNumber("identifier", key.id) : key.id };
}

/**
 * Where handles go: resolved to the Lites they stand for (to send), or kept as written (to show in
 * `--explain`, which must not spell out the id behind a handle).
 */
export type HandleMode = Readonly<Record<string, string>> | "keep";

/** A value as the server should receive it: a handle or a Lite key becomes a Lite where one is expected. */
function wireValue(value: unknown, handles: HandleMode, expectLite: boolean): unknown {
  if (typeof value !== "string") return value;
  if (handles === "keep" && isHandle(value)) return value;
  const real = isHandle(value) ? resolveHandle(value, handles as Readonly<Record<string, string>>) : value;
  const key = parseLiteKey(real);
  if (key !== undefined && (expectLite || real !== value)) return lite(key);
  return real;
}

/** The member a dotted `--edit` path names, spelled as reflection spells it. */
function memberOf(type: TypeInfo, path: readonly (string | number)[], written: string): MemberInfo {
  if (path.some((s) => typeof s === "number")) {
    throw new UsageError(`--edit '${written}' addresses a row by position, which has no setter over many records`, {
      hint: "Over many records, MList rows are chosen by a predicate, not an index.\n" + JSON_HINT,
    });
  }
  const dotted = path.join(".");
  const found = type.members.find((m) => m.name === dotted)
    ?? type.members.find((m) => m.name.toLowerCase() === dotted.toLowerCase());
  if (found === undefined || found.name.includes("/")) {
    throw new UsageError(`${type.name} has no member '${dotted}' to set`, {
      hint: `Run \`signum explain ${type.name}\` to see its members.`,
    });
  }
  if (found.isCollection === true) {
    throw new UsageError(`${type.name}.${found.name} is a list; --edit over many records sets one value`, { hint: JSON_HINT });
  }
  return found;
}

/** `--edit` over many records, as `Set` setters (AC-45.4). */
export function settersFromEdits(
  type: TypeInfo,
  edits: ReadonlyArray<{ path: readonly (string | number)[]; value: ArgValue; written: string }>,
  handles: HandleMode,
): PropertySetter[] {
  return edits.map((e) => {
    const member = memberOf(type, e.path, e.written);
    return { property: member.name, operation: "Set", value: wireValue(e.value, handles, member.isLite === true) };
  });
}

/**
 * `--setters-json`: the setter list itself, checked for the shape the server needs. Values pass
 * through as written, except that a handle anywhere becomes the Lite it stands for.
 */
export function parseSettersJson(text: string, handles: HandleMode): PropertySetter[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--setters-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new UsageError("--setters-json must be a non-empty JSON array of property setters", {
      hint: '[{"property":"Name","operation":"Set","value":"Acme"}]',
    });
  }
  return parsed.map((s, i) => checkSetter(s, `[${i}]`, handles, false));
}

function checkSetter(raw: unknown, where: string, handles: HandleMode, inPredicate: boolean): PropertySetter {
  const fail = (what: string): never => {
    throw new UsageError(`--setters-json ${where}: ${what}`, { hint: JSON_HINT });
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("is not an object");
  const s = raw as Record<string, unknown>;
  const known = new Set(["property", "operation", "filterOperation", "value", "entityType", "predicate", "setters"]);
  const unknown = Object.keys(s).filter((k) => !known.has(k));
  if (unknown.length > 0) fail(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `'${k}'`).join(", ")}`);
  if (typeof s["property"] !== "string" || s["property"] === "") fail("needs a \"property\"");

  const out: PropertySetter = { property: s["property"] as string };
  if (inPredicate) {
    // A predicate compares; it sets nothing (`GetPredicate`, `OperationController.cs:476-492`).
    if (typeof s["filterOperation"] !== "string" || !FILTER_OPERATIONS.has(s["filterOperation"])) {
      fail(`a predicate needs a "filterOperation", one of ${[...FILTER_OPERATIONS].join(", ")}`);
    }
    out.filterOperation = s["filterOperation"] as string;
    if ("value" in s) out.value = wireValue(s["value"], handles, false);
    return out;
  }

  const op = s["operation"];
  if (typeof op !== "string" || !(PROPERTY_OPERATIONS as readonly string[]).includes(op)) {
    fail(`needs an "operation", one of ${PROPERTY_OPERATIONS.join(", ")}`);
  }
  out.operation = op as PropertyOperation;
  const needs = NEEDS[out.operation];
  if (needs.value === true && !("value" in s)) fail(`${op} needs a "value"`);
  if (needs.setters === true && (!Array.isArray(s["setters"]) || s["setters"].length === 0)) fail(`${op} needs "setters"`);
  if (needs.predicate === true && !Array.isArray(s["predicate"])) fail(`${op} needs a "predicate" (an empty one matches every row)`);
  if ("value" in s) out.value = wireValue(s["value"], handles, false);
  if (typeof s["entityType"] === "string") out.entityType = s["entityType"];
  if (Array.isArray(s["predicate"])) out.predicate = s["predicate"].map((p, i) => checkSetter(p, `${where}.predicate[${i}]`, handles, true));
  if (Array.isArray(s["setters"])) out.setters = s["setters"].map((c, i) => checkSetter(c, `${where}.setters[${i}]`, handles, false));
  return out;
}

/** The setters as a person reads them in a confirmation: `Name=Acme`, `Roles: ChangeElements`. */
export function describeSetters(setters: readonly PropertySetter[]): string[] {
  return setters.map((s) => s.operation === "Set" ? `${s.property}=${JSON.stringify(s.value)}` : `${s.property}: ${s.operation}`);
}
