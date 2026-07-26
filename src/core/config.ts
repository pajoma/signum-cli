/**
 * Credential and cache storage.
 *
 * REQ-006, STORY-04 · AC-04.1 (0600), AC-04.4 (atomic rotation), AC-11.5
 *
 * The handed-over token is the ONLY credential available against the target application
 * (ADR 0004 Decision 4), so losing it costs a manual browser round trip. Rotation writes
 * are therefore atomic and their failure is surfaced, not swallowed (AC-12.12).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write-then-rename so a concurrent reader never sees a half-written token (AC-04.4).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
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

export function loadCredential(env?: NodeJS.ProcessEnv): LoadedCredential | undefined {
  const path = credentialPath(env);
  if (!existsSync(path)) return undefined;

  let permissionWarning: string | undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      permissionWarning = `${path} is mode ${mode.toString(8)}; expected 600`;
    }
  } catch {
    // Non-fatal: a stat failure must not prevent using a readable credential.
  }

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
  lastModified: string | undefined;
  fetchedAt: string;
  payload: unknown;
}

function cachePath(url: string, env?: NodeJS.ProcessEnv): string {
  // Filename-safe digest of the URL; distinct targets never share a cache.
  let hash = 0;
  for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return join(configDir(env), "cache", `reflection-${(hash >>> 0).toString(16)}.json`);
}

export function loadMetadataCache(
  url: string,
  env?: NodeJS.ProcessEnv,
): { payload: unknown; lastModified: string | undefined; fetchedAt: string } | undefined {
  const path = cachePath(url, env);
  if (!existsSync(path)) return undefined;
  try {
    const env_ = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
    if (env_.url !== url) return undefined;
    return { payload: env_.payload, lastModified: env_.lastModified, fetchedAt: env_.fetchedAt };
  } catch {
    return undefined;
  }
}

export function saveMetadataCache(
  url: string,
  payload: unknown,
  lastModified: string | undefined,
  env?: NodeJS.ProcessEnv,
): void {
  const envelope: CacheEnvelope = {
    url,
    lastModified,
    fetchedAt: new Date().toISOString(),
    payload,
  };
  writePrivate(cachePath(url, env), JSON.stringify(envelope));
}
