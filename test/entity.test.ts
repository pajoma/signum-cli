/**
 * Entity serialization fidelity and `modified` propagation.
 *
 * REQ-031 · REQ-032 · STORY-31, STORY-32 · #111
 *
 * The fixture follows `EntityJsonConverter.cs:249-355` (write order), `MListJsonConverter.cs:67-86`
 * and `LiteJsonConverter.cs:23-68`, compact rather than indented so a byte comparison is meaningful.
 * Like integration.test.ts, it encodes what the framework SOURCE says; a live app wins where they
 * disagree (see entity.live.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  asEntity, fetchEntity, serializeEntity, setMember, validateEntity,
  type EntityJson, type EntityPayload, type LiteJson,
} from "../src/core/entity.ts";
import { parseLossless } from "../src/core/json.ts";
import { SignumHttp, type RequestSpec } from "../src/core/http.ts";
import { ValidationError } from "../src/core/errors.ts";

/**
 * An entity with every shape the round trip has to survive (AC-31.5): an embedded entity, an MList
 * whose element holds another embedded entity, a Lite with an int64 id past 2^53, a mixin, a
 * `decimal` with a trailing zero, DateOnly, DateTime, TimeSpan, an enum, and `byte[]`.
 */
const ORDER = JSON.stringify(JSON.parse(`{
  "Type": "Order", "id": 42, "ticks": "638500000000000017", "toStr": "Order 42", "modified": false,
  "state": "Shipped",
  "total": 0,
  "orderDate": "2024-01-31",
  "shippedAt": "2024-02-01T10:15:30.1234567Z",
  "handlingTime": "1.02:03:04.5000000",
  "signature": "AAECAwQ=",
  "address": { "Type": "Address", "toStr": "1 Main St", "modified": false, "street": "1 Main St" },
  "lines": [
    { "rowId": 7, "element": { "Type": "OrderLine", "toStr": "2 x Widget", "modified": false, "quantity": 2,
      "details": { "Type": "LineDetails", "toStr": "", "modified": false, "note": "fragile" } } },
    { "rowId": 8, "element": { "Type": "OrderLine", "toStr": "1 x Gadget", "modified": false, "quantity": 1,
      "details": { "Type": "LineDetails", "toStr": "", "modified": false, "note": "" } } }
  ],
  "customer": { "EntityType": "Customer", "id": 0, "model": "Alice" },
  "mixins": { "OrderAuditMixin": { "Type": "OrderAuditMixin", "modified": false, "reviewed": true } }
}`))
  // JSON.parse cannot hold these exactly — which is the point. Splice them in as source text.
  .replace(`"total":0`, `"total":1234567890.10`)
  .replace(`"id":0,"model"`, `"id":9007199254740993,"model"`);

const fresh = (): EntityJson => asEntity(parseLossless(ORDER));

describe("round trip without corruption (STORY-31)", () => {
  it("an unedited entity serializes byte-identical to what the server sent (AC-31.6)", () => {
    const payload = serializeEntity(fresh());
    expect(payload.json).toBe(ORDER);
    expect(payload.modified).toBe(false);
  });

  it("keeps decimals and int64 ids as their exact source text", () => {
    const json = serializeEntity(fresh()).json;
    expect(json).toContain(`"total":1234567890.10`);
    expect(json).toContain(`"id":9007199254740993`);
    // The trap this guards against, shown rather than asserted in prose:
    expect(JSON.stringify(JSON.parse(ORDER))).toContain(`"id":9007199254740992`);
  });

  it("ticks stays a string end to end (AC-31.2)", () => {
    const e = fresh();
    expect(typeof e.ticks).toBe("string");
    expect(serializeEntity(e).json).toContain(`"ticks":"638500000000000017"`);
  });

  it("refuses to send ticks that became a number", () => {
    const e = fresh() as Record<string, unknown>;
    e["ticks"] = 638500000000000017;
    expect(() => serializeEntity(e as EntityJson)).toThrow(/ticks must be a string/);
  });

  it("refuses a response whose ticks is a number, rather than losing precision silently", () => {
    expect(() => asEntity(parseLossless(`{"Type":"Order","id":1,"ticks":5,"modified":false}`))).toThrow(/ticks/);
  });

  it("says a broken response came from the server, not that a send was refused (#150)", () => {
    const read = (): unknown => asEntity(parseLossless(`{"Type":"Order","id":1,"ticks":5}`));
    expect(read).toThrow(/^unexpected entity JSON in the response — root\.ticks must be a string$/);
    const e = fresh() as Record<string, unknown>;
    e["ticks"] = 5;
    expect(() => serializeEntity(e as EntityJson)).toThrow(/^internal: refusing to send malformed entity JSON/);
  });

  it("refuses an object carrying both Type and EntityType (AC-31.1)", () => {
    expect(() => asEntity({ Type: "Order", EntityType: "Order", id: null })).toThrow(/both Type and EntityType/);
  });

  it("Type and EntityType cannot be interchanged without a type error (AC-31.1)", () => {
    // @ts-expect-error — a Lite has no `Type`
    const lite: LiteJson = { EntityType: "Customer", Type: "Customer", id: null };
    // @ts-expect-error — an entity has no `EntityType`
    const entity: EntityJson = { Type: "Order", EntityType: "Order" };
    expect([lite, entity]).toHaveLength(2);
  });

  it("reads a special member the server writes after the data members (#150)", () => {
    const e = asEntity({ Type: "Order", id: 1, name: "x", temporalId: "00000000-0000-0000-0000-000000000000" });
    expect(e["name"]).toBe("x");
  });

  it("sends special members before the data members, at every level (AC-31.4, #150)", () => {
    const e = asEntity(parseLossless(
      `{"Type":"Order","id":1,"ticks":"5","name":"x","temporalId":"00000000-0000-0000-0000-000000000000",` +
      `"address":{"Type":"AddressEmbedded","street":"y","modified":false}}`,
    ));
    expect(serializeEntity(e).json).toBe(
      `{"Type":"Order","id":1,"ticks":"5","temporalId":"00000000-0000-0000-0000-000000000000","name":"x",` +
      `"address":{"Type":"AddressEmbedded","modified":false,"street":"y"}}`,
    );
  });

  it("an MList row keeps rowId first and element second", () => {
    const rows = serializeEntity(fresh()).json.match(/\{"rowId":\d+,"element":/g);
    expect(rows).toHaveLength(2);
  });
});

describe("edits", () => {
  it("never adds a member the server does not know (AC-31.4)", () => {
    expect(() => setMember(fresh(), ["nmae"], "x")).toThrow(/has no member 'nmae'/);
  });

  it("refuses to edit what the server maintains", () => {
    for (const key of ["ticks", "id", "Type", "modified", "toStr", "mixins"]) {
      expect(() => setMember(fresh(), [key], "x")).toThrow(/maintained by the server/);
    }
  });

  it("reports an assignment of the same value as no change, and sends nothing as modified (AC-32.4)", () => {
    const e = fresh();
    expect(setMember(e, ["state"], "Shipped")).toBe(false);
    expect(serializeEntity(e).modified).toBe(false);
  });

  it("changes exactly one value and nothing else", () => {
    const e = fresh();
    setMember(e, ["state"], "Cancelled");
    const json = serializeEntity(e).json;
    expect(json).toBe(ORDER.replace(`"modified":false,"state":"Shipped"`, `"modified":true,"state":"Cancelled"`));
  });
});

describe("edits actually save (STORY-32)", () => {
  const modifiedFlags = (json: string) => {
    const o = JSON.parse(json);
    return {
      root: o.modified,
      address: o.address.modified,
      line0: o.lines[0].element.modified,
      line0Details: o.lines[0].element.details.modified,
      line1: o.lines[1].element.modified,
      mixin: o.mixins.OrderAuditMixin.modified,
    };
  };

  it("a change deep inside an MList row marks every ancestor, asserted on the payload (AC-32.1, AC-32.3)", () => {
    const e = fresh();
    expect(setMember(e, ["lines", 0, "details", "note"], "handle with care")).toBe(true);
    const payload = serializeEntity(e);
    expect(payload.modified).toBe(true);
    expect(modifiedFlags(payload.json)).toEqual({
      root: true, address: false, line0: true, line0Details: true, line1: false, mixin: false,
    });
  });

  it("rows and Lites never get a flag of their own — the server rejects unknown members", () => {
    const e = fresh();
    setMember(e, ["lines", 1, "quantity"], 3);
    const o = JSON.parse(serializeEntity(e).json);
    expect(Object.keys(o.lines[1])).toEqual(["rowId", "element"]);
    expect(Object.keys(o.customer)).toEqual(["EntityType", "id", "model"]);
  });

  it("a change inside a mixin marks the mixin and the entity", () => {
    const e = fresh();
    // Reached through `mixins`, which is itself not editable as a whole.
    setMember(e, ["mixins", "OrderAuditMixin", "reviewed"], false);
    expect(modifiedFlags(serializeEntity(e).json)).toMatchObject({ root: true, mixin: true });
  });

  it("a change inside a Lite's loaded entity marks the entity holding the Lite", () => {
    const e = asEntity(parseLossless(
      `{"Type":"Order","id":1,"ticks":"1","modified":false,` +
      `"customer":{"EntityType":"Customer","id":3,"entity":{"Type":"Customer","id":3,"ticks":"2","modified":false,"name":"Al"}}}`,
    ));
    setMember(e, ["customer", "entity", "name"], "Alice");
    const o = JSON.parse(serializeEntity(e).json);
    expect([o.modified, o.customer.entity.modified, "modified" in o.customer]).toEqual([true, true, false]);
  });

  it("a reordered MList keeps every rowId, so no row is recreated (AC-31.3)", () => {
    const e = fresh();
    const lines = e["lines"] as unknown[];
    setMember(e, ["lines"], [lines[1], lines[0]]);
    const o = JSON.parse(serializeEntity(e).json);
    expect(o.lines.map((r: { rowId: number }) => r.rowId)).toEqual([8, 7]);
    expect(o.modified).toBe(true);
  });

  it("a new MList row (rowId null) marks the holder even when nothing else changed", () => {
    const e = fresh();
    (e["lines"] as unknown[]).push({ rowId: null, element: { Type: "OrderLine", modified: true, quantity: 1 } });
    expect(serializeEntity(e).modified).toBe(true);
  });

  it("a new entity is always sent as modified", () => {
    const e = asEntity({ Type: "Order", isNew: true, name: "x" });
    expect(JSON.parse(serializeEntity(e).json).modified).toBe(true);
  });
});

describe("the payload is the only way out (AC-32.2)", () => {
  it("serializing twice — a preview, then the send — produces the same payload", () => {
    const e = fresh();
    setMember(e, ["lines", 0, "details", "note"], "x");
    expect(serializeEntity(e).json).toBe(serializeEntity(e).json);
  });

  it("a hand-built payload is refused at runtime, so propagation cannot be skipped by a cast", async () => {
    const forged = { json: ORDER, modified: true } as unknown as EntityPayload;
    const http = new SignumHttp({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
    await expect(validateEntity(http, forged)).rejects.toThrow(/not produced by serializeEntity/);
  });

  it("nothing in src/ outside entity.ts casts its way to an EntityPayload", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
      if (path === "src/core/entity.ts") continue;
      if (/as\s+(unknown\s+as\s+)?EntityPayload\b/.test(await Bun.file(path).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe("against a server (mock): fetch, then validateEntity", () => {
  let server: ReturnType<typeof Bun.serve>;
  let received: string | undefined;
  /** The 400 body to answer with, or undefined to accept. */
  let rejection: unknown;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/entity/Order/42") {
          return new Response(ORDER, { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/api/validateEntity" && req.method === "POST") {
          received = await req.text();
          if (rejection === undefined) return new Response(null, { status: 200 });
          return Response.json(rejection, { status: 400 });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  const http = () => new SignumHttp({ baseUrl: `http://127.0.0.1:${server.port}`, token: "test-token" });

  const rejectedWith = async (body: unknown): Promise<unknown> => {
    rejection = body;
    const e = await fetchEntity(http(), "Order", "42");
    setMember(e, ["state"], "");
    return validateEntity(http(), serializeEntity(e)).catch((x: unknown) => x);
  };

  it("a request cannot carry both a body and a raw body — one would silently win", () => {
    // @ts-expect-error — body and rawBody are mutually exclusive
    const spec: RequestSpec = { method: "POST", path: "api/validateEntity", body: {}, rawBody: "{}" };
    expect(spec.path).toBe("api/validateEntity");
  });

  it("posts the fetched entity back byte-identical", async () => {
    rejection = undefined;
    const e = await fetchEntity(http(), "Order", "42");
    await validateEntity(http(), serializeEntity(e));
    expect(received).toBe(ORDER);
  });

  it("reports a bare ModelState's per-field messages unreworded (validateEntity)", async () => {
    // `BadRequestObjectResult(ModelState)` — keys are root-prefixed property routes.
    const err = await rejectedWith({ "entity.state": ["State is not set"] });
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain("entity.state: State is not set");
  });

  it("reports ValidationProblemDetails' per-field messages too (the operation endpoints' shape)", async () => {
    // `OperationController.cs:56-72` wraps the same map in `errors`, beside a generic title.
    const err = await rejectedWith({ title: "Validation error", status: 400, errors: { "entity.state": ["State is not set"] } });
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain("entity.state: State is not set");
  });
});
