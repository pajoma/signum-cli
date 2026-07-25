#!/usr/bin/env python3
"""Rebuild the 47 requirement issue bodies from docs/requirements.md.

Drops the acceptance-criteria stub: these are requirements, not user stories.
Run with --apply to actually edit issues (default is a dry run).
"""
import re, subprocess, sys, json, pathlib

DOC = pathlib.Path("docs/requirements.md")
REPO = "pajoma/signum-cli"
APPLY = "--apply" in sys.argv

row = re.compile(r"^\|\s*(REQ-\d+)\s*\|\s*(v1|v2|spike)\s*\|\s*(.+?)\s*\|\s*$")
section = re.compile(r"^##\s+([A-H])\.\s+(.+?)\s*$")

reqs, cur = {}, "?"
for line in DOC.read_text(encoding="utf-8").splitlines():
    m = section.match(line)
    if m:
        cur = f"{m.group(1)}. {m.group(2)}"
        continue
    m = row.match(line)
    if m:
        rid, prio, stmt = m.groups()
        t = re.match(r"\*\*(.+?)\*\*\s*(.*)$", stmt)
        if not t:
            sys.exit(f"FATAL: {rid} has no bold title")
        reqs[rid] = dict(id=rid, prio=prio, section=cur,
                         title=t.group(1).rstrip("."), body=t.group(2).strip())

created = json.loads(pathlib.Path("/tmp/created-issues.json").read_text())
missing = [c["id"] for c in created if c["id"] not in reqs]
if missing:
    sys.exit(f"FATAL: issues exist for ids no longer in the doc: {missing}")

def body_for(r):
    return f"""**Requirement {r['id']}** · priority `{r['prio']}` · area _{r['section']}_

{r['body']}

---

Mirrored from `docs/requirements.md`, which is the source of truth — edit there and keep this
issue in sync. Requirement IDs are stable; issue numbers are not a substitute for them.

This is a **requirement**, not a user story: it states what the CLI must do, and carries no
acceptance criteria. Implementation work is tracked separately and references this ID.

Nothing in the design docs has been verified against a running Signum application yet; claims
are read from framework source at `74bd24693d`.
"""

print(f"{len(created)} issues to update\n")
if not APPLY:
    r = reqs[created[0]["id"]]
    print(f"--- sample new body for #{created[0]['number']} ---")
    print(body_for(r))
    print("DRY RUN. Re-run with --apply.")
    sys.exit(0)

ok = 0
for c in created:
    r = reqs[c["id"]]
    bf = pathlib.Path(f"/tmp/body-{r['id']}.md")
    bf.write_text(body_for(r), encoding="utf-8")
    p = subprocess.run(["gh", "issue", "edit", c["number"], "--repo", REPO,
                        "--body-file", str(bf)], capture_output=True, text=True)
    bf.unlink(missing_ok=True)
    if p.returncode != 0:
        print(f"  FAILED #{c['number']} {r['id']}: {p.stderr.strip()[:160]}")
    else:
        ok += 1
        print(f"  updated #{c['number']:>3}  {r['id']}")
print(f"\n{ok}/{len(created)} updated")
