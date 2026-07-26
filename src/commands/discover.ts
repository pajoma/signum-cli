/**
 * `signum types | queries | operations | explain`
 *
 * STORY-24 (discovery), STORY-61 (help that knows the application),
 * STORY-63 (errors route to help).
 *
 * All read-only metadata, so none of it engages the STORY-51 data gate and none of it needs
 * credentials — api/reflection/types is anonymous.
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import { BUILT_INS, isBuiltIn } from "../core/args.ts";
import { findType, loadMetadata, suggestTypes, type Metadata, type TypeInfo } from "../core/metadata.ts";
import { resolveTarget } from "./context.ts";

async function metadata(ctx: Ctx): Promise<Metadata> {
  const target = resolveTarget(ctx);
  return await loadMetadata({
    url: target.url,
    http: target.http,
    env: ctx.io.env,
    warn: (line) => ctx.io.err(line),
  });
}

function noteOrigin(ctx: Ctx, md: Metadata): void {
  if (md.origin.stale) {
    ctx.io.err(`note: using cached metadata from ${md.origin.fetchedAt}\n`);
  }
}

function listTypes(ctx: Ctx, md: Metadata, pattern: string | undefined): ExitCode {
  const wanted = pattern?.toLowerCase();
  const rows = [...md.types.values()]
    .filter((t) => wanted === undefined || t.name.toLowerCase().includes(wanted))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(
      rows.map((t) => ({
        name: t.name, kind: t.kind ?? null, niceName: t.niceName ?? null,
        members: t.members.length, operations: t.operations.length, hasQuery: t.hasQuery,
      })),
      { format: ctx.format, write: ctx.io.out },
    );
    return ExitCode.Ok;
  }

  if (rows.length === 0) {
    ctx.io.err(pattern === undefined ? "no types\n" : `no types matching '${pattern}'\n`);
    return ExitCode.Ok;
  }

  const w = Math.max(...rows.map((t) => t.name.length));
  for (const t of rows) {
    const bits = [t.kind ?? "", `${t.members.length} members`];
    if (t.operations.length > 0) bits.push(`${t.operations.length} operations`);
    ctx.io.out(`${t.name.padEnd(w)}  ${bits.filter((b) => b !== "").join(", ")}\n`);
  }
  return ExitCode.Ok;
}

function listQueries(ctx: Ctx, md: Metadata, pattern: string | undefined): ExitCode {
  const wanted = pattern?.toLowerCase();
  const rows = [...md.types.values()]
    .filter((t) => t.hasQuery)
    .filter((t) => wanted === undefined || t.name.toLowerCase().includes(wanted))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(rows.map((t) => ({ queryKey: t.name, niceName: t.niceName ?? null })),
      { format: ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }

  if (rows.length === 0) {
    ctx.io.err("no queries reported by this application's metadata\n");
    ctx.io.err("note: the metadata field indicating a default query is unverified; try `signum types`\n");
    return ExitCode.Ok;
  }
  for (const t of rows) ctx.io.out(`${t.name}\n`);
  return ExitCode.Ok;
}

function listOperations(ctx: Ctx, md: Metadata, typeName: string | undefined): ExitCode {
  let types: TypeInfo[];
  if (typeName !== undefined) {
    const t = findType(md, typeName);
    if (t === undefined) throw unknownType(md, typeName);
    types = [t];
  } else {
    types = [...md.types.values()].filter((t) => t.operations.length > 0);
  }

  const rows = types.flatMap((t) =>
    t.operations.map((op) => ({
      type: t.name,
      key: op.key,
      verb: op.verb,
      command: `signum ${kebab(op.verb)} ${kebab(t.name)}`,
      // Built-ins always win dispatch, so a colliding verb is unreachable by the short form (AC-41.8).
      shadowed: isBuiltIn(op.verb.toLowerCase()),
      niceName: op.niceName ?? null,
    })),
  ).sort((a, b) => a.type.localeCompare(b.type) || a.verb.localeCompare(b.verb));

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(rows, { format: ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }

  if (rows.length === 0) {
    ctx.io.err("no operations found\n");
    return ExitCode.Ok;
  }

  const w = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    const note = r.shadowed
      ? `  SHADOWED by built-in '${r.verb.toLowerCase()}' — use the canonical key`
      : `  ${r.command}`;
    ctx.io.out(`${r.key.padEnd(w)}${note}\n`);
  }
  ctx.io.err("\nInvoking operations is m2; this milestone is read-only.\n");
  return ExitCode.Ok;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function unknownType(md: Metadata, name: string): NotFoundError {
  const near = suggestTypes(md, name);
  return new NotFoundError(`unknown type '${name}'`, {
    hint: near.length > 0
      ? `Did you mean: ${near.join(", ")}?\nRun \`signum types\` for the full list.`
      : "Run `signum types` to see what this application exposes.",
  });
}

function explain(ctx: Ctx, md: Metadata, subject: string | undefined): ExitCode {
  if (subject === undefined) {
    throw new UsageError("`explain` needs a type, token path, or operation key", {
      hint: "signum explain Order\nsignum explain Order.Entity.Customer\nsignum explain OrderOperation.Ship",
    });
  }

  // An operation key? Look for an exact match before treating dots as a token path.
  for (const t of md.types.values()) {
    const op = t.operations.find((o) => o.key.toLowerCase() === subject.toLowerCase());
    if (op !== undefined) {
      const shadowed = isBuiltIn(op.verb.toLowerCase());
      if (ctx.format === "json" || ctx.format === "ndjson") {
        renderDocument(
          { kind: "operation", key: op.key, verb: op.verb, type: t.name,
            command: `signum ${kebab(op.verb)} ${kebab(t.name)}`, shadowed, niceName: op.niceName ?? null,
            invocable: false, note: "invoking operations is m2" },
          { format: ctx.format, write: ctx.io.out },
        );
        return ExitCode.Ok;
      }
      ctx.io.out(`${op.key}  (operation on ${t.name})\n`);
      if (op.niceName !== undefined) ctx.io.out(`  ${op.niceName}\n`);
      ctx.io.out(`\n  invoke as:  signum ${kebab(op.verb)} ${kebab(t.name)}  (m2)\n`);
      if (shadowed) {
        ctx.io.out(`  NOTE: verb '${op.verb.toLowerCase()}' is shadowed by a built-in; use the canonical key.\n`);
      }
      return ExitCode.Ok;
    }
  }

  // Otherwise a type, optionally followed by a token path.
  const segments = subject.split(".");
  const root = findType(md, segments[0] as string);
  if (root === undefined) throw unknownType(md, segments[0] as string);

  if (segments.length === 1) {
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDocument(
        { kind: "type", name: root.name, entityKind: root.kind ?? null, niceName: root.niceName ?? null,
          hasQuery: root.hasQuery, members: root.members,
          operations: root.operations.map((o) => ({ key: o.key, verb: o.verb })) },
        { format: ctx.format, write: ctx.io.out },
      );
      return ExitCode.Ok;
    }
    ctx.io.out(`${root.name}${root.kind !== undefined ? `  (${root.kind})` : ""}\n`);
    if (root.niceName !== undefined) ctx.io.out(`  ${root.niceName}\n`);
    if (root.members.length > 0) {
      ctx.io.out("\nMEMBERS\n");
      const w = Math.max(...root.members.map((m) => m.name.length));
      for (const m of root.members) ctx.io.out(`  ${m.name.padEnd(w)}  ${m.type ?? ""}\n`);
    }
    if (root.operations.length > 0) {
      ctx.io.out("\nOPERATIONS\n");
      for (const o of root.operations) ctx.io.out(`  ${o.key}\n`);
    }
    ctx.io.out("\nNext: signum explain " + root.name + ".<member>   ·   signum query " + root.name + "\n");
    return ExitCode.Ok;
  }

  // Token paths beyond the first segment need live subTokens (REQ-012, m2).
  ctx.io.err(
    `note: walking a token path ('${subject}') needs api/query/subTokens, which is m2 (REQ-012).\n` +
    `Showing the root type instead.\n`,
  );
  return explain({ ...ctx, format: ctx.format }, md, root.name);
}

export async function runDiscover(
  ctx: Ctx,
  which: "types" | "queries" | "operations" | "explain",
): Promise<ExitCode> {
  const md = await metadata(ctx);
  noteOrigin(ctx, md);
  const arg = ctx.args.positionals[0];

  switch (which) {
    case "types":      return listTypes(ctx, md, arg);
    case "queries":    return listQueries(ctx, md, arg);
    case "operations": return listOperations(ctx, md, arg);
    case "explain":    return explain(ctx, md, arg);
  }
}

/** Exposed for the dispatch-invariant test. */
export const BUILT_IN_NAMES = BUILT_INS;
