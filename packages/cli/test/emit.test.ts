import { describe, expect, it } from 'vitest';
import { crashed, emitter, writeAll } from '../src/emit';

const failure = (code: string) => Object.assign(new Error(code), { code });

/** A fake `writeSync` and clock: `step` answers each call, by its index. */
const fake = (step: (call: number, length: number) => number | Error) => {
  const chunks: Buffer[] = [];
  let time = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const deps = {
    write: (_fd: number, buffer: Uint8Array, offset: number, length: number) => {
      const answer = step(calls++, length);
      if (answer instanceof Error) throw answer;
      chunks.push(Buffer.from(buffer.subarray(offset, offset + answer)));
      return answer;
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
  };
  return { deps, sleeps, text: () => Buffer.concat(chunks).toString('utf8'), calls: () => calls };
};

describe('writeAll', () => {
  const object = `${JSON.stringify({ text: 'é'.repeat(3000) })}\n`;

  it('writes all of it when each write takes only part', () => {
    const w = fake((_call, length) => Math.min(1000, length));
    writeAll(object, w.deps);
    expect(w.text()).toBe(object);
    expect(w.calls()).toBeGreaterThan(5);
  });

  it('waits and retries after EAGAIN', () => {
    const w = fake((call, length) => (call === 0 ? failure('EAGAIN') : length));
    writeAll(object, w.deps);
    expect(w.text()).toBe(object);
    expect(w.sleeps).toEqual([10]);
  });

  it('gives up after 5 s of EAGAIN, without throwing, waiting longer each time up to 200 ms', () => {
    const w = fake(() => failure('EAGAIN'));
    expect(() => writeAll(object, w.deps)).not.toThrow();
    expect(w.sleeps.slice(0, 6)).toEqual([10, 20, 40, 80, 160, 200]);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it('stops at EPIPE without throwing: the reader is gone', () => {
    const w = fake((call) => (call === 0 ? 100 : failure('EPIPE')));
    expect(() => writeAll(object, w.deps)).not.toThrow();
    expect(w.calls()).toBe(2);
  });

  it('throws any other error', () => {
    const w = fake(() => failure('EBADF'));
    expect(() => writeAll(object, w.deps)).toThrow('EBADF');
  });
});

describe('crashed', () => {
  const recording = () => {
    const lines: string[] = [];
    const out = emitter((line) => lines.push(line));
    const stderr: string[] = [];
    return { lines, out, stderr, write: (text: string) => stderr.push(text) };
  };

  it('under --json, prints the stack and one minimal unexpected object', () => {
    const { lines, out, stderr, write } = recording();
    expect(crashed(new Error('boom'), true, out, write)).toBe(1);
    expect(stderr.join('')).toContain('Error: boom');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      ok: false,
      kind: 'failed',
      error: { code: 'unexpected', title: 'boom' },
    });
  });

  it('never writes a second object', () => {
    const { lines, out, write } = recording();
    out.emit('{"ok":true}\n');
    crashed(new Error('boom'), true, out, write);
    expect(lines).toEqual(['{"ok":true}\n']);
  });

  it('without --json, prints only the stack', () => {
    const { lines, out, stderr, write } = recording();
    expect(crashed('text', false, out, write)).toBe(1);
    expect(stderr).toEqual(['text\n']);
    expect(lines).toEqual([]);
  });
});
