/**
 * Cross-platform release build — issue #56 / REQ-073.
 *
 * Bun `--compile --target=<t>` cross-compiles every target from a single host (measured on
 * Linux, ADR 0006), so this is one job rather than a per-OS runner matrix. Produces one binary
 * per target under dist/ plus a SHA256SUMS manifest.
 *
 * `bun scripts/build-all.ts [version] [--targets=a,b]`  — version is stamped into the file names.
 */

import { $ } from "bun";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface Target {
  /** bun --target value */
  bun: string;
  /** artifact os-arch label */
  label: string;
  exe: boolean;
}

/**
 * Start with linux-x64 (REQ-073's "first"); the rest build fine from Linux too, so the workflow
 * ships them. Trim this list, not the workflow, to change platform coverage.
 *
 * Linux targets are glibc (`bun-linux-*`), not musl: the target users run mainstream distros
 * (the deployment is RHEL/glibc), where a glibc binary "just works" — a musl build links
 * `/lib/ld-musl-*` and fails to start on a glibc box. Add a musl variant only if Alpine support
 * is actually needed.
 */
const TARGETS: Target[] = [
  { bun: "bun-linux-x64", label: "linux-x64", exe: false },
  { bun: "bun-linux-arm64", label: "linux-arm64", exe: false },
  { bun: "bun-darwin-x64", label: "darwin-x64", exe: false },
  { bun: "bun-darwin-arm64", label: "darwin-arm64", exe: false },
  { bun: "bun-windows-x64", label: "windows-x64", exe: true },
];

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--")) ?? "dev";
  const only = args.find((a) => a.startsWith("--targets="))?.slice("--targets=".length);
  const targets = only !== undefined ? TARGETS.filter((t) => only.split(",").includes(t.label)) : TARGETS;
  if (targets.length === 0) throw new Error(`no matching targets in: ${only}`);

  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });

  const sums: string[] = [];
  for (const t of targets) {
    const name = `signum-${version}-${t.label}${t.exe ? ".exe" : ""}`;
    const out = `dist/${name}`;
    process.stdout.write(`building ${t.label} (${t.bun}) → ${name}\n`);
    // --minify keeps size down; the runtime is the bulk regardless (ADR 0006).
    await $`bun build --compile --minify --target=${t.bun} --outfile ${out} src/cli.ts`.quiet();
    const bytes = (await stat(out)).size;
    const digest = await sha256(out);
    sums.push(`${digest}  ${name}`);
    process.stdout.write(`  ${(bytes / 1_048_576).toFixed(0)} MB  ${digest.slice(0, 12)}…\n`);
  }

  await writeFile("dist/SHA256SUMS", sums.join("\n") + "\n");
  process.stdout.write(`\nwrote dist/SHA256SUMS (${sums.length} artifact${sums.length === 1 ? "" : "s"})\n`);
}

await main();
