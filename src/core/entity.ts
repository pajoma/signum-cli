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
 * So the shape is: parse losslessly, change values only through `setMember`, and send only what
 * `serializeEntity` produced. `EntityPayload` can be minted nowhere else, which makes the
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
