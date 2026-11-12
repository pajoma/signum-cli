/**
 * The on-disk metadata cache (REQ-010): reflection documents, and the query descriptions help reads.
 */

import {
  existsSync, readdirSync, readFileSync, rmSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeUrl } from "./text.ts";
import { configDir, writePrivate } from "./config.ts";

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
  const scope = authenticated ? "auth" : "anon";
  return join(configDir(env), "cache", `reflection-${targetDigest(url)}-${scope}.json`);
}

/**
 * Filename-safe digest of the NORMALIZED URL, so the cache key agrees with credential matching
 * (M2) — otherwise `app/` and `app` would keep separate caches.
 */
function targetDigest(url: string): string {
  const key = normalizeUrl(url);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}

// ── query descriptions (AC-61.3) ────────────────────────────────────────────

/**
 * `api/query/description/{key}`, one file per target holding every query described so far. Help
 * reads it so `signum query <key> --help` works offline once the query has run. It needs a
 * credential, so there is no anonymous half; every live fetch rewrites the entry, which is how it
 * stays current without a revalidation request of its own.
 */
interface DescriptionStore {
  url: string;
  queries: Record<string, { fetchedAt: string; payload: unknown }>;
}

function descriptionsPath(url: string, env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "cache", `descriptions-${targetDigest(url)}.json`);
}

function loadDescriptionStore(url: string, env?: NodeJS.ProcessEnv): DescriptionStore | undefined {
  const path = descriptionsPath(url, env);
  if (!existsSync(path)) return undefined;
  try {
    const store = JSON.parse(readFileSync(path, "utf8")) as DescriptionStore;
    return normalizeUrl(store.url) === normalizeUrl(url) && typeof store.queries === "object" ? store : undefined;
  } catch {
    return undefined;
  }
}

export function loadQueryDescription(url: string, queryKey: string, env?: NodeJS.ProcessEnv): { payload: unknown; fetchedAt: string } | undefined {
  return loadDescriptionStore(url, env)?.queries[queryKey.toLowerCase()];
}

export function saveQueryDescription(url: string, queryKey: string, payload: unknown, env?: NodeJS.ProcessEnv): void {
  const store = loadDescriptionStore(url, env) ?? { url, queries: {} };
  store.queries[queryKey.toLowerCase()] = { fetchedAt: new Date().toISOString(), payload };
  writePrivate(descriptionsPath(url, env), JSON.stringify(store));
}

/** How many query descriptions are cached for a target, for `cache show`. */
export function countQueryDescriptions(url: string, env?: NodeJS.ProcessEnv): number {
  return Object.keys(loadDescriptionStore(url, env)?.queries ?? {}).length;
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
  // A target's query descriptions go with its reflection documents: both describe the same schema.
  if (url !== undefined) rmSync(descriptionsPath(url, env), { force: true });
  else if (existsSync(cacheDir(env))) {
    for (const name of readdirSync(cacheDir(env))) {
      if (name.startsWith("descriptions-") && name.endsWith(".json")) rmSync(join(cacheDir(env), name), { force: true });
    }
  }
  return removed;
}
