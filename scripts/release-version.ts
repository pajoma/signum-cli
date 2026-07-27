/**
 * Release version gate — issue #56.
 *
 * Enforces the release contract:
 *   - `package.json` version is the single source of truth.
 *   - A git tag is `v<version>` and MUST match `package.json` exactly.
 *   - SemVer only (not PEP 440): `0.1.1`, `0.1.1-b.1`, `0.1.1-beta.1`.
 *   - A pre-release channel (develop) requires a SemVer pre-release component;
 *     a release channel (main) forbids one.
 *
 * Pure and side-effect-free so it is unit-tested (test/release-version.test.ts) rather than
 * only exercised in CI. The workflow calls `validateRelease` and acts on the result.
 */

export type Channel = "prerelease" | "release";

export interface ReleasePlan {
  version: string;
  isPrerelease: boolean;
}

// SemVer, anchored. Optional pre-release (`-b.1`, `-beta.1`, `-rc.2`) and build metadata (`+…`).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export class ReleaseError extends Error {}

/** Strip a leading `v` from a git tag/ref, if present. Also tolerates `refs/tags/`. */
export function versionFromTag(tag: string): string {
  return tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
}

export function isPrerelease(version: string): boolean {
  const m = SEMVER.exec(version);
  if (m === null) throw new ReleaseError(`'${version}' is not a valid SemVer version`);
  return m[1 + 3] !== undefined; // the pre-release capture group
}

/**
 * Validate a tag against package.json for a given channel. Throws ReleaseError with an
 * actionable message on any mismatch; returns the plan otherwise.
 */
export function validateRelease(tag: string, packageVersion: string, channel: Channel): ReleasePlan {
  const tagVersion = versionFromTag(tag);

  if (SEMVER.exec(tagVersion) === null) {
    throw new ReleaseError(
      `tag '${tag}' is not SemVer. Use v0.1.1 for a release or v0.1.1-b.1 for a pre-release ` +
      `(not PEP 440 '0.1.1b1').`,
    );
  }
  if (SEMVER.exec(packageVersion) === null) {
    throw new ReleaseError(`package.json version '${packageVersion}' is not valid SemVer`);
  }

  // package.json is the source of truth — the tag must match it, the tag does not overwrite it.
  if (tagVersion !== packageVersion) {
    throw new ReleaseError(
      `tag ${tagVersion} does not match package.json ${packageVersion}. ` +
      `Bump package.json first, commit, then tag v${packageVersion}.`,
    );
  }

  const pre = isPrerelease(tagVersion);
  if (channel === "prerelease" && !pre) {
    throw new ReleaseError(
      `'${tagVersion}' has no pre-release component but was tagged on the develop (pre-release) ` +
      `channel. Use e.g. ${tagVersion}-b.1, or cut the release from main.`,
    );
  }
  if (channel === "release" && pre) {
    throw new ReleaseError(
      `'${tagVersion}' is a pre-release but was tagged on the main (release) channel. ` +
      `Drop the pre-release suffix, or cut it from develop.`,
    );
  }

  return { version: tagVersion, isPrerelease: pre };
}

// CLI entry: `bun scripts/release-version.ts <tag> <channel>`, reads package.json itself.
// Prints `version=…` and `prerelease=true|false` for the workflow to capture; exits non-zero
// on any violation.
if (import.meta.main) {
  const [tag, channel] = process.argv.slice(2);
  if (tag === undefined || (channel !== "prerelease" && channel !== "release")) {
    process.stderr.write("usage: release-version.ts <tag> <prerelease|release>\n");
    process.exit(2);
  }
  try {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default as { version: string };
    const plan = validateRelease(tag, pkg.version, channel);
    process.stdout.write(`version=${plan.version}\nprerelease=${plan.isPrerelease}\n`);
  } catch (err) {
    process.stderr.write(`release version check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
