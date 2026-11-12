/**
 * The signum config directory and the private-file writer every store in it uses.
 *
 * Stores: credentials.ts (REQ-006), metadata-cache.ts (REQ-010), handles.ts (REQ-058, per target),
 * instances.ts (REQ-001).
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeUrl } from "./text.ts";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["SIGNUM_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "signum");
  return join(homedir(), ".config", "signum");
}

/**
 * The directory of what is kept per target application (REQ-001, #121): its handle store. Named
 * by the host, for a person browsing the config directory, and a digest of the canonical URL, so
 * two applications on one host — or the same one spelled with a trailing slash — never share it.
 */
export function targetDir(env: NodeJS.ProcessEnv | undefined, url: string): string {
  const canonical = normalizeUrl(url);
  let host = "target";
  try {
    host = new URL(canonical).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    // An unparseable URL still gets a directory of its own, by digest alone.
  }
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return join(configDir(env), "targets", `${host}-${digest}`);
}

/** Every per-target directory that exists, for the commands that span them (`unmask`). */
export function targetDirs(env?: NodeJS.ProcessEnv): string[] {
  const root = join(configDir(env), "targets");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)).sort();
}

export function writePrivate(path: string, contents: string): void {
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

