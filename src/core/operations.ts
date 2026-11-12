/**
 * Operations: naming one without guessing (REQ-041, STORY-41) and encoding its arguments (REQ-042,
 * STORY-42). Both are pure — metadata and flags in, a decision out — so the command that sends an
 * operation (`commands/operate.ts`) holds no rule of its own about either.
 *
 * Keys are `ContainerClassName.FieldName`, never namespace-qualified (`Symbol.cs:22`), and the
 * field name IS the verb (design/cli-surface.md §2.1). The noun comes from metadata — the type the
 * operation is registered against — never from stripping `Operation` off the container's name.
 */

import { UsageError } from "./errors.ts";
import { JsonNumber, parseLossless } from "./json.ts";
import { findType, unknownTypeError, type Metadata, type OperationInfo, type TypeInfo } from "./metadata.ts";
import { isHandle, resolveHandle } from "./reidentify.ts";
import { editDistance, parseLiteKey } from "./text.ts";

/** An operation resolved to one key on one type. */
export interface ResolvedOperation {
  /** Canonical key, spelled as metadata spells it. */
  key: string;
  /** The type the operation runs on. */
  type: TypeInfo;
  info: OperationInfo;
}

/** Case-insensitive and kebab-tolerant (AC-41.7): `import-public-holidays` ≡ `ImportPublicHolidays`. */
function norm(s: string): string {
  return s.replace(/[-_]/g, "").toLowerCase();
}

/** `findType`, then the same name kebab-tolerantly: `holiday-calendar` finds `HolidayCalendar`. */
export function findTypeLoose(md: Metadata, name: string): TypeInfo | undefined {
  const exact = findType(md, name);
  if (exact !== undefined) return exact;
  const wanted = norm(name);
  return [...md.types.values()].find((t) => norm(t.name) === wanted || norm(t.name.replace(/Entity$/, "")) === wanted);
}

/** The kebab-case verb a person types for an operation: `ImportPublicHolidays` → `import-public-holidays`. */
export function kebab(verb: string): string {
  return verb.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();
}

function listing(type: TypeInfo): string {
  const shown = type.operations.slice(0, 12).map((o) => `  signum ${kebab(o.verb)} ${kebab(type.name)}    (${o.key})`);
  return shown.join("\n") + (type.operations.length > shown.length ? "\n  …" : "");
}

/**
 * `signum <verb> <noun>` → one operation (AC-41.2, AC-41.3, AC-41.4).
 *
 * Built-ins already won dispatch before this runs (args.ts rule 2), so a verb shadowed by one never
 * arrives here — it is reachable only by its canonical key, which `resolveKey` handles (AC-41.8).
 */
export function resolveVerbNoun(md: Metadata, verb: string, noun: string): ResolvedOperation {
  const type = findTypeLoose(md, noun);
  if (type === undefined) throw unknownTypeError(md, noun);

  const matches = type.operations.filter((o) => norm(o.verb) === norm(verb));
  if (matches.length === 1) {
    const info = matches[0] as OperationInfo;
    return { key: info.key, type, info };
  }
  if (matches.length > 1) {
    // Two containers can declare the same field name for one type. Picking one would run an
    // operation nobody named (AC-41.3).
    throw new UsageError(`'${verb}' is ambiguous for ${type.name}: ${matches.map((m) => m.key).join(", ")}`, {
      hint: `Name it by its canonical key, e.g.\n  signum ${(matches[0] as OperationInfo).key} --lite "${type.name};<id>"`,
    });
  }
  if (type.operations.length === 0) {
    throw new UsageError(`${type.name} has no operations you can invoke`, {
      hint: "The list is a positive capability list: an operation this login may not use is absent, not missing.",
    });
  }
  const near = type.operations
    .map((o) => ({ o, d: editDistance(norm(verb), norm(o.verb)) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(norm(verb).length / 3)))
    .sort((a, b) => a.d - b.d)
    .map((x) => kebab(x.o.verb));
  throw new UsageError(`'${verb}' is not an operation of ${type.name}`, {
    hint: (near.length > 0 ? `Did you mean: ${near.join(", ")}?\n` : "") + `${type.name}'s operations:\n${listing(type)}`,
  });
}

/**
 * A dotted key → one operation (AC-41.1, AC-41.4, AC-41.5). `typeName` picks the type when the key
 * is registered on several, and is required then — it comes from the target (`--lite "Order;42"`).
 */
export function resolveKey(md: Metadata, key: string, typeName?: string): ResolvedOperation {
  const all = [...md.types.values()].flatMap((t) => t.operations.map((info) => ({ type: t, info })));
  const hits = all.filter((x) => x.info.key.toLowerCase() === key.toLowerCase());

  if (hits.length === 0) {
    const segments = key.split(".");
    if (segments.length > 2) {
      // `Signum.Authorization.UserOperation.Save` — the commonest wrong turn. Answer with the real
      // format, and the real key when the last two segments name one (AC-41.5).
      const short = segments.slice(-2).join(".");
      const exists = all.some((x) => x.info.key.toLowerCase() === short.toLowerCase());
      throw new UsageError(`operation keys are not namespace-qualified: '${key}'`, {
        hint: "A key is ContainerClassName.FieldName (Symbol.cs:22)" +
          (exists ? `, so this one is ${short}.` : `, e.g. UserOperation.Save.`),
      });
    }
    const keys = [...new Set(all.map((x) => x.info.key))];
    const near = keys
      .map((k) => ({ k, d: editDistance(k.toLowerCase(), key.toLowerCase()) }))
      .filter((x) => x.d <= 3)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map((x) => x.k);
    throw new UsageError(`unknown operation '${key}'`, {
      hint: (near.length > 0 ? `Did you mean: ${near.join(", ")}?\n` : "") +
        "Run `signum operations` to list them. An operation this login may not use is absent, not missing.",
    });
  }

  if (typeName !== undefined) {
    const type = findTypeLoose(md, typeName);
    if (type === undefined) throw unknownTypeError(md, typeName);
    const hit = hits.find((x) => x.type === type);
    if (hit === undefined) {
      throw new UsageError(`${hits[0]?.info.key} is not an operation of ${type.name}`, {
        hint: `It runs on: ${hits.map((x) => x.type.name).join(", ")}.`,
      });
    }
    return { key: hit.info.key, type, info: hit.info };
  }
  if (hits.length > 1) {
    throw new UsageError(`${hits[0]?.info.key} runs on several types: ${hits.map((x) => x.type.name).join(", ")}`, {
      hint: `Say which with the target: --lite "${hits[0]?.type.name};<id>"`,
    });
  }
  const only = hits[0] as { type: TypeInfo; info: OperationInfo };
  return { key: only.info.key, type: only.type, info: only.info };
}

// ─── args (REQ-042) ────────────────────────────────────────────────────────────

/** The flags that contribute to `args`, in the order typed (AC-42.1). */
export const ARG_FLAGS = ["arg", "arg-string", "arg-lite", "arg-json"] as const;

/** A JSON-shaped value, kept exact: numbers stay `JsonNumber` so their digits survive. */
export type ArgValue = unknown;

/** Date-shaped: what `JsonElement.TryGetDateTime` would accept, near enough to warn on (AC-42.3). */
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export interface EncodeOptions {
  handles: Readonly<Record<string, string>>;
  /** The app registered a `CustomOperationArgsConverters` entry, so a plain object is meaningful. */
  allowCustomObjects: boolean;
  warn: (line: string) => void;
}

function liteFrom(value: string, flagName: string, handles: Readonly<Record<string, string>>): ArgValue {
  // `Customer=Customer;7` would otherwise parse as a Lite of type "Customer=Customer".
  if (/^[^;=]+=/.test(value)) {
    throw new UsageError(`--${flagName} '${value}': operation args are positional, not named`, {
      hint: 'Pass the Lite alone, in the order the operation expects: --arg-lite "Customer;7"',
    });
  }
  // A handle is resolved LOCALLY, so it never reaches the server (AC-53.2).
  const key = isHandle(value) ? resolveHandle(value, handles) : value;
  const lite = parseLiteKey(key);
  if (lite === undefined) {
    throw new UsageError(`--${flagName} '${value}' is not a Lite key or handle`, { hint: '--arg-lite "Customer;7"' });
  }
  return { EntityType: lite.type, id: /^\d+$/.test(lite.id) ? new JsonNumber("identifier", lite.id) : lite.id };
}

/**
 * Refuse an object with neither `EntityType` nor `Type`, anywhere in an argument (AC-42.4): the
 * server turns it into `null` with no error unless the app registered a converter for this operation
 * (`ConvertObject`, object branch). Recursive, because arrays convert element by element.
 */
function assertConvertible(value: unknown, where: string, opts: EncodeOptions): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertConvertible(v, `${where}[${i}]`, opts));
    return;
  }
  if (value === null || typeof value !== "object" || value instanceof JsonNumber) return;
  const o = value as Record<string, unknown>;
  if (Object.hasOwn(o, "EntityType") || Object.hasOwn(o, "Type")) return;
  if (opts.allowCustomObjects) return;
  throw new UsageError(`${where} is an object with neither EntityType nor Type, which the server receives as null`, {
    hint:
      "The server builds a Lite from EntityType and an entity from Type; any other object goes to the\n" +
      "app's own converter for this operation, and becomes null — with no error — when there is none.\n" +
      "If the app registered one, pass --allow-custom-arg.",
  });
}

/** One `--arg*` value → its JSON shape. The flag decides the shape, never the content (#115). */
export function encodeArg(flagName: (typeof ARG_FLAGS)[number], value: string, opts: EncodeOptions): ArgValue {
  switch (flagName) {
    case "arg-string":
      if (DATE_SHAPED.test(value)) {
        // The server parses a date-shaped string as a date before it considers a string, and nothing
        // a client sends changes that (AC-42.3). Warn; do not refuse — sometimes a date is meant.
        opts.warn(`warning: --arg-string '${value}' is date-shaped, so the server receives a date, not a string\n`);
      }
      return value;
    case "arg-lite":
      return liteFrom(value, flagName, opts.handles);
    case "arg-json": {
      let parsed: unknown;
      try {
        parsed = parseLossless(value);
      } catch {
        throw new UsageError(`--arg-json '${value}' is not valid JSON`);
      }
      assertConvertible(parsed, "--arg-json", opts);
      return parsed;
    }
    case "arg": {
      // Inference, for the common scalars only. Anything structured needs --arg-json, so that a
      // value is never turned into an object or array by accident.
      if (value === "true") return true;
      if (value === "false") return false;
      if (value === "null") return null;
      // Every number arrives as a decimal (AC-42.5); its digits are kept exact on the way.
      if (NUMBER.test(value)) return new JsonNumber("number", value);
      if (isHandle(value) || parseLiteKey(value) !== undefined) return liteFrom(value, flagName, opts.handles);
      if (DATE_SHAPED.test(value)) opts.warn(`note: --arg '${value}' is date-shaped, so the server receives a date\n`);
      return value;
    }
  }
}

/** Every `--arg*` flag, in typed order, as the `args` array; `null` when none were given. */
export function encodeArgs(sequence: ReadonlyArray<readonly [string, string]>, opts: EncodeOptions): ArgValue[] | null {
  const args = sequence
    .filter(([name]) => (ARG_FLAGS as readonly string[]).includes(name))
    .map(([name, value]) => encodeArg(name as (typeof ARG_FLAGS)[number], value, opts));
  return args.length === 0 ? null : args;
}
