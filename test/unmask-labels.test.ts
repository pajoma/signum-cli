/**
 * Labels in the handle store — `unmask` producing a document a human can read (#106).
 *
 * #102 restored the IDENTITY a handle stood for, so a report came back full of `Project;20`, which is
 * correct and still unreadable. This captures the display string at the moment the handle is minted —
 * the last point at which the CLI holds both — and substitutes it instead.
 *
 * One correction to the issue's premise, found by reading the framework: the label is NOT `toStr`. A
 * `Lite` on the wire has no such field (`LiteJsonConverter.cs:26-64`); the display string travels in
 * `model`, as a bare string when the model type is the default. So the capture point is right but the
 * field is different.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../src/cli.ts";
import { loadHandleEntries, saveHandles, stripStoredLabels } from "../src/core/config.ts";
import { ExitCode } from "../src/core/errors.ts";
import {
  createRecorder, resolveHandlesInText, resolvePolicy, surrogate,
} from "../src/core/privacy.ts";
import { sanitizeSegment } from "../src/core/textfiles.ts";

let dir: string;
let work: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-lbl-cfg-"));
  work = mkdtempSync(join(tmpdir(), "signum-lbl-work-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const env = () => ({ SIGNUM_CONFIG_DIR: dir }) as unknown as NodeJS.ProcessEnv;
const policy = () => resolvePolicy({ callerIsAgent: true, acknowledged: false, env: env() });

interface Result { code: ExitCode; out: string; err: string }
async function cli(argv: string[], extraEnv: Record<string, string> = {}, tty = true): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; }, err: (s) => { err += s; },
    stdoutIsTty: tty, stdinIsTty: false,
    env: { SIGNUM_CONFIG_DIR: dir, ...extraEnv } as NodeJS.ProcessEnv,
    readStdin: async () => "",
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

function file(name: string, contents: string): string {
  const p = join(work, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("capture at mint time", () => {
  it("takes the label from a Lite's `model`, not from `toStr`", () => {
    // The wire shape is the load-bearing fact here: a Lite has EntityType, id, and optionally
    // ModelType/partitionId/model/entity. There is no `toStr` on a Lite at all.
    const rec = createRecorder();
    const lite = { EntityType: "Project", id: 20, model: "Website Relaunch" };
    const handle = String(surrogate(lite, "Entity", policy(), rec));
    expect(rec.detailed()[handle]).toEqual({ lite: "Project;20", label: "Website Relaunch" });
  });

  it("records no label when the Lite carried none", () => {
    const rec = createRecorder();
    const handle = String(surrogate({ EntityType: "Project", id: 20 }, "Entity", policy(), rec));
    expect(rec.detailed()[handle]).toEqual({ lite: "Project;20" });
  });

  it("ignores a ModelEntity object, which is structured data and not a name", () => {
    // Flattening an object to a label would be a guess, and a wrong label is worse than none.
    const rec = createRecorder();
    const lite = { EntityType: "Project", id: 20, model: { Type: "ProjectModel", code: "X" } };
    const handle = String(surrogate(lite, "Entity", policy(), rec));
    expect(rec.detailed()[handle]?.label).toBeUndefined();
  });

  it("does not lose a label because a later row lacked one", () => {
    // One row may carry the display string and the next may not; the answer must not depend on row
    // order, which it would if `record` overwrote unconditionally.
    const rec = createRecorder();
    const p = policy();
    surrogate({ EntityType: "Project", id: 20, model: "Website Relaunch" }, "Entity", p, rec);
    const handle = String(surrogate({ EntityType: "Project", id: 20 }, "Entity", p, rec));
    expect(rec.detailed()[handle]?.label).toBe("Website Relaunch");
  });
});

describe("the store reads both shapes", () => {
  it("reads a legacy bare-string entry as an entry with no label", () => {
    // Existing stores hold thousands of these; discarding them would orphan every handle in
    // circulation, which is the failure AC-53.5 exists to prevent.
    writeFileSync(join(dir, "handles.json"), JSON.stringify({ ref_aaaaaaaaaaaa: "User;42" }), "utf8");
    expect(loadHandleEntries(env())).toEqual({ ref_aaaaaaaaaaaa: { lite: "User;42" } });
  });

  it("round-trips a label through save and load", () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "User;42", label: "Alexandra Weber" } }, env(), { now: "2026-07-30T00:00:00Z" });
    const e = loadHandleEntries(env())["ref_aaaaaaaaaaaa"];
    expect(e?.label).toBe("Alexandra Weber");
    expect(e?.seen).toBe("2026-07-30T00:00:00Z");
  });

  it("a changed LABEL updates in place; a changed IDENTITY is still a collision", () => {
    // Someone can be renamed, so a differing label is not a mismatch. A differing identity is.
    saveHandles({ ref_a: { lite: "User;42", label: "Old Name" } }, env());
    expect(saveHandles({ ref_a: { lite: "User;42", label: "New Name" } }, env())).toEqual([]);
    expect(loadHandleEntries(env())["ref_a"]?.label).toBe("New Name");
    expect(saveHandles({ ref_a: { lite: "User;99" } }, env())).toEqual(["ref_a"]);
  });

  it("storeLabels:false keeps the identity and drops the label", () => {
    saveHandles({ ref_a: { lite: "User;42", label: "Alexandra Weber" } }, env(), { storeLabels: false });
    const e = loadHandleEntries(env())["ref_a"];
    expect(e?.lite).toBe("User;42");
    expect(e?.label).toBeUndefined();
  });

  it("stripStoredLabels retro-fits an existing store", () => {
    saveHandles({ ref_a: { lite: "User;42", label: "A" }, ref_b: { lite: "User;43" } }, env());
    expect(stripStoredLabels(env())).toBe(1);
    expect(loadHandleEntries(env())["ref_a"]?.label).toBeUndefined();
    expect(loadHandleEntries(env())["ref_a"]?.lite).toBe("User;42");
  });
});

describe("substitution prefers the label", () => {
  const handles = { ref_aaaaaaaaaaaa: "Project;20", ref_bbbbbbbbbbbb: "User;42" };
  const labels = { ref_aaaaaaaaaaaa: "Website Relaunch" };

  it("substitutes the label where known and the identity where not, reporting the gap", () => {
    const r = resolveHandlesInText(
      "Project ref_aaaaaaaaaaaa owner ref_bbbbbbbbbbbb",
      handles,
      { labels, preferLabel: true },
    );
    expect(r.text).toBe("Project Website Relaunch owner User;42");
    // Never silent: a `User;42` where a name was asked for is otherwise indistinguishable from a
    // label that happens to look like a Lite key.
    expect(r.labelless).toEqual(["ref_bbbbbbbbbbbb"]);
  });

  it("--labels identity substitutes the key even when a label is known", () => {
    const r = resolveHandlesInText("ref_aaaaaaaaaaaa", handles, { labels, preferLabel: false });
    expect(r.text).toBe("Project;20");
    expect(r.labelless).toEqual([]);
  });

  it("escapes `|` so a label cannot destroy a markdown table row", () => {
    const r = resolveHandlesInText(
      "| ref_aaaaaaaaaaaa | 12 |",
      handles,
      { labels: { ref_aaaaaaaaaaaa: "A|B" }, preferLabel: true, escapeMarkdownPipes: true },
    );
    expect(r.text).toBe("| A\\|B | 12 |");
    // The cell count is what actually matters — an unescaped pipe shifts every cell after it.
    expect(r.text.split(/(?<!\\)\|/).length).toBe("| x | 12 |".split("|").length);
  });

  it("finds a label stored under the other prefix spelling", () => {
    const r = resolveHandlesInText("ref:aaaaaaaaaaaa", { "ref:aaaaaaaaaaaa": "Project;20" }, {
      labels: { ref_aaaaaaaaaaaa: "Website Relaunch" }, preferLabel: true,
    });
    expect(r.text).toBe("Website Relaunch");
  });
});

describe("a label used as a path segment is made legal", () => {
  it("replaces Windows-reserved characters and both separators", () => {
    expect(sanitizeSegment('Projekt: A/B "x" <y>|z?*\\w')).toBe("Projekt- A-B -x- -y--z---w");
  });

  it("drops a trailing dot or space, which Windows would strip silently", () => {
    expect(sanitizeSegment("Report.")).toBe("Report");
    expect(sanitizeSegment("Report ")).toBe("Report");
  });

  it("truncates, and never yields an empty or meaningful-to-the-filesystem name", () => {
    expect(sanitizeSegment("a".repeat(200)).length).toBe(80);
    expect(sanitizeSegment("...")).toBe("_");
    expect(sanitizeSegment("")).toBe("_");
    expect(sanitizeSegment("..")).toBe("_");
  });

  it("keeps spaces and non-ASCII, which are legal everywhere", () => {
    expect(sanitizeSegment("Grüße Straße")).toBe("Grüße Straße");
  });
});

describe("end to end through the command", () => {
  it("unmask --in substitutes labels by default", async () => {
    saveHandles({
      ref_aaaaaaaaaaaa: { lite: "Project;20", label: "Website Relaunch" },
      ref_bbbbbbbbbbbb: { lite: "User;42" },
    }, env());
    file("report.md", "| Projekt | Person |\n|---|---|\n| ref_aaaaaaaaaaaa | ref_bbbbbbbbbbbb |\n");
    const r = await cli(["unmask", "--in", work]);
    expect(r.code).toBe(ExitCode.Ok);
    const out = readFileSync(join(work, "report.local.md"), "utf8");
    expect(out).toContain("Website Relaunch");
    // The label-less one fell back to the identity AND was named.
    expect(out).toContain("User;42");
    expect(r.err).toContain("had no stored label");
    expect(r.err).toContain("ref_bbbbbbbbbbbb");
  });

  it("--labels identity reproduces the pre-#106 behaviour exactly", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20", label: "Website Relaunch" } }, env());
    file("report.md", "ref_aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work, "--labels", "identity"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(readFileSync(join(work, "report.local.md"), "utf8")).toBe("Project;20");
  });

  it("rejects an unknown --labels mode rather than guessing", async () => {
    const r = await cli(["unmask", "--in", work, "--labels", "sometimes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("unknown --labels mode");
  });

  it("unmask <ref_…> reports identity AND label", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20", label: "Website Relaunch" } }, env());
    const r = await cli(["unmask", "ref_aaaaaaaaaaaa"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Project;20");
    expect(r.out).toContain("Website Relaunch");
  });

  it("unmask <ref_…> says when it has no label, rather than looking complete", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20" } }, env());
    const r = await cli(["unmask", "ref_aaaaaaaaaaaa"]);
    expect(r.out).toContain("Project;20");
    expect(r.err).toContain("no stored label");
  });

  it("a label containing a pipe does not corrupt the table it lands in", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20", label: "A|B Projekt" } }, env());
    file("t.md", "| Projekt | N |\n|---|---|\n| ref_aaaaaaaaaaaa | 1 |\n");
    await cli(["unmask", "--in", work]);
    const out = readFileSync(join(work, "t.local.md"), "utf8");
    const dataRow = out.split("\n")[2] as string;
    // Same number of real cell separators as the header, which is the property that matters.
    const cells = (s: string): number => s.split(/(?<!\\)\|/).length;
    expect(cells(dataRow)).toBe(cells(out.split("\n")[0] as string));
  });
});

describe("labels in file and folder names", () => {
  it("renames using the sanitised label, not the raw one", async () => {
    // The raw label contains a path separator and a Windows-reserved character; neither may reach
    // the filesystem, and sanitising the whole segment afterwards would also mangle what the caller
    // wrote around the handle.
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20", label: "A/B: Relaunch" } }, env());
    writeFileSync(join(work, "report-ref_aaaaaaaaaaaa.md"), "x", "utf8");
    const r = await cli(["unmask", "--in", work, "--in-place"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(work, "report-A-B- Relaunch.md"))).toBe(true);
  });

  it("still never overwrites an existing name", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20", label: "Relaunch" } }, env());
    writeFileSync(join(work, "ref_aaaaaaaaaaaa.md"), "new", "utf8");
    writeFileSync(join(work, "Relaunch.md"), "PRE-EXISTING", "utf8");
    const r = await cli(["unmask", "--in", work, "--in-place"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(readFileSync(join(work, "Relaunch.md"), "utf8")).toBe("PRE-EXISTING");
    expect(r.out).toContain("NOT renamed");
  });

  it("truncates a very long label in a name", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20", label: "L".repeat(300) } }, env());
    writeFileSync(join(work, "ref_aaaaaaaaaaaa.md"), "x", "utf8");
    const r = await cli(["unmask", "--in", work, "--in-place"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(work, `${"L".repeat(80)}.md`))).toBe(true);
  });
});

describe("--labels fetch fills the gaps", () => {
  // Every handle minted before this feature has no label — a real store here has thousands in that
  // state — so an offline-only design would never become useful for existing data.
  let server: ReturnType<typeof Bun.serve>;
  const requests: Array<{ queryKey: string; filters: unknown }> = [];

  beforeEach(() => {
    requests.length = 0;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const h = { "content-type": "application/json" };
        if (url.pathname.startsWith("/api/query/executeQuery/")) {
          const body = (await req.json()) as { queryKey: string; filters: unknown };
          requests.push(body);
          const rows = body.queryKey === "Project"
            ? [{ columns: [20, "Website Relaunch"] }, { columns: [21, "Intranet"] }]
            : [{ columns: [42, "Alexandra Weber"] }];
          return new Response(JSON.stringify({ columns: ["Id", "Entity.ToString"], rows }), { headers: h });
        }
        return new Response(JSON.stringify({ exceptionMessage: "unhandled" }), { status: 404, headers: h });
      },
    });
  });
  afterEach(() => server.stop(true));

  const url = (): string => `http://127.0.0.1:${server.port}`;

  it("batches by entity type — one round trip per type, not per handle", async () => {
    saveHandles({
      ref_aaaaaaaaaaaa: { lite: "Project;20" },
      ref_bbbbbbbbbbbb: { lite: "Project;21" },
      ref_cccccccccccc: { lite: "User;42" },
    }, env());
    file("r.md", "ref_aaaaaaaaaaaa ref_bbbbbbbbbbbb ref_cccccccccccc");
    const r = await cli(["unmask", "--in", work, "--labels", "fetch", "--url", url()], { SIGNUM_TOKEN: "t" });
    expect(r.code).toBe(ExitCode.Ok);
    // Two types, two requests — three handles.
    expect(requests).toHaveLength(2);
    const out = readFileSync(join(work, "r.local.md"), "utf8");
    expect(out).toBe("Website Relaunch Intranet Alexandra Weber");
  });

  it("caches what it fetched, so a second run needs no request", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20" } }, env());
    file("r.md", "ref_aaaaaaaaaaaa");
    await cli(["unmask", "--in", work, "--labels", "fetch", "--url", url()], { SIGNUM_TOKEN: "t" });
    expect(loadHandleEntries(env())["ref_aaaaaaaaaaaa"]?.label).toBe("Website Relaunch");
    requests.length = 0;
    const again = await cli(["unmask", "--in", work, "--url", url()], { SIGNUM_TOKEN: "t" });
    expect(again.code).toBe(ExitCode.Ok);
    expect(requests).toHaveLength(0); // `stored` is the default and makes no call
  });

  it("the default makes no network call at all", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20" } }, env());
    file("r.md", "ref_aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work, "--url", url()], { SIGNUM_TOKEN: "t" });
    expect(r.code).toBe(ExitCode.Ok);
    expect(requests).toHaveLength(0);
    expect(readFileSync(join(work, "r.local.md"), "utf8")).toBe("Project;20");
  });

  it("uses fetched labels for the run but does not store them when storeLabels is false", async () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ storeLabels: false }), "utf8");
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20" } }, env());
    file("r.md", "ref_aaaaaaaaaaaa");
    const r = await cli(["unmask", "--in", work, "--labels", "fetch", "--url", url()], { SIGNUM_TOKEN: "t" });
    expect(r.code).toBe(ExitCode.Ok);
    // Substituted in the output...
    expect(readFileSync(join(work, "r.local.md"), "utf8")).toBe("Website Relaunch");
    // ...and deliberately not written down.
    expect(loadHandleEntries(env())["ref_aaaaaaaaaaaa"]?.label).toBeUndefined();
  });

  it("sends the ids for the type and no surrogate, which is what keeps the promise", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: { lite: "Project;20" } }, env());
    file("r.md", "ref_aaaaaaaaaaaa");
    await cli(["unmask", "--in", work, "--labels", "fetch", "--url", url()], { SIGNUM_TOKEN: "t" });
    const sent = JSON.stringify(requests[0]);
    expect(sent).toContain('"IsIn"');
    expect(sent).toContain("20");
    // The mapping is what must never leave the machine; the handle itself must not be on the wire.
    expect(sent).not.toContain("ref_");
  });
});
