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
import {
  findType, loadMetadata, queryableTypes, suggestTypes, type Metadata, type TypeInfo,
} from "../core/metadata.ts";
import { resolveTarget } from "./context.ts";
import { fetchSubTokens, validateTokens } from "../core/tokens.ts";

async function metadata(ctx: Ctx): Promise<Metadata> {
  const target = resolveTarget(ctx);
  return await loadMetadata({
    url: target.url,
    http: target.http,
    offline: ctx.args.flags.offline, // AC-24.4
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
  // Same definition `signum query` validates against — see metadata.ts `queryableTypes`.
  const rows = queryableTypes(md)
    .filter((t) => wanted === undefined || t.name.toLowerCase().includes(wanted));

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(rows.map((t) => ({ queryKey: t.name, niceName: t.niceName ?? null })),
      { format: ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }

  if (rows.length === 0) {
    ctx.io.err("no queries reported by this application's metadata\n");
    // `queryDefined` is role-dependent (AuthServer.cs:143-157) and an anonymous caller may run
    // no query at all, so "none" most often means "not logged in", not "none exist".
    ctx.io.err("note: queries you may run depend on who you are — try `signum auth login`, or `signum types`\n");
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

async function explain(ctx: Ctx, md: Metadata, subject: string | undefined): Promise<ExitCode> {
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

  // A token path beyond the first segment is resolved LIVE, against the application's own query
  // description (REQ-012, AC-24.2). Two consequences worth stating where a reader will see them:
  // this needs a credential (QueryController is not [SignumAllowAnonymous], unlike the reflection
  // endpoint every other discovery command uses), and it cannot come from cache, so --offline
  // cannot serve it.
  const tokenPath = segments.slice(1).join(".");
  return await explainToken(ctx, root.name, tokenPath);
}

/**
 * `signum explain <QueryKey>.<token path>` — validate the path, then list what may follow it.
 *
 * The query key is the FIRST segment and the token is the rest: `explain Order.Entity.Customer`
 * asks about the token `Entity.Customer` on query `Order`, which is how Signum itself reads a
 * dotted token (relative to the query, not to a type).
 */
async function explainToken(ctx: Ctx, queryKey: string, tokenPath: string): Promise<ExitCode> {
  if (ctx.args.flags.offline) {
    // Say why, rather than silently degrading to the root type as this used to.
    throw new UsageError(`--offline cannot walk the token path '${queryKey}.${tokenPath}'`, {
      hint:
        "Token discovery is a live call (api/query/subTokens); only the reflection document is\n" +
        `cached. Drop --offline, or run \`signum explain ${queryKey}\` for the cached type.`,
    });
  }

  const target = resolveTarget(ctx, { requireAuth: true });

  // Validate first, so a typo is reported as a typo — with the valid continuations at the point
  // it broke — rather than as an empty continuation list that looks like a leaf.
  const [resolved] = await validateTokens(target.http, queryKey, [tokenPath]);
  const children = await fetchSubTokens(target.http, queryKey, tokenPath);

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(
      {
        kind: "token",
        queryKey,
        token: resolved?.fullKey ?? tokenPath,
        niceName: resolved?.niceName ?? null,
        type: resolved?.type ?? null,
        tokenKind: resolved?.kind ?? null,
        filterType: resolved?.filterType ?? null,
        isGroupable: resolved?.isGroupable ?? false,
        usableInQuery: resolved?.usableInQuery ?? true,
        subTokens: children.map((c) => ({
          key: c.key,
          fullKey: c.fullKey,
          niceName: c.niceName ?? null,
          type: c.type ?? null,
          tokenKind: c.kind ?? null,
          usableInQuery: c.usableInQuery,
        })),
      },
      { format: ctx.format, write: ctx.io.out },
    );
    return ExitCode.Ok;
  }

  const full = resolved?.fullKey ?? tokenPath;
  ctx.io.out(`${queryKey}.${full}${resolved?.type !== undefined ? `  (${resolved.type})` : ""}\n`);
  if (resolved?.niceName !== undefined) ctx.io.out(`  ${resolved.niceName}\n`);
  if (resolved !== undefined && !resolved.usableInQuery) {
    ctx.io.out(`  NOT USABLE in a query — see the note below.\n`);
  }

  if (children.length === 0) {
    ctx.io.out("\nNo further tokens — this is a leaf.\n");
  } else {
    ctx.io.out("\nCONTINUATIONS\n");
    const w = Math.max(...children.map((c) => c.key.length));
    for (const c of children) {
      const bits = [c.type ?? "", c.kind ?? ""].filter((b) => b !== "").join(", ");
      const warn = c.usableInQuery ? "" : "   [not usable in a query]";
      ctx.io.out(`  ${c.key.padEnd(w)}  ${bits}${warn}\n`);
    }
  }

  // AC-24.7. subTokens resolves with SubTokensOptions.All, which includes CanNested, but filter
  // parsing never passes it (FilterJsonConverter.cs:87,133) — so the server offers a token it
  // will then reject. Marking it is the whole point; discovering it at query time is too late.
  if (children.some((c) => !c.usableInQuery) || resolved?.usableInQuery === false) {
    ctx.io.err(
      "\nnote: '.Nested' tokens are offered by token discovery but rejected by executeQuery —\n" +
      "the server resolves them with SubTokensOptions.All while filters never allow CanNested.\n",
    );
  }

  ctx.io.out(`\nNext: signum explain ${queryKey}.${full}.<token>   ·   signum query ${queryKey} --column ${full}\n`);
  return ExitCode.Ok;
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
    case "explain":    return await explain(ctx, md, arg);
  }
}

/** Exposed for the dispatch-invariant test. */
export const BUILT_IN_NAMES = BUILT_INS;
