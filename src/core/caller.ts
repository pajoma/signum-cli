/**
 * Caller-context detection.
 *
 * REQ-056 · STORY-50 · ADR 0007
 *
 * ⚠️  THIS IS NOT A SECURITY BOUNDARY.
 *
 * Every signal below is spoofable in both directions and absent for unknown agents:
 * env vars can be set or unset, and `bash -c` launders the parent process. Detection may
 * only ever be used to pick a *stricter* default (AC-50.6). If you find yourself relying
 * on it to guarantee something, the design is wrong.
 *
 * Therefore it FAILS CLOSED: anything not provably interactive is at least `automated`.
 */

import { readFileSync } from "node:fs";
import { UsageError } from "./errors.ts";

export type CallerContext = "interactive" | "automated" | "agent";

/** Env vars observed to indicate an AI caller. Advisory only. */
const AGENT_ENV_VARS = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_TRACE_ID",
  "AIDER_MODEL",
  "GITHUB_COPILOT_AGENT",
] as const;

const AGENT_PROCESS_NAMES = ["claude", "cursor", "aider", "copilot"] as const;

export interface CallerDetection {
  context: CallerContext;
  /** Human-readable signals behind the verdict — surfaced by `auth status` and `--explain` (AC-50.5). */
  signals: string[];
  /** True when the user overrode detection rather than it being observed. */
  overridden: boolean;
  /** Set when the override *loosened* the context; the caller must log it (AC-50.4). */
  loosened: boolean;
}

const STRICTNESS: Record<CallerContext, number> = {
  interactive: 0,
  automated: 1,
  agent: 2,
};

function parentProcessName(): string | undefined {
  // Linux-only and best-effort; absence degrades to the other signals (AC-50.7).
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const ppid = /^PPid:\s*(\d+)/m.exec(status)?.[1];
    if (ppid === undefined || ppid === "0") return undefined;
    return readFileSync(`/proc/${ppid}/comm`, "utf8").trim();
  } catch {
    return undefined;
  }
}

export interface DetectOptions {
  /** True when running as `signum mcp` — the one *definitive* signal (AC-50.2). */
  mcpMode?: boolean;
  /** `--caller-context` / `SIGNUM_CALLER_CONTEXT`. */
  override?: string | undefined;
  env?: NodeJS.ProcessEnv;
  stdoutIsTty?: boolean;
}

export function parseCallerContext(value: string): CallerContext {
  const v = value.trim().toLowerCase();
  if (v === "interactive" || v === "automated" || v === "agent") return v;
  // QA finding: this was a plain Error, which cli.ts's report() classifies as ExitCode.Unexpected
  // (1) and prints "please report it" for — badly misleading for what is just a user typo.
  throw new UsageError(`invalid --caller-context '${value}'`, {
    hint: "Valid values: interactive, automated, agent.",
  });
}

export function detectCallerContext(options: DetectOptions = {}): CallerDetection {
  const env = options.env ?? process.env;
  const stdoutIsTty = options.stdoutIsTty ?? process.stdout.isTTY === true;
  const signals: string[] = [];

  if (options.mcpMode === true) signals.push("running as `signum mcp` (definitive)");

  for (const name of AGENT_ENV_VARS) {
    if (env[name] !== undefined && env[name] !== "") signals.push(`env ${name} is set`);
  }

  const parent = parentProcessName();
  if (parent !== undefined && AGENT_PROCESS_NAMES.some((n) => parent.toLowerCase().includes(n))) {
    signals.push(`parent process is '${parent}'`);
  }

  signals.push(stdoutIsTty ? "stdout is a TTY" : "stdout is not a TTY");

  // Fail closed: `interactive` requires a TTY *and* no agent marker (AC-50.3).
  const agentMarkers = signals.filter((s) => !s.startsWith("stdout is"));
  let detected: CallerContext;
  if (agentMarkers.length > 0) detected = "agent";
  else if (stdoutIsTty) detected = "interactive";
  else detected = "automated";

  const raw = options.override ?? env["SIGNUM_CALLER_CONTEXT"];
  if (raw !== undefined && raw !== "") {
    const forced = parseCallerContext(raw);
    return {
      context: forced,
      signals: [...signals, `overridden to '${forced}'`],
      overridden: true,
      loosened: STRICTNESS[forced] < STRICTNESS[detected],
    };
  }

  return { context: detected, signals, overridden: false, loosened: false };
}
