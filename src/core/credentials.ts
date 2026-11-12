/**
 * Stored credentials: save, load, rotate, delete, and the permission check on their file.
 *
 * REQ-006, STORY-04 · AC-04.1 (0600), AC-04.4 (atomic rotation), AC-11.5 · REQ-001 (one per target)
 *
 * The handed-over token is the ONLY credential available against the target application
 * (ADR 0004 Decision 4), so losing it costs a manual browser round trip. Rotation writes
 * are therefore atomic and their failure is surfaced, not swallowed (AC-12.12).
 *
 * One credential per target, keyed by canonical URL, so logging in to a second application no
 * longer replaces the first. The most recent login is the default target when neither `--url` nor
 * `-i` is given — the behaviour a single stored credential had. Tokens stay in this file, never in
 * `instances.json`: the secret has one home, one permission check and one `logout`.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir, writePrivate } from "./config.ts";
import { normalizeUrl } from "./text.ts";

export interface StoredCredential {
  url: string;
  token: string;
  /** How the credential was obtained; informational. */
  source: "browser-handoff";
  savedAt: string;
  rotatedAt?: string;
}

interface CredentialsFile {
  version: 2;
  /** Canonical URL of the most recent login: the target when none is named. */
  default?: string;
  credentials: Record<string, StoredCredential>;
}

function credentialPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "credential.json");
}

function asCredential(v: unknown): StoredCredential | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const c = v as Partial<StoredCredential>;
  if (typeof c.token !== "string" || typeof c.url !== "string") return undefined;
  return {
    url: c.url,
    token: c.token,
    source: "browser-handoff",
    savedAt: c.savedAt ?? "unknown",
    ...(c.rotatedAt !== undefined ? { rotatedAt: c.rotatedAt } : {}),
  };
}

/**
 * The file as stored, or an empty one. A file from before per-target storage holds ONE credential
 * at the top level; it is read as a store of one, and rewritten in the new shape on the next save.
 */
function readFile(env?: NodeJS.ProcessEnv): CredentialsFile {
  const path = credentialPath(env);
  const empty: CredentialsFile = { version: 2, credentials: {} };
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  const legacy = asCredential(parsed);
  if (legacy !== undefined) {
    const key = normalizeUrl(legacy.url);
    return { version: 2, default: key, credentials: { [key]: legacy } };
  }
  const p = parsed as Partial<CredentialsFile>;
  const credentials: Record<string, StoredCredential> = {};
  for (const v of Object.values(p.credentials ?? {})) {
    const c = asCredential(v);
    if (c !== undefined) credentials[normalizeUrl(c.url)] = c;
  }
  return { version: 2, ...(typeof p.default === "string" ? { default: p.default } : {}), credentials };
}

function writeFile(file: CredentialsFile, env?: NodeJS.ProcessEnv): string {
  const path = credentialPath(env);
  writePrivate(path, JSON.stringify(file, null, 2) + "\n");
  return path;
}

/** Store (or replace) the credential for its URL, and make that URL the default target. */
export function saveCredential(cred: StoredCredential, env?: NodeJS.ProcessEnv): string {
  const file = readFile(env);
  const key = normalizeUrl(cred.url);
  file.credentials[key] = cred;
  file.default = key;
  return writeFile(file, env);
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

/** The URL of the most recent login, used when no target is named. */
export function defaultCredentialUrl(env?: NodeJS.ProcessEnv): string | undefined {
  const file = readFile(env);
  return file.default !== undefined ? file.credentials[file.default]?.url : undefined;
}

/**
 * Make `url` the default target (`auth switch`, AC-05.2): the one a command uses when no flag or
 * variable names one. Only a target with a stored credential can be the default — the default has
 * always been "a login", and switching to a URL nobody logged in to is more likely a typo than a
 * wish. Returns false when there is no credential for it.
 */
export function setDefaultTarget(url: string, env?: NodeJS.ProcessEnv): boolean {
  const file = readFile(env);
  const key = normalizeUrl(url);
  if (file.credentials[key] === undefined) return false;
  file.default = key;
  writeFile(file, env);
  return true;
}

/** Every stored credential's URL, for listing. Tokens are deliberately not part of the answer. */
export function storedCredentialUrls(env?: NodeJS.ProcessEnv): string[] {
  return Object.values(readFile(env).credentials).map((c) => c.url).sort();
}

/**
 * The credential for `url`, compared canonically so a trailing slash or default port does not
 * orphan it (M2). With no URL, the default target's.
 */
export function loadCredential(url: string | undefined, env?: NodeJS.ProcessEnv): LoadedCredential | undefined {
  const file = readFile(env);
  const key = url !== undefined ? normalizeUrl(url) : file.default;
  const credential = key !== undefined ? file.credentials[key] : undefined;
  if (credential === undefined) return undefined;
  const path = credentialPath(env);
  return { credential, path, permissionWarning: checkPermissions(path) };
}

/** Remove the credential for `url`. The file goes once it holds nothing. */
export function deleteCredential(url: string, env?: NodeJS.ProcessEnv): boolean {
  const file = readFile(env);
  const key = normalizeUrl(url);
  if (file.credentials[key] === undefined) return false;
  delete file.credentials[key];
  if (file.default === key) delete file.default;
  if (Object.keys(file.credentials).length === 0) unlinkSync(credentialPath(env));
  else writeFile(file, env);
  return true;
}

/** Remove every stored credential. Returns the URLs removed. */
export function deleteAllCredentials(env?: NodeJS.ProcessEnv): string[] {
  const urls = storedCredentialUrls(env);
  const path = credentialPath(env);
  if (existsSync(path)) unlinkSync(path);
  return urls;
}

/**
 * Adopt a rotated token for the target that issued it (AC-04.4). Returns an error message on
 * failure rather than throwing, so a rotation problem is reported without failing the command.
 * Keyed by URL: rotating "the" credential would hand one application's token to another.
 */
export function rotateCredential(url: string, token: string, env?: NodeJS.ProcessEnv): string | undefined {
  const file = readFile(env);
  const key = normalizeUrl(url);
  const existing = file.credentials[key];
  if (existing === undefined) return `no stored credential for ${url} to rotate`;
  try {
    file.credentials[key] = { ...existing, token, rotatedAt: new Date().toISOString() };
    writeFile(file, env);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
