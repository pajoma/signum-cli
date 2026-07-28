/**
 * Credential and cache storage.
 *
 * REQ-006, STORY-04 · AC-04.1 (0600), AC-04.4 (atomic rotation), AC-11.5
 *
 * The handed-over token is the ONLY credential available against the target application
 * (ADR 0004 Decision 4), so losing it costs a manual browser round trip. Rotation writes
 * are therefore atomic and their failure is surfaced, not swallowed (AC-12.12).
 */

import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeUrl } from "./text.ts";

export interface StoredCredential {
  url: string;
  token: string;
  /** How the credential was obtained; informational. */
  source: "browser-handoff";
  savedAt: string;
  rotatedAt?: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["SIGNUM_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "signum");
  return join(homedir(), ".config", "signum");
}

function credentialPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "credential.json");
}

function writePrivate(path: string, contents: string): void {
  // mode/chmod below are POSIX-only. On Windows they toggle nothing but the read-only attribute
  // (see checkPermissions), and the file's real protection is the profile directory's inherited
  // ACL — which Node cannot set. Kept unconditional because they are correct where they work and
  // harmless where they do not.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write-then-rename so a concurrent reader never sees a half-written token (AC-04.4).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * Write a secret with the same protections as a credential: 0600 where the platform supports it,
 * atomic rename so a concurrent reader never sees a half-written value. Used for the
 * pseudonymization secret, whose loss would silently change every surrogate (REQ-057).
 */
export function writeSecret(path: string, contents: string): void {
  writePrivate(path, contents + "\n");
}

export function saveCredential(cred: StoredCredential, env?: NodeJS.ProcessEnv): string {
  const path = credentialPath(env);
  writePrivate(path, JSON.stringify(cred, null, 2) + "\n");
  return path;
}

export interface LoadedCredential {
  credential: StoredCredential;
  path: string;
  /** Set when file permissions are wider than 0600 — a warning, not a failure (AC-11.5). */
  permissionWarning: string | undefined;
}

/**
 * Whether the credential file's POSIX mode is wider than 0600 (AC-11.5).
 *
 * **Returns undefined on Windows, deliberately.** Node cannot express this check there:
 * `chmod` only toggles the read-only attribute, and `stat().mode` is *synthesized* — 0o666 when
 * writable, 0o444 when read-only — with NTFS ACLs invisible to it. So `saveCredential`'s
 * `chmod 0o600` is a no-op on Windows and the file can only ever report 666, which made this check
 * fire on **every single invocation** with a warning the user could not act on (#84).
 *
 * A warning nobody can satisfy is worse than no warning: it trains people to ignore the ones that
 * matter. And the 666 was never evidence of exposure — on Windows the file's actual protection is
 * the ACL inherited from the user's profile directory, which grants the owner, SYSTEM and
 * Administrators, not everyone. The CLI cannot read or set that ACL with Node, so it reports what
 * it knows and says so (see `auth status`) rather than asserting a guarantee it cannot make.
 *
 * `platform` is injectable so both branches are testable from either host.
 */
export function checkPermissions(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${path} is mode ${mode.toString(8)}; expected 600`;
    }
  } catch {
    // Non-fatal: a stat failure must not prevent using a readable credential.
  }
  return undefined;
}

/**
 * True where the CLI cannot enforce or verify credential file permissions itself. Callers that
 * diagnose (`auth status`) should say where the protection actually comes from.
 */
export function permissionsAreUnenforceable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function loadCredential(env?: NodeJS.ProcessEnv): LoadedCredential | undefined {
  const path = credentialPath(env);
  if (!existsSync(path)) return undefined;

  const permissionWarning = checkPermissions(path);

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCredential>;
    if (typeof parsed.token !== "string" || typeof parsed.url !== "string") return undefined;
    return {
      credential: {
        url: parsed.url,
        token: parsed.token,
        source: "browser-handoff",
        savedAt: parsed.savedAt ?? "unknown",
        ...(parsed.rotatedAt !== undefined ? { rotatedAt: parsed.rotatedAt } : {}),
      },
      path,
      permissionWarning,
    };
  } catch {
    return undefined;
  }
}

export function deleteCredential(env?: NodeJS.ProcessEnv): boolean {
  const path = credentialPath(env);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Adopt a rotated token (AC-04.4). Returns an error message on failure rather than
 * throwing, so a rotation problem is reported without failing the user's command.
 */
export function rotateCredential(token: string, env?: NodeJS.ProcessEnv): string | undefined {
  const existing = loadCredential(env);
  if (existing === undefined) return "no stored credential to rotate";
  try {
    saveCredential({ ...existing.credential, token, rotatedAt: new Date().toISOString() }, env);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── metadata cache (REQ-010) ────────────────────────────────────────────────

interface CacheEnvelope {
  url: string;
  /** Whether the response was fetched WITH a credential — see `cachePath`. */
  authenticated: boolean;
  lastModified: string | undefined;
  fetchedAt: string;
  payload: unknown;
}

/**
 * Anonymous and authenticated reflection responses are DIFFERENT documents and get different
 * cache files.
 *
 * `AuthServer.cs:143-157` rewrites `queryDefined` per caller — an anonymous request sees it
 * false for every type — while `ReflectionServer.LastModified` is a process-wide static
 * (`ReflectionController.cs:17`), so the server would answer 304 to a conditional request and
 * hand back the wrong document. Splitting the file is what stops `signum types` before login
 * from poisoning `signum query` after it.
 */
function cachePath(url: string, authenticated: boolean, env?: NodeJS.ProcessEnv): string {
  // Filename-safe digest of the NORMALIZED URL, so the cache key agrees with credential
  // matching (M2) — otherwise `app/` and `app` would keep separate caches.
  const key = normalizeUrl(url);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const scope = authenticated ? "auth" : "anon";
  return join(configDir(env), "cache", `reflection-${(hash >>> 0).toString(16)}-${scope}.json`);
}

export function loadMetadataCache(
  url: string,
  authenticated: boolean,
  env?: NodeJS.ProcessEnv,
): { payload: unknown; lastModified: string | undefined; fetchedAt: string } | undefined {
  const path = cachePath(url, authenticated, env);
  if (!existsSync(path)) return undefined;
  try {
    const env_ = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
    // Compare canonically (M2): the digest already collapses slash/port variants to one file,
    // so this collision guard must too, or a same-target hit gets rejected.
    if (normalizeUrl(env_.url) !== normalizeUrl(url)) return undefined;
    if (env_.authenticated !== authenticated) return undefined; // belt and braces; path already splits them
    return { payload: env_.payload, lastModified: env_.lastModified, fetchedAt: env_.fetchedAt };
  } catch {
    return undefined;
  }
}

export function saveMetadataCache(
  url: string,
  authenticated: boolean,
  payload: unknown,
  lastModified: string | undefined,
  env?: NodeJS.ProcessEnv,
): void {
  const envelope: CacheEnvelope = {
    url,
    authenticated,
    lastModified,
    fetchedAt: new Date().toISOString(),
    payload,
  };
  writePrivate(cachePath(url, authenticated, env), JSON.stringify(envelope));
}

// ── cache inspection and clearing (AC-24.3) ─────────────────────────────────

/** The directory holding every cached reflection document. */
export function cacheDir(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "cache");
}

export interface CacheEntry {
  /** The target this document describes, as it was written. */
  url: string;
  /** Whether it was fetched with a credential — anonymous and authenticated differ. */
  authenticated: boolean;
  fetchedAt: string;
  lastModified: string | undefined;
  /** Number of types in the document, as a cheap "is this useful" signal. */
  types: number;
  path: string;
  sizeBytes: number;
}

/**
 * Every cached document, newest first.
 *
 * Reads the envelopes rather than parsing filenames: the filename carries a non-reversible
 * digest of the URL (so one cannot be recovered from the other), which is exactly why the URL
 * has to be stored inside. A file that will not parse is skipped rather than thrown on — a
 * corrupt cache entry must never stop the user from clearing it.
 */
export function listMetadataCache(env?: NodeJS.ProcessEnv): CacheEntry[] {
  const dir = cacheDir(env);
  if (!existsSync(dir)) return [];
  const out: CacheEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("reflection-") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const env_ = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
      const payload = env_.payload;
      out.push({
        url: env_.url,
        authenticated: env_.authenticated === true,
        fetchedAt: env_.fetchedAt,
        lastModified: env_.lastModified,
        types: payload !== null && typeof payload === "object" ? Object.keys(payload).length : 0,
        path,
        sizeBytes: statSync(path).size,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || a.url.localeCompare(b.url));
}

/**
 * Delete cached documents, optionally only those for one target. Returns what was removed, so
 * the caller can report it rather than claiming a number it did not verify.
 *
 * Clearing a URL removes BOTH its anonymous and authenticated documents: a user asking to clear
 * the cache for a target means the target, not one half of it they cannot see.
 */
export function clearMetadataCache(url: string | undefined, env?: NodeJS.ProcessEnv): CacheEntry[] {
  const wanted = url !== undefined ? normalizeUrl(url) : undefined;
  const removed: CacheEntry[] = [];
  for (const entry of listMetadataCache(env)) {
    if (wanted !== undefined && normalizeUrl(entry.url) !== wanted) continue;
    rmSync(entry.path, { force: true });
    removed.push(entry);
  }
  return removed;
}
