/**
 * `signum version` — REQ-076 (partial), STORY-60
 *
 * Works with no configuration at all; reports the target app's version only when a URL is
 * available and reachable.
 */

import type { Ctx } from "../cli.ts";
import { ExitCode } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import { loadCredential } from "../core/config.ts";
import { SignumHttp } from "../core/http.ts";

// M4 (Brooks review): single source of truth — read the version from package.json rather
// than a second hardcoded copy that silently drifts. Bun bundles the JSON import into the
// compiled binary, so this stays self-contained.
import pkg from "../../package.json" with { type: "json" };
export const CLI_VERSION: string = pkg.version;

export async function runVersion(ctx: Ctx): Promise<ExitCode> {
  const stored = loadCredential(ctx.io.env);
  const url = ctx.args.flags.url ?? stored?.credential.url;

  let server: { url: string; reachable: boolean; detail: string | undefined } | undefined;

  if (url !== undefined) {
    const http = new SignumHttp({
      baseUrl: url,
      timeoutMs: ctx.args.flags.timeoutMs ?? 8000,
      trace: ctx.args.flags.verbose ? (l) => ctx.io.err(l) : undefined,
      env: ctx.io.env,
    });
    try {
      // Anonymous endpoint, so this works without credentials.
      const res = await http.request<unknown>({
        method: "GET",
        path: "api/reflection/types",
        allowAnonymous: true,
      });
      const count = res.body !== null && typeof res.body === "object"
        ? Object.keys(res.body as Record<string, unknown>).length
        : 0;
      server = { url, reachable: true, detail: `${count} types` };
    } catch (err) {
      server = { url, reachable: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument({ cli: CLI_VERSION, target: server ?? null }, { format: ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }

  ctx.io.out(`signum ${CLI_VERSION}\n`);
  if (server !== undefined) {
    ctx.io.out(
      server.reachable
        ? `target  ${server.url} (reachable, ${server.detail})\n`
        : `target  ${server.url} (unreachable: ${server.detail})\n`,
    );
  }
  return ExitCode.Ok;
}
