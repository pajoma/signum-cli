/**
 * `signum de-pseudonymize <ref:…> [<ref:…> …]` · `--list` · `--clear`
 *
 * REQ-058 (#52) · STORY-53 · AC-53.4, AC-53.6.
 *
 * Resolves local `ref:` handles back to the records they stand for, so a **human** can audit what an
 * agent read or acted on.
 *
 * This is the one command whose entire output is real identity data, so it is the one place that
 * needs a check of its own rather than leaning on the shared gate. Since REQ-057 landed, a detected
 * agent passes `openData` whenever pseudonymization is active — which is right for pseudonymized
 * rows and exactly wrong here, because resolving a handle is the act of *removing* the protection.
 * So it refuses an agent outright unless the human-typed acknowledgement is present.
 *
 * Nothing here touches the network. The mapping is local by construction — that is the point of
 * REQ-058 rather than a server-side lookup: the surrogate→real relationship never leaves the machine.
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, PolicyError, UsageError } from "../core/errors.ts";
import { renderDataDocument } from "../core/output.ts";
import { clearHandles, handlesPath, loadHandles } from "../core/config.ts";
import { HANDLE_PREFIX, isHandle, resolveHandle } from "../core/privacy.ts";
import { flag } from "./context.ts";

/** AC-53.4: a human resolves handles, not the agent whose protection they are. */
function assertHuman(ctx: Ctx): void {
  if (ctx.caller.context !== "agent" || ctx.args.flags.allowAgentData) return;
  throw new PolicyError("de-pseudonymize is for a human, not a detected AI caller", {
    hint:
      "Signals: " + ctx.caller.signals.join("; ") + ".\n" +
      "Resolving a handle removes the protection the handle exists to provide, so it is not the\n" +
      "caller's to do. Run it yourself in a terminal, or pass\n" +
      "  --i-understand-data-goes-to-a-model\n" +
      "if you are the human and you meant it.",
  });
}

export function runDePseudonymize(ctx: Ctx): ExitCode {
  if (flag(ctx, "clear")) {
    // Lifetime, made explicit (AC-53.6): clearing is how a handle expires, and it is irreversible —
    // every outstanding handle stops resolving, which `resolveHandle` then reports honestly.
    const removed = clearHandles(ctx.io.env);
    ctx.io.out(removed ? "Handle mapping removed.\n" : "No handle mapping stored.\n");
    if (removed) {
      ctx.io.err("Every outstanding ref: handle is now unresolvable. Re-run a query to mint fresh ones.\n");
    }
    return ExitCode.Ok;
  }

  const handles = loadHandles(ctx.io.env);

  if (flag(ctx, "list")) {
    // Counting is not revealing: it says how many handles exist, never what they mean (AC-53.3).
    const count = Object.keys(handles).length;
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDataDocument({ count, path: handlesPath(ctx.io.env) }, { format: ctx.format, write: ctx.openData("handle count") });
      return ExitCode.Ok;
    }
    ctx.io.out(`${count} handle${count === 1 ? "" : "s"} stored\n`);
    ctx.io.err(`${handlesPath(ctx.io.env)}\n`);
    return ExitCode.Ok;
  }

  const refs = ctx.args.positionals;
  if (refs.length === 0) {
    throw new UsageError("`de-pseudonymize` needs at least one ref: handle", {
      hint:
        `signum de-pseudonymize ${HANDLE_PREFIX}7f3a1c2b4d5e\n` +
        "signum de-pseudonymize --list     how many are stored\n" +
        "signum de-pseudonymize --clear    forget them all",
    });
  }

  // Everything below emits real identities.
  assertHuman(ctx);

  const bad = refs.filter((r) => !isHandle(r));
  if (bad.length > 0) {
    throw new UsageError(`not a handle: ${bad.join(", ")}`, {
      hint: `A handle starts with '${HANDLE_PREFIX}'. Lite keys are already readable — there is nothing to resolve.`,
    });
  }

  // Resolve all of them before emitting anything, so a partial answer never looks complete.
  const resolved = refs.map((ref) => ({ ref, entity: resolveHandle(ref, handles) }));

  const out = ctx.openData("re-identified records");
  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDataDocument(resolved, { format: ctx.format, write: out });
  } else {
    const w = Math.max(...resolved.map((r) => r.ref.length));
    for (const r of resolved) out(`${r.ref.padEnd(w)}  ${r.entity}\n`);
  }
  return ExitCode.Ok;
}
