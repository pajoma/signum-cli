/**
 * The one way server data leaves a command (REQ-057, REQ-058, ADR 0007), in its required order:
 *
 *   1. the handles minted for it are stored — a handle printed but not kept is exactly the
 *      unresolvable handle AC-53.5 exists to prevent, and it would be ours;
 *   2. the gate is passed — `ctx.openData` refuses a detected AI caller what it may not see;
 *   3. it is rendered, through the `DataWriter` that only the gate mints;
 *   4. what was pseudonymized is disclosed, coverage caveats included (AC-52.6).
 *
 * Every command used to spell these four steps out itself, and a new data path had to remember all
 * of them in this order. The `DataWriter` brand enforces step 2; this enforces the rest.
 */

import type { Ctx } from "./ctx.ts";
import { persistHandles } from "./handles.ts";
import type { DataWriter } from "./policy.ts";
import { disclosure } from "./privacy.ts";

/** What pseudonymizing a result produced besides the result: handles to keep, members replaced. */
export interface Minted {
  handles: Readonly<Record<string, string | { lite: string; label?: string }>>;
  pseudonymized: readonly string[];
}

/** Emit one result whole. `kind` names the data in a refusal ("query results", "entity data"). */
export function emitData(ctx: Ctx, kind: string, minted: Minted, render: (out: DataWriter) => void): void {
  persistHandles(ctx, minted.handles);
  render(ctx.openData(kind));
  disclose(ctx, minted.pseudonymized);
}

/** A result written page by page (AC-23.3): each page's handles kept before it is written, one disclosure at the end. */
export interface DataStream<Page> {
  push(minted: Minted, page: Page): void;
  end(): void;
}

/** Open a stream through the gate; `open` turns the gated writer into the renderer's own stream. */
export function streamData<Page>(
  ctx: Ctx,
  kind: string,
  open: (out: DataWriter) => { push(page: Page): void; end(): void },
): DataStream<Page> {
  const rows = open(ctx.openData(kind));
  const pseudonymized = new Set<string>();
  return {
    push(minted, page) {
      persistHandles(ctx, minted.handles);
      rows.push(page);
      for (const p of minted.pseudonymized) pseudonymized.add(p);
    },
    end() {
      rows.end();
      disclose(ctx, [...pseudonymized]);
    },
  };
}

function disclose(ctx: Ctx, pseudonymized: readonly string[]): void {
  const note = disclosure(ctx.privacy, pseudonymized);
  if (note !== "") ctx.io.err("\n" + note);
}
