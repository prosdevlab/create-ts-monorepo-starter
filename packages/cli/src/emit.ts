import { writeSync } from 'node:fs';
import { crashJson } from './json.js';
import { FAILURE } from './outcome.js';

export interface WriteDeps {
  /** `fs.writeSync`: returns how many bytes it wrote, which can be fewer than asked. */
  write?: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  /** Blocks for `ms` milliseconds. */
  sleep?: (ms: number) => void;
  now?: () => number;
  fd?: number;
}

const DEADLINE = 5000;
const FIRST_WAIT = 10;
const LONGEST_WAIT = 200;

/** Blocks the thread: the write must finish before an interrupt's `process.exit`. */
const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Writes all of `text` to stdout synchronously, so a `process.exit` right after can't cut it
 * short. A full pipe (`EAGAIN`) is retried with a growing wait for at most 5 s in all, so a reader
 * that never reads can't hang the process; a closed pipe (`EPIPE`) stops the write: the reader is
 * gone. Any other error is thrown.
 */
export function writeAll(text: string, deps: WriteDeps = {}): void {
  const write = deps.write ?? writeSync;
  const sleep = deps.sleep ?? sleepSync;
  const now = deps.now ?? Date.now;
  const fd = deps.fd ?? 1;
  const buffer = Buffer.from(text, 'utf8');
  const deadline = now() + DEADLINE;
  let offset = 0;
  let wait = FIRST_WAIT;
  while (offset < buffer.length) {
    let written = 0;
    try {
      written = write(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EPIPE') return;
      if (code !== 'EAGAIN') throw error;
    }
    if (written > 0) {
      offset += written;
      wait = FIRST_WAIT;
      continue;
    }
    const left = deadline - now();
    if (left <= 0) return;
    sleep(Math.min(wait, left));
    wait = Math.min(wait * 2, LONGEST_WAIT);
  }
}

/** Writes one JSON line on stdout, and remembers that it did. */
export function emitter(write: (text: string) => void = writeAll) {
  let emitted = false;
  return {
    emit: (line: string) => {
      emitted = true;
      write(line);
    },
    emitted: () => emitted,
  };
}

/**
 * The last resort for an error nothing caught: prints its stack on stderr and, under `--json` when
 * no object was written yet, a minimal `unexpected` object, never a second one. Returns the exit code.
 */
export function crashed(
  error: unknown,
  json: boolean,
  out: { emit: (line: string) => void; emitted: () => boolean },
  stderr: (text: string) => void = (text) => process.stderr.write(text)
): number {
  try {
    stderr(`${error instanceof Error ? error.stack : String(error)}\n`);
  } catch {}
  if (json && !out.emitted()) {
    try {
      out.emit(`${JSON.stringify(crashJson(error))}\n`);
    } catch {}
  }
  return FAILURE;
}
