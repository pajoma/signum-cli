/**
 * Release version gate (issue #56). Tag ↔ package.json ↔ channel contract.
 */

import { describe, expect, it } from "bun:test";
import { isPrerelease, validateRelease, versionFromTag, ReleaseError } from "../scripts/release-version.ts";

describe("versionFromTag", () => {
  it("strips a leading v and refs/tags/", () => {
    expect(versionFromTag("v0.1.1")).toBe("0.1.1");
    expect(versionFromTag("refs/tags/v0.1.1-b.1")).toBe("0.1.1-b.1");
    expect(versionFromTag("0.1.1")).toBe("0.1.1");
  });
});

describe("isPrerelease", () => {
  it("recognises SemVer pre-release components", () => {
    expect(isPrerelease("0.1.1")).toBe(false);
    expect(isPrerelease("0.1.1-b.1")).toBe(true);
    expect(isPrerelease("0.1.1-beta.1")).toBe(true);
    expect(isPrerelease("0.1.1-rc.2")).toBe(true);
  });
  it("throws on non-SemVer", () => {
    expect(() => isPrerelease("0.1.1b1")).toThrow(ReleaseError); // PEP 440, not SemVer
  });
});

describe("validateRelease — happy paths", () => {
  it("accepts a matching release tag on the release channel", () => {
    expect(validateRelease("v0.1.1", "0.1.1", "release")).toEqual({ version: "0.1.1", isPrerelease: false });
  });
  it("accepts a matching pre-release tag on the pre-release channel", () => {
    expect(validateRelease("v0.1.1-b.1", "0.1.1-b.1", "prerelease")).toEqual({ version: "0.1.1-b.1", isPrerelease: true });
  });
});

describe("validateRelease — the contract violations it must catch", () => {
  it("rejects PEP 440 tags with a message pointing at SemVer", () => {
    expect(() => validateRelease("v0.1.1b1", "0.1.1b1", "prerelease")).toThrow(/not SemVer/);
  });

  it("rejects a tag that does not match package.json (source of truth)", () => {
    expect(() => validateRelease("v0.1.2", "0.1.1", "release")).toThrow(/does not match package.json/);
  });

  it("rejects a plain release tag on the pre-release (develop) channel", () => {
    expect(() => validateRelease("v0.1.1", "0.1.1", "prerelease")).toThrow(/no pre-release component/);
  });

  it("rejects a pre-release tag on the release (main) channel", () => {
    expect(() => validateRelease("v0.1.1-b.1", "0.1.1-b.1", "release")).toThrow(/is a pre-release/);
  });

  it("rejects an invalid package.json version", () => {
    expect(() => validateRelease("v0.1.1", "not-a-version", "release")).toThrow(/package.json version/);
  });
});
