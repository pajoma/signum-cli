/**
 * Entity JSON: lossless reading, targeted edits, and the one serializer every write goes through.
 *
 * REQ-031 · REQ-032 · STORY-31, STORY-32 · docs/http-api.md §4
 *
 * The server reads entity JSON with `EntityJsonConverter` in its WebAPI strategy, which is strict in
 * ways that fail loudly AND in one way that fails silently:
 *   • loud — `Type` on entities, `EntityType` on Lites, never both (`EntityJsonConverter.cs:764`,
 *     `LiteJsonConverter.cs:136`); `ticks` parsed with `long.Parse(GetString())` (`:761`); an unknown
 *     member throws (`:458`); `rowId` then `element`, in that order, per MList row
 *     (`MListJsonConverter.cs:114-125`).
 *   • silent — a changed member on an entity whose own `modified` is not `true` is DISCARDED, with
 *     an exception created and swallowed on the spot (`EntityJsonConverter.cs:537-549`). The save
 *     reports success. Every ancestor on the path to a change needs the flag, because each nested
 *     entity is judged by its own.
 *
 * So the shape is: parse losslessly, change values only through `setMember` (one edit) or
 * `applyDocument` (an edited document, #120), and send only what `serializeEntity` produced. `EntityPayload` can be minted nowhere else, which makes the
 * propagation impossible to forget (AC-32.2) — the same structural argument as `DataWriter`.
 */

import { CliError, ExitCode, NotFoundError, UsageError } from "./errors.ts";
import type { SignumHttp } from "./http.ts";
import { JsonNumber } from "./json.ts";

/** Numeric primary keys arrive as `identifier` JsonNumbers, GUID and string keys as strings. */
export type PrimaryKey = JsonNumber | string;

/**
 * Any `ModifiableEntity`: a root entity, an embedded entity, a model or a mixin.
 *
 * `EntityType?: never` is what makes the Lite/entity mix-up a compile error rather than a 500.
 */
export interface EntityJson {
  readonly Type: string;
  readonly EntityType?: never;
  id?: PrimaryKey | null;
  isNew?: boolean;
  ticks?: string;
  toStr?: string;
  modified?: boolean;
  [member: string]: unknown;
}

/** `Lite<T>`. It has no `modified` of its own; a loaded `entity` carries one (`LiteJsonConverter.cs:23-68`). */
export interface LiteJson {
  readonly EntityType: string;
  readonly Type?: never;
  id: PrimaryKey | null;
  model?: unknown;
  entity?: EntityJson;
  [member: string]: unknown;
}

/** One `MList<T>` row. A null `rowId` is a new row; an existing one must survive or the row is recreated. */
export interface MListRow {
  rowId: PrimaryKey | null;
  element: unknown;
}

/** The members the server consumes before the data members, in any order (`EntityJsonConverter.cs:741-764`). */
const SPECIAL = new Set(["Type", "id", "isNew", "partitionId", "ticks", "toStr", "modified", "temporalId"]);

/** Written by the server, read and discarded by it (`:305-331`, `:444-449`) — never edited. */
const READ_ONLY = new Set([...SPECIAL, "propsMeta", "mixins"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNumber);
}

function isEntity(v: unknown): v is EntityJson {
  return isObject(v) && typeof v["Type"] === "string";
}

function isLite(v: unknown): v is LiteJson {
  return isObject(v) && typeof v["EntityType"] === "string";
}

function isMListRow(v: unknown): v is MListRow {
  return isObject(v) && Object.hasOwn(v, "rowId") && Object.hasOwn(v, "element");
}

function isMList(v: unknown): v is MListRow[] {
  return Array.isArray(v) && v.length > 0 && v.every(isMListRow);
}

/** A `CliError` for a payload this CLI would otherwise send malformed. Never the user's fault. */
function malformed(message: string): CliError {
  return new CliError(`internal: refusing to send malformed entity JSON — ${message}`, ExitCode.Unexpected);
}

/** A `CliError` for a response that breaks an invariant. The server sent it; nothing was sent (#150). */
function unexpected(message: string): CliError {
  return new CliError(`unexpected entity JSON in the response — ${message}`, ExitCode.Unexpected);
}

/**
 * Check the invariants the server enforces, over the whole graph, before anything is sent or edited.
 * Each one either throws server-side with a message nobody can act on, or corrupts data. They hold in
 * both directions; `fail` only words the error, so a response is never reported as a refused send.
 */
function assertWellFormed(v: unknown, path: string, fail: (message: string) => CliError): void {
  if (Array.isArray(v)) {
    v.forEach((item, i) => assertWellFormed(item, `${path}[${i}]`, fail));
    return;
  }
  if (!isObject(v)) return;

  const hasType = Object.hasOwn(v, "Type");
  const hasEntityType = Object.hasOwn(v, "EntityType");
  if (hasType && hasEntityType) throw fail(`${path || "root"} carries both Type and EntityType`);

  // AC-31.2: a numeric ticks throws in `long.Parse(reader.GetString())`; worse, a JS number would
  // already have lost precision, turning every write into a false concurrency conflict.
  if (hasType && Object.hasOwn(v, "ticks") && typeof v["ticks"] !== "string") {
    throw fail(`${path || "root"}.ticks must be a string`);
  }

  if (isMListRow(v)) {
    const keys = Object.keys(v);
    if (keys[0] !== "rowId" || keys[1] !== "element") throw fail(`${path} must be {rowId, element}, in that order`);
  }

  for (const [key, child] of Object.entries(v)) {
    assertWellFormed(child, path === "" ? key : `${path}.${key}`, fail);
  }
}

/**
 * Move every entity's special members ahead of its data members, keeping the order within each group.
 * This is what makes AC-31.4 hold on send — a special member after a data member throws
 * (`EntityJsonConverter.cs:455-456`). It binds sends only: a fetched entity can carry `temporalId`
 * last (#150), and sent back unchanged it would throw.
 */
function hoistSpecialMembers(v: unknown): void {
  if (Array.isArray(v)) {
    v.forEach(hoistSpecialMembers);
    return;
  }
  if (!isObject(v)) return;
  if (Object.hasOwn(v, "Type")) {
    const entries = Object.entries(v);
    for (const [key] of entries) delete v[key];
    for (const [key, value] of entries) if (SPECIAL.has(key)) v[key] = value;
    for (const [key, value] of entries) if (!SPECIAL.has(key)) v[key] = value;
  }
  Object.values(v).forEach(hoistSpecialMembers);
}

/** Validate a response body as an entity. The response is the only source of one. */
export function asEntity(body: unknown): EntityJson {
  if (!isEntity(body)) {
    throw new CliError("expected an entity in the response, got something else", ExitCode.Unexpected);
  }
  assertWellFormed(body, "", unexpected);
  return body;
}

export type MemberPath = readonly (string | number)[];

/**
 * Change one value in an entity graph, the way the web UI does (`Reflection.ts:911-923`): assign it
 * and mark the object that holds it as `modified`. Ancestors are marked by `serializeEntity`.
 *
 * Path segments are member names, `entity` to step into a loaded Lite, and indices into lists — an
 * index into an MList addresses the row's element, since rows are wire framing, not data.
 *
 * Returns whether anything changed, so a caller can report a no-op as one (AC-32.4).
 */
export function setMember(root: EntityJson, path: MemberPath, value: unknown): boolean {
  if (path.length === 0) throw new UsageError("an edit needs a member path");

  /** The ModifiableEntity nodes on the way down; the last one owns the assigned value. */
  const owners: EntityJson[] = [root];
  let node: unknown = root;
  const describe = (upTo: number) => path.slice(0, upTo).join(".") || "the entity";

  for (let i = 0; i < path.length - 1; i++) {
    node = step(node, path[i] as string | number, describe(i));
    if (isEntity(node)) owners.push(node);
  }

  const last = path[path.length - 1] as string | number;
  const where = describe(path.length - 1);
  let holder: object;
  let key: string | number;

  if (isMList(node) && typeof last === "number") {
    holder = rowAt(node, last, where);
    key = "element";
  } else if (Array.isArray(node) && typeof last === "number") {
    if (last < 0 || last >= node.length) throw new UsageError(`${where} has no element ${last}`);
    holder = node;
    key = last;
  } else if (isObject(node) && typeof last === "string") {
    if (READ_ONLY.has(last)) throw new UsageError(`'${last}' is maintained by the server and cannot be edited`);
    // AC-31.4: the server throws on an unknown member, so adding one is never right.
    if (!Object.hasOwn(node, last)) throw new UsageError(`${where} has no member '${last}'`);
    holder = node;
    key = last;
  } else {
    throw new UsageError(`cannot address '${String(last)}' in ${where}`);
  }

  const old = (holder as Record<string | number, unknown>)[key];
  if (JSON.stringify(old) === JSON.stringify(value)) return false;
  (holder as Record<string | number, unknown>)[key] = value;
  (owners[owners.length - 1] as EntityJson).modified = true;
  return true;
}

function rowAt(list: MListRow[], index: number, where: string): MListRow {
  const row = list[index];
  if (row === undefined) throw new UsageError(`${where} has no row ${index}`);
  return row;
}

function step(node: unknown, segment: string | number, where: string): unknown {
  if (isMList(node) && typeof segment === "number") return rowAt(node, segment, where).element;
  if (Array.isArray(node) && typeof segment === "number") {
    if (segment < 0 || segment >= node.length) throw new UsageError(`${where} has no element ${segment}`);
    return node[segment];
  }
  if (isObject(node) && typeof segment === "string") {
    if (isLite(node) && segment === "entity" && node.entity === undefined) {
      throw new UsageError(`${where} is a reference whose entity is not loaded`);
    }
    if (!Object.hasOwn(node, segment)) throw new UsageError(`${where} has no member '${segment}'`);
    return node[segment];
  }
  throw new UsageError(`cannot address '${String(segment)}' in ${where}`);
}

/** Equal as JSON, whatever the key order: a document edited by hand need not keep it. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (!isObject(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The same record referenced: a Lite's identity is its type and id, not its display string. */
function sameValue(next: unknown, current: unknown): boolean {
  if (isLite(next) && isLite(current)) {
    return next.EntityType === current.EntityType && String(next.id) === String(current.id);
  }
  return sameJson(next, current);
}

/**
 * Turns a value from the caller's document into what goes on the wire: a handle into the Lite it
 * stands for, and so on. `current` is the record's real value at that place, when there is one.
 */
export type DocumentValue = (value: unknown, path: string, current: unknown) => unknown;

/**
 * Apply a document the caller edited to the record as it really is now (#120), and return the paths
 * that changed. A file carries no `modified` flags, and the server drops every change on an entity
 * not marked (`EntityJsonConverter.cs:537-549`), so the change has to be FOUND, then marked.
 *
 * It is a three-way comparison, because what the caller edited is usually not the record: `get`
 * pseudonymizes, so their document carries handles and surrogates for everything they left alone.
 *   - `edited` equal to `shown` (the record as it would be shown now) — left alone; the real value
 *     stays, whatever surrogate the document holds.
 *   - otherwise translated by `value`, and if that equals the real value, left alone too (a document
 *     read with pseudonymization off, edited with it on).
 *   - otherwise it is a change: assigned onto the real record, and its owner marked.
 * Embedded and loaded entities are compared member by member, MList rows by `rowId`: a row kept is
 * updated in place, a row without one is new, a row left out is removed (AC-31.3). A member the
 * document does not mention is left as it is; one the record does not have is refused (AC-31.4).
 * `real` is changed in place; serialize it with `serializeEntity`, which marks the ancestors.
 */
export function applyDocument(real: EntityJson, shown: unknown, edited: unknown, value: DocumentValue): string[] {
  const changed: string[] = [];
  mergeEntity(real, shown, edited, "", changed, value);
  return changed;
}

function mergeEntity(real: EntityJson, shown: unknown, edited: unknown, path: string, changed: string[], value: DocumentValue): void {
  const where = path === "" ? "the record" : path;
  if (!isObject(edited)) throw new UsageError(`${where} should be an object in the document`);
  const seen = isObject(shown) ? shown : {};
  for (const [key, ed] of Object.entries(edited)) {
    if (READ_ONLY.has(key)) continue;
    const p = path === "" ? key : `${path}.${key}`;
    // AC-31.4: the server throws on an unknown member, so adding one is never right.
    if (!Object.hasOwn(real, key)) throw new UsageError(`${where} has no member '${key}'`);
    const current = real[key];
    if (sameJson(ed, seen[key])) continue;
    if (isEntity(current) && isEntity(ed) && ed.Type === current.Type && sameRecord(current, ed, seen[key])) {
      mergeEntity(current, seen[key], ed, p, changed, value);
      continue;
    }
    if (isMList(current) || (Array.isArray(current) && Array.isArray(ed) && ed.length > 0 && ed.every(isMListRow))) {
      mergeRows(real, key, current as MListRow[], seen[key], ed, p, changed, value);
      continue;
    }
    const next = value(ed, p, current);
    if (sameValue(next, current)) continue;
    real[key] = next;
    real.modified = true;
    changed.push(p);
  }
}

/** An embedded entity has no id and is always the same one; a referenced one must keep its id. */
function sameRecord(current: EntityJson, edited: EntityJson, shown: unknown): boolean {
  if (current.id === undefined || current.id === null) return true;
  const shownId = isObject(shown) ? shown["id"] : undefined;
  return sameJson(edited.id, current.id) || sameJson(edited.id, shownId);
}

function mergeRows(
  owner: EntityJson, key: string, rows: MListRow[], shown: unknown, edited: unknown,
  path: string, changed: string[], value: DocumentValue,
): void {
  if (!Array.isArray(edited) || !edited.every(isMListRow)) {
    throw new UsageError(`${path}: each row needs its rowId and element, as \`signum get\` shows them`, {
      hint: 'A new row is {"rowId": null, "element": …}.',
    });
  }
  const byId = new Map(rows.map((r) => [String(r.rowId), r]));
  const shownById = new Map((Array.isArray(shown) ? shown : []).filter(isMListRow).map((r) => [String(r.rowId), r]));
  const out: MListRow[] = [];
  edited.forEach((row, i) => {
    const p = `${path}.${i}`;
    if (row.rowId === null) {
      out.push({ rowId: null, element: markAllModified(value(row.element, p, undefined)) });
      return;
    }
    const kept = byId.get(String(row.rowId));
    if (kept === undefined) throw new UsageError(`${path} has no row with rowId ${String(row.rowId)}`, { hint: "A new row has rowId null." });
    const was = shownById.get(String(row.rowId))?.element;
    if (!sameJson(row.element, was)) {
      if (isEntity(kept.element) && isEntity(row.element) && row.element.Type === kept.element.Type) {
        mergeEntity(kept.element, was, row.element, p, changed, value);
      } else {
        const next = value(row.element, p, kept.element);
        if (!sameValue(next, kept.element)) {
          kept.element = next;
          owner.modified = true;
          changed.push(p);
        }
      }
    }
    out.push(kept);
  });
  const sameRows = out.length === rows.length && out.every((r, i) => r === rows[i]);
  if (!sameRows) {
    owner[key] = out;
    owner.modified = true;
    changed.push(`${path} (rows)`);
  }
}

/**
 * Mark every entity in a graph that is new to the record — a new row's element, a whole new
 * record — so none of its members is dropped. `propagateModified` marks only ancestors of a change,
 * and a new embedded entity has no change below it to report: every member is new.
 */
export function markAllModified<T>(v: T): T {
  if (Array.isArray(v)) v.forEach(markAllModified);
  // A Lite is a reference: the record behind it is not being created, and is never marked.
  else if (isObject(v) && !isLite(v)) {
    if (isEntity(v)) v.modified = true;
    for (const [k, child] of Object.entries(v)) if (!SPECIAL.has(k)) markAllModified(child);
  }
  return v;
}

/**
 * Mark every ModifiableEntity that contains a change, bottom-up — a port of the web client's
 * `GraphExplorer.isModified` in "clean" mode (`Reflection.ts:2541-2708`), which `ajaxPostRaw` runs on
 * every POST. Rows and Lites carry no flag of their own; they only report upwards. A flag is only
 * ever raised, never cleared.
 */
function propagateModified(v: unknown): boolean {
  if (Array.isArray(v)) return v.map(propagateModified).some(Boolean);
  if (!isObject(v)) return false;

  if (isMListRow(v)) return propagateModified(v.element) || v.rowId === null;
  if (isLite(v)) return v.entity !== undefined && propagateModified(v.entity);

  if (!isEntity(v)) return Object.values(v).map(propagateModified).some(Boolean);

  // "clean" mode drops client-side validation errors before sending (`Reflection.ts:2668-2671`).
  delete v["error"];
  const childModified = Object.entries(v)
    .filter(([key]) => !SPECIAL.has(key))
    .map(([, child]) => propagateModified(child))
    .some(Boolean);
  if (childModified || v.isNew === true) v.modified = true;
  return v.modified === true;
}

/**
 * Pre-serialized entity JSON, mintable only by `serializeEntity`.
 *
 * Branded with a module-private symbol, like `DataWriter` (`policy.ts`): no other module can name
 * the key, so none can build one without a cast, and `validateEntity` checks the brand at runtime.
 */
const ENTITY_PAYLOAD: unique symbol = Symbol("signum.entityPayload");

export interface EntityPayload {
  readonly json: string;
  readonly modified: boolean;
  readonly [ENTITY_PAYLOAD]: true;
}

function assertEntityPayload(p: EntityPayload): void {
  if (p[ENTITY_PAYLOAD] !== true) throw malformed("payload was not produced by serializeEntity");
}

/**
 * The only way to produce entity JSON for the server: check the graph, propagate `modified`, write it.
 *
 * It CHANGES `root`: special members are moved ahead of the data members, `modified` is raised on
 * every ancestor of a change and client-side `error` members are dropped, as the web client does.
 * Flags are only ever raised and the move keeps each group's order, so serializing twice — a preview,
 * then the real send — produces the same payload.
 *
 * `modified` on the result says whether the payload asks the server to change anything — false means
 * the server will apply nothing, and a caller must not report that as a save (AC-32.4).
 */
export function serializeEntity(root: EntityJson): EntityPayload {
  hoistSpecialMembers(root);
  assertWellFormed(root, "", malformed);
  const modified = propagateModified(root);
  return { json: JSON.stringify(root), modified, [ENTITY_PAYLOAD]: true };
}

/** `api/entity/{type}/{id}`. `cleanName` is the server's name (`RoleEntity` → `Role`, AC-30.4). */
export function entityPath(cleanName: string, id: string): string {
  return `api/entity/${encodeURIComponent(cleanName)}/${encodeURIComponent(id)}`;
}

/**
 * `GET api/entity/{type}/{id}`, numbers kept exact, server invariants checked. Used both to edit
 * and send back, and to display (`signum get`) — a reader shown a rounded id is shown a record that
 * does not exist.
 */
export async function fetchEntity(http: SignumHttp, cleanName: string, id: string): Promise<EntityJson> {
  const res = await http.request<unknown>({ method: "GET", path: entityPath(cleanName, id), lossless: true });
  if (res.body === null || res.body === undefined || res.body === "") {
    throw new NotFoundError(`${cleanName} ${id} not found`);
  }
  return asEntity(res.body);
}

/**
 * `POST api/validateEntity` — a bare entity in, 200 with an empty body when valid, 400 with the
 * ModelState when not (`EntityController.cs:92-96`, `ValidateModelFilterAttribute.cs:8-26`).
 * Persists nothing, which is what lets the serializer be proven against a real server safely.
 * A rejection surfaces as `ValidationError` carrying the server's per-field messages.
 */
export async function validateEntity(http: SignumHttp, payload: EntityPayload): Promise<void> {
  assertEntityPayload(payload);
  await http.request({ method: "POST", path: "api/validateEntity", rawBody: payload.json });
}
