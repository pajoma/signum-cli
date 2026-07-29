/**
 * The data-output boundary (ADR 0007 · REQ-057 · STORY-51).
 *
 * Brooks review M3: the privacy gate used to be a *caller convention* — every data-producing
 * command had to remember to call `assertMayEmitData` itself, and forgetting it was a silent
 * leak that nothing could detect. This module turns that omission into a commission.
 *
 * A renderer that emits server DATA (query rows, entity documents, existence answers) accepts
 * only a `DataWriter`. The only ordinary way to obtain one is `makeDataOpener(...)(what)`,
 * which runs the gate first and throws `PolicyError` when the caller is a detected AI agent
 * without an explicit acknowledgement. Metadata, help, `auth status` and `--explain` keep
 * writing through plain `(chunk: string) => void`, so they are structurally on a different
 * path and can never be gated by accident.
 *
 * The brand is a real runtime symbol rather than a phantom type, for the same reason
 * `ResolvedTable` is (ADR 0006 cost 5 — TypeScript erases): the compile-time check is the
 * useful half, and `assertDataWriter` is the half that survives erasure.
 *
 * `unsafeDataWriter` is the deliberate escape hatch for tests and for any call site that has
 * been audited to be non-data. It is named to be greppable: `grep unsafeDataWriter src/`
 * should return nothing.
 */

import type { CallerDetection } from "./caller.ts";
import { CliError, ExitCode, PolicyError } from "./errors.ts";

const DATA_WRITER: unique symbol = Symbol("signum.dataWriter");

/** A stdout writer whose existence proves the ADR 0007 gate was applied. */
export type DataWriter = ((chunk: string) => void) & { readonly [DATA_WRITER]: true };

function brand(write: (chunk: string) => void): DataWriter {
  const w = ((chunk: string) => write(chunk)) as DataWriter;
  Object.defineProperty(w, DATA_WRITER, { value: true, enumerable: false });
  return w;
}

/**
 * Mint a `DataWriter` WITHOUT applying the gate. Tests use it for their own sinks; production
 * code must not. Callers state why in `reason` so the audit trail is in the source, not a
 * commit message.
 */
export function unsafeDataWriter(write: (chunk: string) => void, reason: string): DataWriter {
  if (reason.trim() === "") throw new Error("unsafeDataWriter requires a reason");
  return brand(write);
}

/** The runtime half of the boundary, for renderers that cannot trust type erasure. */
export function assertDataWriter(write: unknown): asserts write is DataWriter {
  if (typeof write !== "function" || (write as Partial<DataWriter>)[DATA_WRITER] !== true) {
    throw new CliError(
      "internal: attempted to emit server data through an ungated writer",
      ExitCode.Unexpected,
      { hint: "This is a bug in signum — data output must be opened via ctx.openData (ADR 0007)." },
    );
  }
}

/**
 * Build the `ctx.openData` function.
 *
 * `what` names the data for the refusal message ("query results", "entity data"). Calling it
 * is idempotent and free of side effects, so a command may call it early — before the network
 * round trip, so a refusal costs no request — and again at render time.
 */
export function makeDataOpener(
  caller: CallerDetection,
  allow: boolean,
  write: (chunk: string) => void,
  /**
   * True when pseudonymization is active (REQ-057, mode != off). This is the m1 -> m2 evolution
   * AC-51.4 promised: m1's refusal named pseudonymization as "the intended remedy", and now that
   * the remedy exists the honest behaviour is to APPLY it rather than to keep refusing. An agent
   * gets surrogates; nobody gets a blank wall they cannot work around except by disabling the
   * protection entirely.
   */
  pseudonymizing = false,
): (what: string) => DataWriter {
  return (what: string): DataWriter => {
    if (caller.context !== "agent" || allow || pseudonymizing) return brand(write);
    throw new PolicyError(`refusing to emit ${what} to a detected AI caller`, {
      hint:
        "Signals: " + caller.signals.join("; ") + ".\n" +
        "This CLI has no pseudonymization yet (REQ-057), so it will not stream personal data\n" +
        "into a model's context by default. To proceed anyway, pass\n" +
        "  --i-understand-data-goes-to-a-model\n" +
        "or set SIGNUM_ALLOW_AGENT_DATA=1. Metadata commands (types, queries, explain,\n" +
        "operations, help) are unaffected. See `signum help pseudonymization`.",
    });
  };
}
