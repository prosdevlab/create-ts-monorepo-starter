import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, TOOLCHAIN } from '../src/main';
import type { Exec } from '../src/pnpm';
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

describe('main --check', () => {
  const recording = () => {
    const calls: string[] = [];
    const ui: Ui = {
      intro: () => calls.push('intro'),
      step: (done) => calls.push(`step: ${done}`),
      start() {},
      stop() {},
      warn: (title) => calls.push(`warn: ${title}`),
      fail: (title, lines) => calls.push(`fail: ${[title, ...lines].join(' | ')}`),
      outro() {},
    };
    return { calls, ui };
  };
  /** The global pnpm answers in the temp folder; a pinned folder answers with `pinned`. */
  const pnpm =
    (global: { code: number; stdout?: string }, pinned = { code: 0, stdout: '12.15.0\n' }): Exec =>
    async (_cmd, _args, { cwd }) => ({
      stderr: pinned.code === 0 ? '' : 'ERROR  Failed to switch pnpm to v12.15.0.',
      ...(cwd === tmpdir() ? { stdout: '', ...global } : pinned),
      stdout: (cwd === tmpdir() ? global.stdout : pinned.stdout) ?? '',
    });

  it('is ready when pnpm switches to the template version, and creates nothing', async () => {
    const { calls, ui } = recording();
    const code = await main(['--check'], { cwd, ui, exec: pnpm({ code: 0, stdout: '10.28.0\n' }) });
    expect(code).toBe(0);
    expect(calls).toEqual([
      'intro',
      expect.stringMatching(/^step: Ready: pnpm 10\.28\.0 switches to pnpm \d+\.\d+\.\d+/),
    ]);
  });

  it('exits with the toolchain code and the fix when the switch fails', async () => {
    const { calls, ui } = recording();
    const exec = pnpm({ code: 0, stdout: '10.28.0\n' }, { code: 1, stdout: '' });
    const code = await main(['--check'], { cwd, ui, exec });
    expect(code).toBe(TOOLCHAIN);
    expect(calls.at(-1)).toMatch(
      /^fail: pnpm 10\.28\.0 couldn't switch to pnpm .* \| Then run this command again\. Nothing was created\.$/
    );
  });

  it('exits with the toolchain code for a pnpm too old to switch', async () => {
    const { calls, ui } = recording();
    const code = await main(['--check'], { cwd, ui, exec: pnpm({ code: 0, stdout: '9.15.9\n' }) });
    expect(code).toBe(TOOLCHAIN);
    expect(calls.at(-1)).toMatch(
      /^fail: pnpm 9\.15\.9 is too old for this project \| .* \| Upgrade pnpm/
    );
  });

  it('is ready without pnpm, after a warning', async () => {
    const { calls, ui } = recording();
    const code = await main(['--check'], { cwd, ui, exec: pnpm({ code: 127 }) });
    expect(code).toBe(0);
    expect(calls).toContain("warn: pnpm isn't installed");
  });
});
