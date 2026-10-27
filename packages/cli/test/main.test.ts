import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main';
import type { Prompts, Ui } from '../src/ui';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ctms-main-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('main, interactive', () => {
  const setup = () => {
    const calls: string[] = [];
    const prompt = (name: string) => async () => {
      calls.push(name);
      throw new Error('no prompt should run');
    };
    const prompts = {
      text: prompt('text'),
      confirm: prompt('confirm'),
      multiselect: prompt('multiselect'),
    } as unknown as Prompts;
    const ui: Ui = {
      intro: () => calls.push('intro'),
      step() {},
      start() {},
      stop() {},
      warn() {},
      fail: (title) => calls.push(`fail: ${title}`),
      outro() {},
    };
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    return { calls, prompts, ui, stderr };
  };

  it('rejects a bad --scope before any prompt', async () => {
    const { calls, prompts, ui, stderr } = setup();
    const code = await main(['--scope', '@a b'], { cwd, interactive: true, ui, prompts });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr.join('')).toMatch(/Scope "@a b"/);
  });

  it('rejects a folder name with nothing valid in it before any prompt', async () => {
    const { calls, prompts, ui, stderr } = setup();
    const code = await main(['!!!'], { cwd, interactive: true, ui, prompts });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr.join('')).not.toBe('');
  });
});
