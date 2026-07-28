/**
 * Pseudonymization — REQ-057 (#51) · STORY-52 · ADR 0007, ADR 0009.
 *
 * Replaces sensitive values with **stable surrogates**, not blanks, so an agent can still group and
 * correlate rows without seeing real personal data.
 *
 * Three constraints shape everything here, and they are not negotiable:
 *
 * 1. **The framework offers no sensitivity metadata at all.** No `[PersonalData]`, nothing
 *    GDPR-aware, and this CLI is generic — it cannot know that `Customer.Name` is personal while
 *    `Product.Name` is not. Correct automatic classification is therefore impossible *in principle*,
 *    which is why there is an explicit policy and why the output always states its own incompleteness
 *    (AC-52.6).
 * 2. **The policy is never a per-call parameter** (ADR 0009 Decision 1, AC-52.10). It is resolved
 *    from the profile and the caller context. A caller may *tighten* it; loosening it under a
 *    detected agent needs the human-typed acknowledgement flag and is logged — the same asymmetry
 *    `--caller-context` already uses (AC-50.4). Otherwise the protection would rest on the party
 *    whose interest is to read the data.
 * 3. **This is not a compliance control** (AC-52.9). Pseudonymized data remains personal data under
 *    GDPR Art. 4(5). The CLI must never claim otherwise.
 */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writeSecret } from "./config.ts";
import { UsageError } from "./errors.ts";

export const PSEUDONYMIZE_MODES = ["off", "heuristic", "strict"] as const;
export type PseudonymizeMode = (typeof PSEUDONYMIZE_MODES)[number];

/** Ordered, so a caller can tighten but not loosen without an explicit acknowledgement. */
const STRICTNESS: Record<PseudonymizeMode, number> = { off: 0, heuristic: 1, strict: 2 };

export function parseMode(value: string): PseudonymizeMode {
  const v = value.trim().toLowerCase();
  if ((PSEUDONYMIZE_MODES as readonly string[]).includes(v)) return v as PseudonymizeMode;
  throw new UsageError(`unknown pseudonymization mode '${value}'`, {
    hint: `Valid modes: ${PSEUDONYMIZE_MODES.join(", ")}.`,
  });
}

/**
 * Member-name heuristics, English and German at minimum (AC-52.4) — the target deployment is
 * German-language, and a name-based heuristic that only knows English is barely a heuristic.
 *
 * Matched against WORDS, after splitting a PascalCase segment: `CustomerName` -> [customer, name].
 * Substring matching was rejected because `Filename` contains `name`. Word matching still
 * misfires on `FileName`, which is exactly why AC-52.6 requires the output to say what it
 * pseudonymized — a false positive must be visible, not silent.
 */
const SENSITIVE_WORDS = new Set([
  // names
  "name", "names", "firstname", "lastname", "surname", "fullname",
  "vorname", "nachname", "familienname",
  // contact
  "email", "mail", "emailaddress", "phone", "telephone", "mobile", "fax",
  "telefon", "telefonnummer", "mobil", "handy",
  // address
  "address", "street", "postcode", "zipcode", "zip",
  "adresse", "anschrift", "strasse", "straße", "plz", "wohnort",
  // identifiers and dates
  "birthdate", "dateofbirth", "dob", "geburtsdatum", "geburtstag",
  "iban", "bic", "taxid", "ssn", "steuernummer", "sozialversicherungsnummer",
  "passport", "ausweisnummer", "personalnummer",
]);

/** Split a token segment into lowercase words: `Entity.Customer.FirstName` -> [first, name]. */
function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
}

export interface PrivacyPolicy {
  mode: PseudonymizeMode;
  /** Token or member names always pseudonymized, whatever the heuristics say. */
  always: ReadonlySet<string>;
  /** Token or member names never pseudonymized — the allowlist that gives `strict` its meaning. */
  allow: ReadonlySet<string>;
  /**
   * Per-profile secret, resolved LAZILY. Surrogates are stable across invocations because this is
   * (ADR 0009 Q1). Lazy because most commands — help, metadata, discovery — pseudonymize nothing,
   * and creating a secret file for them would both be pointless and fail when the config directory
   * is not writable.
   */
  secret: () => string;
  /** Where the policy came from, for `--privacy` output. */
  origin: "default" | "profile";
  /** Per-run cache for the name-based half of the decision. Cells are many; names are few. */
  memo: Map<string, Classification>;
}

export type ClassificationReason =
  | "mode-off"
  /** An entity reference: identifying by construction, whatever the member is called (AC-52.12). */
  | "identity"
  | "policy-allow"
  | "policy-always"
  | "heuristic-match"
  | "strict-default"
  | "not-sensitive";

export interface Classification {
  pseudonymize: boolean;
  reason: ClassificationReason;
  /** The word that triggered a heuristic match, so a reader can judge a false positive. */
  matched?: string;
}

export interface SensitivityInput {
  /** Member name or column token. */
  name: string;
  /**
   * The value, where one exists. An entity reference is an identity whatever its column is called,
   * and only the value can tell us (AC-52.12).
   */
  value?: unknown;
  /** The member's declared type, from reflection metadata, for the introspection path. */
  memberType?: string | undefined;
  /** True when this column's values are an entity's LABEL because `--resolve` rewrote it. */
  isEntityLabel?: boolean;
  /** Does this type name denote a reflected entity type? Supplied by callers that hold metadata. */
  isEntityType?: ((typeName: string) => boolean) | undefined;
}

/**
 * **The** sensitivity decision. One function, every path.
 *
 * There were four of these — name-based here, name+value+label in `resolveResultTable`,
 * name+member-type in `explain --privacy`, and name-only in `pseudonymizeDocument`. They drifted
 * twice: introspection contradicted behaviour, and `get` emitted entity references in full under the
 * default policy while claiming it had pseudonymized nothing. A rule with four homes is a rule that
 * will disagree with itself, so this is now the only producer of a `Classification`.
 *
 * Precedence, and each step earns its place:
 *   1. mode off                       — nothing to decide
 *   2. explicit allowlist             — a human said this one is fine, and that beats every
 *                                       inference including the identity rule, which is what makes
 *                                       allowlisting `Entity` a usable workaround
 *   3. explicit always                — a human said this one is not
 *   4. identity (value / type / label) — identifying by construction, whatever it is called
 *   5. name heuristics                — English and German member names (AC-52.4)
 *   6. strict                         — allowlist-only, so anything left is replaced
 *
 * The reason is not decoration: REQ-059 exposes it so an agent can explain what will be hidden
 * without being able to change it, and so a human can spot a misfire.
 */
export function sensitivity(input: SensitivityInput, policy: PrivacyPolicy): Classification {
  if (policy.mode === "off") return { pseudonymize: false, reason: "mode-off" };

  const byName = nameDecision(input.name, policy);
  // An explicit allowlist wins outright — see precedence note above.
  if (byName.reason === "policy-allow") return byName;
  if (byName.reason === "policy-always") return byName;

  if (isIdentityInput(input)) return { pseudonymize: true, reason: "identity" };

  return byName;
}

/** Name-only half, memoized per policy: the answer cannot vary by row, and cells are many. */
function nameDecision(token: string, policy: PrivacyPolicy): Classification {
  const cached = policy.memo.get(token);
  if (cached !== undefined) return cached;

  const segment = token.split(".").filter((s) => s !== "").pop() ?? token;
  const lower = segment.toLowerCase();
  const full = token.toLowerCase();

  let result: Classification;
  // Explicit policy beats heuristics in both directions (AC-52.5).
  if (policy.allow.has(lower) || policy.allow.has(full)) {
    result = { pseudonymize: false, reason: "policy-allow" };
  } else if (policy.always.has(lower) || policy.always.has(full)) {
    result = { pseudonymize: true, reason: "policy-always" };
  } else {
    const hit = words(segment).find((w) => SENSITIVE_WORDS.has(w));
    if (hit !== undefined) {
      result = { pseudonymize: true, reason: "heuristic-match", matched: hit };
    } else if (policy.mode === "strict") {
      // strict is allowlist-only: anything not explicitly permitted is replaced (AC-52.3, AC-52.8).
      result = { pseudonymize: true, reason: "strict-default" };
    } else {
      result = { pseudonymize: false, reason: "not-sensitive" };
    }
  }

  policy.memo.set(token, result);
  return result;
}

/** The three ways we can know a member denotes an entity, none of which is its name. */
function isIdentityInput(input: SensitivityInput): boolean {
  if (input.isEntityLabel === true) return true;
  if (input.value !== undefined && isIdentityValue(input.value)) return true;
  if (input.memberType !== undefined && input.isEntityType?.(input.memberType) === true) return true;
  return false;
}

/**
 * A stable surrogate for one value (AC-52.1).
 *
 * Derived from the VALUE alone, not the value plus the column, so the same person maps to the same
 * surrogate across columns and across commands — that is what makes surrogates more useful than
 * redaction, and what lets an agent correlate rows it cannot read.
 *
 * The label prefix comes from the token so the output stays readable (`Customer-7f3a`, per
 * ADR 0007). It is cosmetic: the identity lives in the digest.
 *
 * Under `strict` this also replaces the `Entity` column, which is correct by the allowlist rule but
 * costs the row its pasteable identity — `signum get` and `-o name` lose their input. Turning identity
 * into a usable opaque handle (`ref:7f3a`) is REQ-058 (#52); until then, allowlist `Entity` in
 * privacy.json if you need to act on the rows you are reading.
 *
 * Type preservation (AC-52.7) is **partial** and knowingly so: a number stays numeric so downstream
 * parsing does not break, but a date becomes a labelled string rather than a plausible date.
 * Fabricating a date that looks real risks being mistaken for data, which is worse than being
 * obviously a surrogate. Full type preservation is follow-up work.
 */
export function surrogate(
  value: unknown,
  token: string,
  policy: PrivacyPolicy,
  recorder?: HandleRecorder,
): unknown {
  if (value === null || value === undefined) return value; // absence is not identifying
  if (typeof value === "boolean") return value;            // one bit cannot identify anyone

  const digest = createHmac("sha256", policy.secret()).update(canonical(value)).digest("hex");

  // A Lite is an IDENTITY, not a value, so it becomes an opaque handle the caller can act through
  // rather than a label it can only read (AC-53.1). `ref:` is deliberately not `Type;id`-shaped, so
  // nothing downstream mistakes it for one.
  const lite = liteKeyOf(value);
  if (lite !== undefined) {
    const handle = `${HANDLE_PREFIX}${digest.slice(0, HANDLE_HEX)}`;
    recorder?.record(handle, lite);
    return handle;
  }

  if (typeof value === "number") {
    // Stable, positive, and numeric — so a csv column of numbers stays a column of numbers.
    return Number.parseInt(digest.slice(0, 8), 16);
  }

  return `${labelFor(token)}-${digest.slice(0, 4)}`;
}

export const HANDLE_PREFIX = "ref:";

/**
 * 48 bits of digest. ADR 0007 illustrates a handle as `ref:7f3a`, but 16 bits collide at a few
 * hundred entries by the birthday bound, and a handle collision means two people sharing one
 * identity — the exact silent mismatch AC-53.6 forbids. 12 hex characters makes that negligible at
 * any realistic volume, and `saveHandles` still detects a collision rather than trusting the maths.
 */
const HANDLE_HEX = 12;

/** Collects handle -> real mappings so the caller can persist them BEFORE anything is emitted. */
export interface HandleRecorder {
  record(handle: string, real: string): void;
}

export function createRecorder(): HandleRecorder & { entries(): Record<string, string> } {
  const map: Record<string, string> = {};
  return {
    record(handle, real) { map[handle] = real; },
    entries() { return map; },
  };
}

/** `{EntityType, id}` -> `"Type;id"`, or undefined when the value is not a Lite. */
function liteKeyOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const type = o["EntityType"] ?? o["Type"];
  const id = o["id"];
  if (typeof type === "string" && (typeof id === "string" || typeof id === "number")) {
    return `${type};${String(id)}`;
  }
  return undefined;
}

/**
 * Is this VALUE an entity reference, i.e. an identity?
 *
 * Name-based heuristics cannot catch these. An entity-valued column is called `User`, `Customer` or
 * `Owner` — none of which contains "name" or "email" — yet its value denotes a *person*, and
 * `flatCell` renders that person's label. So the two independently-correct behaviours (label
 * rendering, name-based classification) combined to print real names under `heuristic`.
 *
 * The fix is to classify by VALUE rather than by name here: a Lite is an identity by construction,
 * whatever the column happens to be called, so it always becomes a handle under any pseudonymizing
 * mode. That also removes the earlier oddity where identities were only protected under `strict`.
 */
export function isIdentityValue(value: unknown): boolean {
  return liteKeyOf(value) !== undefined;
}

export function isHandle(value: string): boolean {
  return value.startsWith(HANDLE_PREFIX);
}

/**
 * Resolve a `ref:` handle to the real Lite key it stands for (AC-53.2).
 *
 * Throws when it cannot: an unresolvable handle must never be forwarded to the server as a literal
 * string, which would either 404 confusingly or — worse — match something (AC-53.5).
 */
export function resolveHandle(handle: string, handles: Readonly<Record<string, string>>): string {
  const real = handles[handle];
  if (real === undefined) {
    throw new UsageError(`cannot resolve ${handle}`, {
      hint:
        "Handles are local, per profile, and only valid for the surrogate secret that produced\n" +
        "them — so one from another profile, or from before `unmask --clear`, is gone for\n" +
        "good. Re-run the query that produced it to mint a fresh handle.",
    });
  }
  return real;
}

/** Stable string form, so the same logical value always digests identically. */
function canonical(value: unknown): string {
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // A Lite identifies by type+id; its label is incidental and may vary between queries.
    const type = o["EntityType"] ?? o["Type"];
    const id = o["id"];
    if (type !== undefined && id !== undefined) return `${String(type)};${String(id)}`;
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * `Entity.Customer.Name` -> `Customer`; `Name` -> `Name`; `Entity` -> `Entity`. Readability only —
 * the identity lives in the digest, never in this prefix.
 *
 * The `Entity` segment is dropped as a prefix candidate because `Entity-7f3a` says less than
 * `Customer-7f3a`. But when the token IS just `Entity` there is nothing else to fall back to, and
 * the earlier version produced a meaningless `value-7f3a`.
 */
function labelFor(token: string): string {
  const segments = token.split(".").filter((s) => s !== "");
  const meaningful = segments.filter((s) => s !== ENTITY_SEGMENT);
  if (meaningful.length >= 2) return meaningful[meaningful.length - 2] as string;
  return meaningful[meaningful.length - 1] ?? segments[segments.length - 1] ?? "value";
}

const ENTITY_SEGMENT = "Entity";

interface PolicyFile {
  mode?: string;
  always?: string[];
  allow?: string[];
}

function policyPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "privacy.json");
}

function secretPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "privacy-secret");
}

/**
 * The per-profile surrogate secret, created on first use.
 *
 * Per-profile rather than per-run is the resolution of ADR 0009 open question 1: the target
 * workflow spans several invocations — discover the type, resolve a lookup entity, then query rows
 * — and a per-run secret would give the same person a different surrogate in each step, so nothing
 * could be correlated and surrogates would be no better than redaction (AC-53.8).
 */
function loadSecret(env?: NodeJS.ProcessEnv): string {
  const path = secretPath(env);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  }
  const fresh = randomBytes(32).toString("hex");
  writeSecret(path, fresh);
  return fresh;
}

export interface ResolvePolicyOptions {
  callerIsAgent: boolean;
  /** From `--pseudonymize`. May tighten freely; loosening under an agent needs `acknowledged`. */
  requested?: PseudonymizeMode | undefined;
  /** True when the human passed `--i-understand-data-goes-to-a-model`. */
  acknowledged: boolean;
  env?: NodeJS.ProcessEnv;
  warn?: (line: string) => void;
}

/**
 * Resolve the effective policy.
 *
 * Default is `heuristic` under a detected agent and `off` otherwise (AC-52.3, AC-51.5): a human at
 * a terminal reading their own application's data needs no surrogates, and a cron job is not the
 * risk this exists for.
 */
export function resolvePolicy(opts: ResolvePolicyOptions): PrivacyPolicy {
  let mode: PseudonymizeMode = opts.callerIsAgent ? "heuristic" : "off";
  let origin: PrivacyPolicy["origin"] = "default";
  let always: string[] = [];
  let allow: string[] = [];

  const path = policyPath(opts.env);
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as PolicyFile;
      if (file.mode !== undefined) mode = parseMode(file.mode);
      always = file.always ?? [];
      allow = file.allow ?? [];
      origin = "profile";
    } catch {
      // A broken policy file must not silently disable protection — keep the default and say so.
      opts.warn?.(`warning: could not read ${path}; using the default policy\n`);
    }
  }

  if (opts.requested !== undefined && opts.requested !== mode) {
    const tightening = STRICTNESS[opts.requested] > STRICTNESS[mode];
    if (tightening || !opts.callerIsAgent) {
      mode = opts.requested;
    } else if (opts.acknowledged) {
      // Loosening under an agent is possible but never quiet (AC-50.4's asymmetry, AC-52.10).
      opts.warn?.(
        `warning: pseudonymization loosened to '${opts.requested}' under a detected AI caller\n`,
      );
      mode = opts.requested;
    } else {
      throw new UsageError(
        `refusing to loosen pseudonymization to '${opts.requested}' for a detected AI caller`,
        {
          hint:
            "Tightening needs no acknowledgement; loosening does, because the caller asking for\n" +
            "weaker protection is the caller that wants the data. Pass\n" +
            "  --i-understand-data-goes-to-a-model\n" +
            "or run this from a terminal. See `signum help pseudonymization`.",
        },
      );
    }
  }

  return {
    mode,
    always: new Set(always.map((a) => a.toLowerCase())),
    allow: new Set(allow.map((a) => a.toLowerCase())),
    // Memoized so repeated surrogates in one run read the file once, and so a command that
    // pseudonymizes nothing never touches it at all.
    secret: (() => {
      let cached: string | undefined;
      return () => (cached ??= loadSecret(opts.env));
    })(),
    origin,
    memo: new Map(),
  };
}

/**
 * What the caller must be told after emitting pseudonymized data (AC-52.6, AC-52.9).
 *
 * Silent partial protection is worse than none, because it invites false confidence — so this
 * states what was replaced AND that the coverage is incomplete, and never claims compliance.
 */
export function disclosure(policy: PrivacyPolicy, pseudonymizedTokens: readonly string[]): string {
  if (policy.mode === "off" || pseudonymizedTokens.length === 0) return "";
  return [
    `note: pseudonymized (${policy.mode}): ${[...new Set(pseudonymizedTokens)].join(", ")}`,
    "Surrogates are stable per profile, so the same value reads the same across commands.",
    "Coverage is INCOMPLETE: free text is not scanned, heuristics are locale-dependent, and",
    "aggregates can still identify. A surrogate over FEW DISTINCT VALUES is also reversible by",
    "counting rows — stability is what makes grouping work, and what makes that possible.",
    "Pseudonymized data remains personal data (GDPR Art. 4(5)); this is not a compliance control.",
    "See `signum help pseudonymization`.",
    "",
  ].join("\n");
}

/**
 * Pseudonymize an arbitrary entity document (REQ-057, for `signum get`).
 *
 * Query rows are handled inside `resolveResultTable`, where the columns are known. An entity is a
 * document, so classification walks it by MEMBER NAME instead, recursively. Without this the m2
 * gate change would be a leak: pseudonymization opens the agent path, and an unpseudonymized `get`
 * would then walk straight through it.
 *
 * Structural keys are never touched — replacing `Type`, `id` or `ticks` would corrupt the document
 * and break the round-trip invariants REQ-031 depends on. Note that means an entity's own `id`
 * survives: turning identity into an opaque handle is REQ-058 (#52), not this.
 */
const STRUCTURAL_KEYS = new Set(["type", "entitytype", "modeltype", "id", "ticks", "rowid", "ismodified", "modified"]);

export function pseudonymizeDocument(
  value: unknown,
  policy: PrivacyPolicy,
): { value: unknown; pseudonymized: string[]; handles: Readonly<Record<string, string>> } {
  if (policy.mode === "off") return { value, pseudonymized: [], handles: {} };

  const recorder = createRecorder();
  const seen: string[] = [];

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, path));
    if (node === null || typeof node !== "object") return node;

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(node as Record<string, unknown>)) {
      if (STRUCTURAL_KEYS.has(key.toLowerCase())) {
        out[key] = v;
        continue;
      }
      // The value is passed in, which is what fixes the leak: a nested Lite is an identity even
      // though `Customer` matches no name heuristic. Previously this path saw the NAME only, so
      // `get` emitted real entity types, real ids and real labels under the default policy — and
      // reported that it had pseudonymized nothing.
      const decision = sensitivity({ name: key, value: v }, policy);
      if (decision.pseudonymize) {
        // A sensitive value is replaced WHOLE, object or not. Recursing into something already
        // judged sensitive would emit its parts while claiming the whole was protected.
        out[key] = surrogate(v, key, policy, recorder);
        seen.push(key);
      } else {
        out[key] = walk(v, path === "" ? key : `${path}.${key}`);
      }
    }
    return out;
  };

  const result = walk(value, "");
  return { value: result, pseudonymized: [...new Set(seen)], handles: recorder.entries() };
}
