/**
 * Named instances: a short slug for a target application's URL, so `signum -i renew types` works
 * instead of `signum --url https://renew.example/home types`.
 *
 * REQ-001 (connection profiles): the slug → URL registry, and per instance whether it is protected
 * and which header carries its token. The credential is still matched by URL (credentials.ts), so
 * `-i renew` reaches the stored token exactly when `--url <same url>` would.
 *
 * Stored as `instances.json` in the config directory, written owner-only like every other store:
 * a list of a customer's application URLs is not a secret, but it is nobody else's business either.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writePrivate } from "./config.ts";
import { CliError, ExitCode, UsageError } from "./errors.ts";
import { nearest, normalizeUrl } from "./text.ts";

/**
 * A registered instance is a profile (AC-05.1): its URL, and how commands treat it. The credential is
 * referenced by the URL, never stored here; the mechanism is the browser-handoff token, the only one
 * there is until API keys (REQ-002, m3), so it is reported rather than chosen.
 */
export interface Instance {
  slug: string;
  url: string;
  /** Writes need the instance's name typed back at a terminal, `--yes` or not (AC-05.5). */
  protected?: true;
  /**
   * The header the token goes in, when the application moved it: `AuthTokensServer.AuthHeader` is
   * settable, and Windows-AD applications set `Signum_Authorization` (`AuthTokensServer.cs:57-62`).
   */
  authHeader?: string;
}

/** What `instance add` and `instance set` change besides the URL. `authHeader: null` restores the default. */
export interface ProfileSettings {
  protected?: boolean;
  authHeader?: string | null;
}

interface InstancesFile {
  version: 1;
  instances: Record<string, { url: string; protected?: boolean; authHeader?: string }>;
}

/** The header Signum reads the token from by default (`AuthTokensServer.cs:57`). */
export const DEFAULT_AUTH_HEADER = "Authorization";

/** Lowercase, starts with a letter or digit; short enough to type, never mistaken for a URL. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function instancesPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "instances.json");
}

function read(env?: NodeJS.ProcessEnv): InstancesFile {
  const path = instancesPath(env);
  if (!existsSync(path)) return { version: 1, instances: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstancesFile>;
    if (parsed.instances === null || typeof parsed.instances !== "object") throw new Error("no instances map");
    return { version: 1, instances: parsed.instances };
  } catch (err) {
    // Loud, not empty: a registry that silently reads as empty turns every `-i` into "unknown
    // instance", which sends the user hunting for a typo that is not there.
    throw new CliError(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, ExitCode.Unexpected, {
      hint: "Fix or delete the file, then re-add instances with `signum instance add`.",
    });
  }
}

export function listInstances(env?: NodeJS.ProcessEnv): Instance[] {
  return Object.entries(read(env).instances)
    .filter(([, v]) => typeof v?.url === "string")
    .map(([slug, v]) => ({
      slug, url: v.url,
      ...(v.protected === true ? { protected: true as const } : {}),
      ...(typeof v.authHeader === "string" && v.authHeader !== "" ? { authHeader: v.authHeader } : {}),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** An HTTP header name (RFC 9110 token). The default name is stored as no override at all. */
export function validateHeaderName(name: string): string | null {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new UsageError(`'${name}' is not a header name`, { hint: "e.g. Signum_Authorization, which a Windows-AD application reads the token from." });
  }
  return name.toLowerCase() === DEFAULT_AUTH_HEADER.toLowerCase() ? null : name;
}

/**
 * The header a target's token goes in: `SIGNUM_AUTH_HEADER`, so a run needs no config file (AC-05.3),
 * else the profile's override, else `Authorization`.
 */
export function authHeaderFor(url: string, env?: NodeJS.ProcessEnv): string {
  const fromEnv = env?.["SIGNUM_AUTH_HEADER"];
  if (fromEnv !== undefined && fromEnv !== "") return validateHeaderName(fromEnv) ?? DEFAULT_AUTH_HEADER;
  return profileForUrl(url, env)?.authHeader ?? DEFAULT_AUTH_HEADER;
}

/** The instance a URL is registered as, with its settings. */
export function profileForUrl(url: string, env?: NodeJS.ProcessEnv): Instance | undefined {
  const key = normalizeUrl(url);
  return listInstances(env).find((i) => normalizeUrl(i.url) === key);
}

function applySettings(entry: InstancesFile["instances"][string], settings: ProfileSettings): void {
  if (settings.protected === true) entry.protected = true;
  if (settings.protected === false) delete entry.protected;
  if (settings.authHeader === null) delete entry.authHeader;
  else if (settings.authHeader !== undefined) entry.authHeader = settings.authHeader;
}

/** `instance set`: change a profile's settings, never its URL (remove and add for that). */
export function updateInstance(slug: string, settings: ProfileSettings, env?: NodeJS.ProcessEnv): Instance {
  const file = read(env);
  const entry = file.instances[slug];
  if (entry === undefined) resolveInstance(slug, env); // throws, naming what does exist
  applySettings(entry as InstancesFile["instances"][string], settings);
  writePrivate(instancesPath(env), JSON.stringify(file, null, 2) + "\n");
  return listInstances(env).find((i) => i.slug === slug) as Instance;
}

export function validateSlug(slug: string): string {
  const s = slug.toLowerCase();
  if (!SLUG.test(s)) {
    throw new UsageError(`invalid instance name '${slug}'`, {
      hint: "Use letters, digits, '-' and '_', starting with a letter or digit (at most 63 characters).",
    });
  }
  return s;
}

/** Check and canonicalise a URL before it is stored; only http(s) targets make sense. */
export function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`not a URL: '${url}'`, { hint: "Give the full address, e.g. https://app.example.org" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`unsupported scheme '${parsed.protocol}' in '${url}'`, { hint: "Use an http or https URL." });
  }
  assertNoUserInfo(url);
  return normalizeUrl(url);
}

/**
 * Refuse a URL that carries a user name or password (REQ-074).
 *
 * Every target URL is printed somewhere — `-v` traces, `--explain`, error messages, `instance list`
 * — so a credential inside one would leak through all of them. The message never repeats the URL.
 * An unparseable URL is left to the code that uses it.
 */
export function assertNoUserInfo(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UsageError("the target URL contains a user name or password", {
      hint:
        "Credentials never go in a URL: it is printed by traces, --explain and error messages.\n" +
        "Give the address only, then run `signum auth login --url <address>`.",
    });
  }
}

export function addInstance(slug: string, url: string, env?: NodeJS.ProcessEnv, settings: ProfileSettings = {}): Instance {
  const file = read(env);
  const existing = file.instances[slug];
  if (existing !== undefined) {
    throw new UsageError(`instance '${slug}' already exists (${existing.url})`, {
      hint: `Remove it first with \`signum instance remove ${slug}\`, or choose another name.`,
    });
  }
  const entry = { url };
  applySettings(entry, settings);
  file.instances[slug] = entry;
  writePrivate(instancesPath(env), JSON.stringify(file, null, 2) + "\n");
  return listInstances(env).find((i) => i.slug === slug) as Instance;
}

export function removeInstance(slug: string, env?: NodeJS.ProcessEnv): Instance | undefined {
  const file = read(env);
  const existing = file.instances[slug];
  if (existing === undefined) return undefined;
  delete file.instances[slug];
  writePrivate(instancesPath(env), JSON.stringify(file, null, 2) + "\n");
  return { slug, url: existing.url };
}

/** The instance a URL is registered as, if any — to name the target the way the user does. */
export function instanceForUrl(url: string, env?: NodeJS.ProcessEnv): string | undefined {
  return profileForUrl(url, env)?.slug;
}

/** The URL a slug names, or a UsageError that says what does exist. */
export function resolveInstance(slug: string, env?: NodeJS.ProcessEnv): string {
  const all = listInstances(env);
  const found = all.find((i) => i.slug === slug.toLowerCase());
  if (found !== undefined) return found.url;
  const near = nearest(slug.toLowerCase(), all.map((i) => i.slug));
  throw new UsageError(`unknown instance '${slug}'`, {
    hint: all.length === 0
      ? "No instances are registered. Add one with `signum instance add <name> <url>`."
      : (near !== undefined ? `Did you mean '${near}'? ` : "") +
        `Registered: ${all.map((i) => i.slug).join(", ")}. See \`signum instance list\`.`,
  });
}
