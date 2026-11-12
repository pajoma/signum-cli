/**
 * The real terminal behind `Io`: stdout and stderr, stdin read strictly as UTF-8, a prompt that can
 * hide what is typed, and Ctrl-C. Everything else in the CLI talks to `Io` only, which is what lets
 * the tests drive it without a terminal.
 */

import { UsageError } from "./core/errors.ts";
import { decodeUtf8 } from "./core/input.ts";
import type { Io } from "./core/ctx.ts";

/** The process's own terminal, as an `Io`. */
export function terminalIo(): Io {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    env: process.env,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      // UTF-8 strictly, whatever the platform's codepage: invalid bytes are refused, not replaced (#120).
      return decodeUtf8(Buffer.concat(chunks), "stdin");
    },
    ...(process.stdin.isTTY === true ? { prompt: promptAtTerminal } : {}),
    onInterrupt: (handler) => {
      process.on("SIGINT", handler);
      return () => { process.off("SIGINT", handler); };
    },
  };
}

/**
 * Read one line from the terminal, optionally without echoing it.
 *
 * Only offered when stdin is a TTY, so it can never hang a pipeline. A hidden read uses raw mode and
 * writes nothing back, so a pasted credential reaches neither the screen nor the shell's history —
 * which is what AC-12.1 is protecting, and why refusing to prompt at all was the wrong reading of it.
 *
 * The prompt goes to STDERR: stdout is reserved for data (AC-22.2), and a prompt is not data.
 */
async function promptAtTerminal(question: string, opts: { hidden?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);

  const hidden = opts.hidden === true;
  const wasRaw = stdin.isRaw === true;
  if (hidden) stdin.setRawMode(true);
  stdin.resume();

  try {
    return await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: Buffer | string): void => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") { cleanup(); resolve(buffer); return; }
          if (ch === "\u0003") { cleanup(); reject(new UsageError("cancelled")); return; } // Ctrl-C
          if (ch === "\u007f" || ch === "\b") { buffer = buffer.slice(0, -1); continue; }
          if (ch < " ") continue; // ignore other control characters rather than storing them
          buffer += ch;
        }
        // Not raw: the terminal delivers whole lines, so anything here is already complete.
        if (!hidden) { cleanup(); resolve(buffer); }
      };
      const onAbort = (): void => { cleanup(); resolve(""); };
      const cleanup = (): void => {
        stdin.off("data", onData);
        opts.signal?.removeEventListener("abort", onAbort);
        if (hidden) { stdin.setRawMode(wasRaw); process.stderr.write("\n"); }
        stdin.pause();
      };
      // Withdrawn: the answer came another way (AC-12.9), so stop reading the terminal.
      if (opts.signal?.aborted === true) { cleanup(); resolve(""); return; }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      stdin.on("data", onData);
    });
  } finally {
    if (hidden && stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
  }
}
