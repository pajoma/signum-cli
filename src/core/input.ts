/**
 * Structured input from a file or stdin: `@path`, `-`, or the value itself (REQ-054, #120).
 *
 * One reader for every flag that takes structured input, so `@`-versus-`-`-versus-literal is decided
 * in one place:
 *   - `-` is stdin. It can be read once, so a second flag asking for it is a usage error naming both,
 *     never a hang. At a terminal it is refused: nothing is piped, and waiting for a person to type
 *     JSON and press Ctrl-D is a hang by another name (STORY-09).
 *   - `@path` is a file. A missing or unreadable one is a usage error naming the path and the flag,
 *     never a raw ENOENT.
 *   - Anything else is the value itself — or, for a flag whose value is conventionally a path
 *     (`-f`, `--filter-json`), a path.
 *
 * Bytes are decoded as UTF-8 whatever the platform's codepage, strictly: invalid UTF-8 is refused
 * rather than turned into U+FFFD and sent (the lesson of #102). A leading byte-order mark is dropped,
 * since Windows editors write one and `JSON.parse` rejects it.
 */

import { readFileSync } from "node:fs";
import type { Io } from "./ctx.ts";
import { UsageError } from "./errors.ts";

export interface InputReader {
  /**
   * The text `value` stands for, read for `--<flag>`. `bare` says what a value that is neither `-`
   * nor `@path` is: the input itself (the default) or a path to it.
   */
  read(flag: string, value: string, opts?: { bare?: "literal" | "path" }): Promise<string>;
}

/** Whether `value` would be read from somewhere rather than taken as it is. */
export function isIndirect(value: string): boolean {
  return value === "-" || (value.startsWith("@") && value.length > 1);
}

function flagName(flag: string): string {
  return flag.length === 1 ? `-${flag}` : `--${flag}`;
}

/** Strict UTF-8, without a byte-order mark. */
export function decodeUtf8(bytes: Uint8Array, source: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError(`${source} is not valid UTF-8`, {
      hint: "Save it as UTF-8. Input is read as UTF-8 whatever the system's codepage, so nothing is guessed.",
    });
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readPath(flag: string, path: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "no such file"
      : code === "EISDIR" ? "it is a directory"
      : code === "EACCES" || code === "EPERM" ? "permission denied"
      : err instanceof Error ? err.message : String(err);
    throw new UsageError(`could not read ${flagName(flag)} file '${path}': ${why}`, {
      hint: `${flagName(flag)} @<file> reads a file, and ${flagName(flag)} - reads stdin.`,
    });
  }
  return decodeUtf8(bytes, `${flagName(flag)} file '${path}'`);
}

/** A reader for one command run. Stdin is claimed by the first flag that reads it. */
export function inputReader(io: Io): InputReader {
  let stdinFlag: string | undefined;
  return {
    async read(flag, value, opts = {}) {
      if (value === "-") {
        if (stdinFlag !== undefined) {
          throw new UsageError(`${flagName(stdinFlag)} and ${flagName(flag)} both read stdin, which can be read only once`, {
            hint: `Give one of them a file instead: ${flagName(flag)} @<file>.`,
          });
        }
        if (io.stdinIsTty) {
          throw new UsageError(`${flagName(flag)} - reads stdin, but stdin is a terminal and nothing is piped`, {
            hint: `Pipe the input in, or pass a file: ${flagName(flag)} @<file>.`,
          });
        }
        stdinFlag = flag;
        // `readStdin` decodes strictly as UTF-8 (`decodeUtf8`, via cli.ts); only the BOM is left.
        const text = await io.readStdin();
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      }
      if (value.startsWith("@") && value.length > 1) return readPath(flag, value.slice(1));
      return opts.bare === "path" ? readPath(flag, value) : value;
    },
  };
}
