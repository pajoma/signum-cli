/**
 * Re-identification — the reverse of pseudonymization (REQ-058 · STORY-53).
 *
 * Recognises `ref_` handles and resolves them back to the records they stand for, in arguments
 * (`query`/`get` filters) and in text files (`unmask`). Kept apart from privacy.ts, which only ever
 * HIDES values, so the code that reveals them is small enough to review on its own: nothing on the
 * agent-facing output path imports this module except to resolve handles the caller passed in.
 */

import { ALL_HANDLE_PREFIXES, HANDLE_PREFIX, handleDigest } from "./privacy.ts";
import { UsageError } from "./errors.ts";

export function isHandle(value: string): boolean {
  return handleDigest(value) !== undefined;
}

/**
 * Look a handle up, tolerating either prefix in either direction.
 *
 * The token as written wins; failing that, the same digest is tried under every other accepted
 * prefix. That is what lets a store written before the `ref:` -> `ref_` change serve a document
 * written after it, and vice versa, without rewriting anybody's store.
 */
export function lookupHandle(
  handle: string,
  handles: Readonly<Record<string, string>>,
): string | undefined {
  const direct = handles[handle];
  if (direct !== undefined) return direct;
  const digest = handleDigest(handle);
  if (digest === undefined) return undefined;
  for (const p of ALL_HANDLE_PREFIXES) {
    const alt = handles[`${p}${digest}`];
    if (alt !== undefined) return alt;
  }
  return undefined;
}

/**
 * Resolve a handle to the real Lite key it stands for (AC-53.2).
 *
 * Throws when it cannot: an unresolvable handle must never be forwarded to the server as a literal
 * string, which would either 404 confusingly or — worse — match something (AC-53.5).
 */
export function resolveHandle(handle: string, handles: Readonly<Record<string, string>>): string {
  const real = lookupHandle(handle, handles);
  if (real === undefined) {
    throw new UsageError(`cannot resolve ${handle}`, {
      hint:
        "Handles are local and per target application: one minted against another instance or\n" +
        "URL never resolves here, so it cannot reach the wrong record. Neither does one from another\n" +
        "profile, from before `unmask --clear`, or from before handles were kept per application.\n" +
        "Re-run the query against this application to mint a fresh handle.",
    });
  }
  return real;
}

/**
 * Every handle-shaped token in free text, built from `HANDLE_PREFIX` so the two cannot drift.
 *
 * Deliberately permissive about length (`+`, not `{12}`) even though minted handles are exactly
 * `HANDLE_HEX` characters. A malformed or truncated token then still gets FOUND and reported as
 * unresolvable, rather than not matching at all and being indistinguishable from "there were none" —
 * which is the failure the issue calls out as looking identical to success.
 */
const HANDLE_IN_TEXT = new RegExp(
  `(?:${ALL_HANDLE_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[0-9a-f]+`,
  "g",
);

export interface TextResolution {
  text: string;
  /** How many handle occurrences were replaced — occurrences, not distinct handles. */
  replaced: number;
  /** Distinct handles found but not in the store, in order of first appearance. */
  unresolved: string[];
  /** Resolved, but no label was known, so the identity was substituted instead (#106). */
  labelless: string[];
}

/**
 * Replace every resolvable `ref:` handle in `text` with the record it stands for (#102).
 *
 * Two properties that the hand-rolled scripts this replaces got wrong, and that are structural here
 * rather than maintained by care:
 *
 * 1. **Length collisions are impossible**, because this is ONE left-to-right pass over the text and
 *    each match is replaced exactly once. The scripted version collected handles into a list and
 *    substituted them one after another, where `ref:abc` clobbers the prefix of `ref:abcdef` unless
 *    the list is sorted longest-first — a silent corruption when you forget. There is no list here,
 *    so there is no ordering to get wrong.
 *
 * 2. **Idempotent**, because a replacement is a `Type;id` key, which does not match the handle
 *    pattern. Running twice finds nothing the second time.
 *
 * A token that is handle-shaped but absent from the store is left EXACTLY as it was and reported.
 * The bias is deliberate: never substitute something we are unsure of, and never stay quiet about
 * having skipped it.
 */
export function resolveHandlesInText(
  text: string,
  handles: Readonly<Record<string, string>>,
  options: ResolveTextOptions = {},
): TextResolution {
  let replaced = 0;
  const unresolved: string[] = [];
  const labelless: string[] = [];
  // Canonicalized ONCE, so a label is found whichever prefix spelling the store and the document
  // happen to use. Looking up the raw token and then its canonical form only covered one direction:
  // a new-form `ref_…` in a document could not find a label filed under a legacy `ref:…` key, so an
  // old store reported every label missing while resolving every identity. Identity lookup already
  // compared by digest; this now uses the same rule instead of a second, weaker one.
  const byCanonical = new Map<string, string>();
  for (const [h, label] of Object.entries(options.labels ?? {})) {
    byCanonical.set(canonicalHandle(h) ?? h, label);
  }
  const out = text.replace(HANDLE_IN_TEXT, (match) => {
    const real = lookupHandle(match, handles);
    if (real === undefined) {
      if (!unresolved.includes(match)) unresolved.push(match);
      return match;
    }
    replaced++;
    if (options.preferLabel !== true) return real;
    const label = byCanonical.get(canonicalHandle(match) ?? match);
    if (label === undefined) {
      // Falls back to the identity and SAYS SO, rather than quietly emitting `Project;20` where the
      // caller asked for a name — indistinguishable, otherwise, from a label that happens to look
      // like a Lite key (#106).
      if (!labelless.includes(match)) labelless.push(match);
      return real;
    }
    return options.escape === undefined ? label : options.escape(label);
  });
  return { text: out, replaced, unresolved, labelless };
}

export interface ResolveTextOptions {
  /** handle -> display string, where one is known. */
  labels?: Readonly<Record<string, string>> | undefined;
  /** Substitute the label rather than the identity. */
  preferLabel?: boolean;
  /**
   * How to make a label safe for the FORMAT being written into, chosen by the caller.
   *
   * Deliberately a function rather than a boolean. It was `escapeMarkdownPipes` and it was applied to
   * every text file, so a label containing `|` was written into JSON as `A\|B` — an invalid escape
   * that makes the document unparseable. This module cannot know what it is editing; the caller does,
   * and now has to say. No escaper means literal substitution.
   */
  escape?: ((label: string) => string) | undefined;
}

/** The canonical spelling of a handle, so a legacy `ref:` token finds a `ref_` label key. */
export function canonicalHandle(handle: string): string | undefined {
  const digest = handleDigest(handle);
  return digest === undefined ? undefined : `${HANDLE_PREFIX}${digest}`;
}
