import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANCEL_SYMBOL } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, TOOLCHAIN } from '../src/main';
import type { Exec } from '../src/pnpm';
import type { RunDeps } from '../src/run';
import { pnpmSpec } from '../src/template';
import type { Prompts, Ui } from '../src/ui';
import { backUp, moveIntoPlace } from '../src/workspace';

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

/** Every Ui call, with titles and lines, in order. */
const recordingUi = () => {
  const calls: string[] = [];
  const ui: Ui = {
    intro: () => calls.push('intro'),
    step: (done, detail) => calls.push(`step: ${done}${detail ? ` | ${detail}` : ''}`),
    start: (label) => calls.push(`start: ${label}`),
    stop: () => calls.push('stop'),
    warn: (title, lines) => calls.push(`warn: ${[title, ...lines].join(' | ')}`),
    fail: (title, lines) => calls.push(`fail: ${[title, ...lines].join(' | ')}`),
    outro: () => calls.push('outro'),
  };
  return { calls, ui };
};

const cancelled = CANCEL_SYMBOL;

describe('main, interactive: exact text', () => {
  const capture = () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    return stderr;
  };
  const noPrompts = {
    text: async () => {
      throw new Error('no prompt should run');
    },
  } as unknown as Prompts;

  it('prints a bad --scope as one line on stderr', async () => {
    const stderr = capture();
    const { calls, ui } = recordingUi();
    const code = await main(['--scope', '@a b'], {
      cwd,
      interactive: true,
      ui,
      prompts: noPrompts,
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr).toEqual([
      'Scope "@a b" can only contain lowercase letters, digits, "-", "." and "_".\n',
    ]);
  });

  it('prints a bad folder name as one line on stderr', async () => {
    const stderr = capture();
    const { calls, ui } = recordingUi();
    const code = await main(['!!!'], { cwd, interactive: true, ui, prompts: noPrompts });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr).toEqual(['Can\'t make an npm package name from "!!!"\n']);
  });

  it('says nothing was written when a prompt is cancelled', async () => {
    const { calls, ui } = recordingUi();
    const prompts = { text: async () => cancelled } as unknown as Prompts;
    const code = await main([], { cwd, interactive: true, ui, prompts });
    expect(code).toBe(130);
    expect(calls).toEqual(['intro', 'fail: Cancelled. Nothing was written.']);
  });

  it('uses the clack screens when no Ui is given', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const prompts = { text: async () => cancelled } as unknown as Prompts;
    const code = await main([], { cwd, interactive: true, prompts });
    expect(code).toBe(130);
    expect(out.join('')).toContain('┌');
  });
});

describe('main --check: exact text', () => {
  const version = pnpmSpec().slice('pnpm@'.length);
  const pnpm =
    (
      global: { code: number; stdout?: string },
      pinned = { code: 0, stdout: `${version}\n` }
    ): Exec =>
    async (_cmd, _args, { cwd }) => ({
      stderr: pinned.code === 0 ? '' : `ERROR  Failed to switch pnpm to v${version}.`,
      code: cwd === tmpdir() ? global.code : pinned.code,
      stdout: (cwd === tmpdir() ? global.stdout : pinned.stdout) ?? '',
    });

  it('prints the ready line', async () => {
    const { calls, ui } = recordingUi();
    const code = await main(['--check'], { cwd, ui, exec: pnpm({ code: 0, stdout: '10.28.0\n' }) });
    expect(code).toBe(0);
    expect(calls).toEqual([
      'intro',
      `step: Ready: pnpm 10.28.0 switches to pnpm ${version} for this project`,
    ]);
  });

  it('warns, with both lines, when pnpm is missing', async () => {
    const { calls, ui } = recordingUi();
    const code = await main(['--check'], { cwd, ui, exec: pnpm({ code: 127 }) });
    expect(code).toBe(0);
    expect(calls).toEqual([
      'intro',
      `warn: pnpm isn't installed | Creating works: the install uses a temporary pnpm ${version} (npm exec). | Working in the project needs pnpm 10.26 or newer: https://pnpm.io/installation`,
    ]);
  });

  it('fails, with every line, when pnpm is too old', async () => {
    const { calls, ui } = recordingUi();
    const code = await main(['--check'], { cwd, ui, exec: pnpm({ code: 0, stdout: '9.15.9\n' }) });
    expect(code).toBe(TOOLCHAIN);
    expect(calls).toEqual([
      'intro',
      `fail: pnpm 9.15.9 is too old for this project | This project needs pnpm 10.26 or newer, which switches itself to pnpm ${version}. | Upgrade pnpm: npm install -g pnpm (or https://pnpm.io/installation) | Then run this command again. Nothing was created.`,
    ]);
  });

  it('fails, with every line, when pnpm cannot switch', async () => {
    const { calls, ui } = recordingUi();
    const exec = pnpm({ code: 0, stdout: '10.28.0\n' }, { code: 1, stdout: '' });
    const code = await main(['--check'], { cwd, ui, exec });
    expect(code).toBe(TOOLCHAIN);
    expect(calls).toEqual([
      'intro',
      `fail: pnpm 10.28.0 couldn't switch to pnpm ${version}, which this project needs | pnpm: ERROR  Failed to switch pnpm to v${version}. | Fix your pnpm so it can switch to ${version}: https://github.com/prosdevlab/create-ts-monorepo-starter#pnpm | Then run this command again. Nothing was created.`,
    ]);
  });

  it('rejects when the exec that detects pnpm throws synchronously', async () => {
    const { calls, ui } = recordingUi();
    const exec: Exec = () => {
      throw new Error('spawn exploded');
    };
    await expect(main(['--check'], { cwd, ui, exec })).rejects.toThrow('spawn exploded');
    expect(calls).toEqual(['intro']);
  });

  it('rejects when the exec that checks the switch throws synchronously', async () => {
    const { calls, ui } = recordingUi();
    let n = 0;
    // An async exec that rejects is caught by checkSwitch as a failed switch: only a sync throw escapes.
    const exec: Exec = () => {
      n += 1;
      if (n > 1) throw new Error('spawn exploded');
      return Promise.resolve({ code: 0, stdout: '10.28.0\n', stderr: '' });
    };
    await expect(main(['--check'], { cwd, ui, exec })).rejects.toThrow('spawn exploded');
    expect(calls).toEqual(['intro']);
  });
});

describe('main, through runDeps', () => {
  const LOCKFILE = `lockfileVersion: '9.0'

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-x}
`;
  let template: string;
  let target: string;
  const EIO = () => Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
  /** A `rename` that fails with EIO (never retried) on its Nth call. */
  const failingOn = (nth: number): typeof rename => {
    let calls = 0;
    return (async (from, to) => {
      calls += 1;
      if (calls === nth) throw EIO();
      await rename(from, to);
    }) as typeof rename;
  };

  beforeEach(() => {
    template = join(cwd, 'template-src');
    mkdirSync(template);
    writeFileSync(join(template, 'package.json'), '{ "packageManager": "pnpm@12.15.0" }\n');
    writeFileSync(join(template, 'pnpm-lock.yaml'), LOCKFILE);
    target = join(cwd, 'my-tools');
  });

  const exec =
    (replies: Record<string, { code: number; stderr?: string }> = {}): Exec =>
    async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      const key = Object.keys(replies).find((prefix) => line.startsWith(prefix));
      const reply = key ? replies[key] : undefined;
      if (reply) return { stdout: '', stderr: '', ...reply };
      if (line === 'pnpm --version') return { code: 0, stdout: '12.15.0\n', stderr: '' };
      if (line.startsWith('git rev-parse')) return { code: 128, stdout: '', stderr: 'not a repo' };
      if (line === 'git config user.name') return { code: 0, stdout: 'Ada\n', stderr: '' };
      if (line === 'git config user.email') {
        return { code: 0, stdout: 'ada@example.com\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

  const generate =
    (lockfile = LOCKFILE): RunDeps['generate'] =>
    async (input) => {
      await mkdir(input.to);
      await writeFile(join(input.to, 'package.json'), `{ "name": "${input.folderName}" }\n`);
      await writeFile(join(input.to, 'pnpm-lock.yaml'), lockfile);
    };

  const runDeps = (overrides: Partial<RunDeps> = {}): RunDeps => ({
    templateDir: template,
    exec: exec(),
    generate: generate(),
    onInterrupt: () => () => undefined,
    ...overrides,
  });

  const go = async (deps: RunDeps, argv = ['my-tools', '-y', '--no-git']) => {
    const { calls, ui } = recordingUi();
    const code = await main(argv, { cwd, ui, runDeps: deps });
    return { calls, code };
  };
  /** The backup stamp is the current time. */
  const stamp = (text: string) => text.replace(/\.backup-\d{8}-\d{6}/g, '.backup-<time>');
  /** The test folder, and the path separator after it, which is `\\` on Windows. */
  const folder = (text: string) =>
    text.replaceAll(cwd, '<cwd>').replace(/<cwd>[\\/]([^\s,.]+)/g, '<cwd>/$1');

  const nonEmptyTarget = () => {
    mkdirSync(target);
    writeFileSync(join(target, 'a.txt'), 'a');
    writeFileSync(join(target, 'b.txt'), 'b');
  };
  const failure = (calls: string[]) => folder(stamp(calls.at(-1) ?? ''));

  it('shows each step of a success, then the outro exactly once', async () => {
    const { calls, code } = await go(runDeps(), ['my-tools', '-y']);
    expect(code).toBe(0);
    expect(calls.map((call) => call.replace(/\(\d+s\)/, '(<n>s)'))).toEqual([
      'intro',
      'step: Created my-tools | @my-tools/lib, @my-tools/shared, @my-tools/cli, @my-tools/web',
      'start: Installing dependencies with pnpm 12.15.0',
      'stop',
      'step: Installed dependencies with pnpm 12.15.0 (<n>s)',
      'step: Initialized git with a first commit',
      'outro',
    ]);
    expect(readdirSync(target).sort()).toEqual(['package.json', 'pnpm-lock.yaml']);
  });

  it('reports a failed install with the last output lines', async () => {
    const exec$ = exec({ 'pnpm install': { code: 1, stderr: 'ERR_PNPM_FETCH\nnetwork down' } });
    const { calls, code } = await go(runDeps({ exec: exec$ }));
    expect(code).toBe(4);
    expect(calls).toEqual([
      'intro',
      'step: Created my-tools | @my-tools/lib, @my-tools/shared, @my-tools/cli, @my-tools/web',
      'start: Installing dependencies with pnpm 12.15.0',
      'stop',
      "fail: Couldn't install dependencies (pnpm exited with 1) | ERR_PNPM_FETCH | network down",
    ]);
    expect(readdirSync(cwd).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('reports a lockfile change with the added entries', async () => {
    const changed = `${LOCKFILE}\n  right-pad@2.0.0:\n    resolution: {integrity: sha512-y}\n`;
    const { calls, code } = await go(runDeps({ generate: generate(changed) }));
    expect(code).toBe(1);
    expect(calls.at(-1)).toBe(
      'fail: Lockfile changed during install: | + packages: right-pad@2.0.0'
    );
  });

  it('exits 0 for a failed git init, with a warning and a created project', async () => {
    const exec$ = exec({ 'git init': { code: 129, stderr: 'no git' } });
    const { calls, code } = await go(runDeps({ exec: exec$ }), ['my-tools', '-y']);
    expect(code).toBe(0);
    expect(calls.some((call) => call.startsWith("warn: Couldn't initialize git"))).toBe(true);
    expect(calls.at(-1)).toBe('outro');
  });

  it('exits 1 for an error with a Node code, never 0', async () => {
    const boom: RunDeps['generate'] = async () => {
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    };
    const { calls, code } = await go(runDeps({ generate: boom }));
    expect(code).toBe(1);
    expect(calls.at(-1)).toBe('fail: no space left');
  });

  it('reports a failed move into place when nothing was backed up', async () => {
    const move: RunDeps['moveIntoPlace'] = (temp, to) =>
      moveIntoPlace(temp, to, { rename: failingOn(1) });
    const { calls, code } = await go(runDeps({ moveIntoPlace: move }));
    expect(code).toBe(1);
    expect(calls.at(-1)).toBe('fail: EIO: i/o error, rename');
    expect(readdirSync(cwd).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('names the backup when the move fails after one', async () => {
    nonEmptyTarget();
    const move: RunDeps['moveIntoPlace'] = (temp, to) =>
      moveIntoPlace(temp, to, { rename: failingOn(1) });
    const { calls, code } = await go(runDeps({ moveIntoPlace: move }), [
      'my-tools',
      '-y',
      '--no-git',
      '--force',
    ]);
    expect(code).toBe(1);
    expect(failure(calls)).toBe(
      "fail: Couldn't move the project into place: EIO: i/o error, rename | The old files are in <cwd>/my-tools.backup-<time>."
    );
    expect(readdirSync(cwd).some((name) => name.includes('.backup-'))).toBe(true);
  });

  const force = ['my-tools', '-y', '--no-git', '--force'];

  it('says all files are still in place when the first entry fails to move aside', async () => {
    nonEmptyTarget();
    const entries = readdirSync(target);
    const back: RunDeps['backUp'] = (t, now, d) => backUp(t, now, { ...d, rename: failingOn(1) });
    const { calls, code } = await go(runDeps({ cwd: target, backUp: back }), force);
    expect(code).toBe(1);
    expect(failure(calls)).toBe(
      `fail: Couldn't move the old files aside: ${entries[0]}: EIO: i/o error, rename | Your files are all still in <cwd>/my-tools.`
    );
    expect(readdirSync(target).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('says the files are split when a later entry fails to move aside', async () => {
    nonEmptyTarget();
    const entries = readdirSync(target);
    const back: RunDeps['backUp'] = (t, now, d) => backUp(t, now, { ...d, rename: failingOn(2) });
    const { calls, code } = await go(runDeps({ cwd: target, backUp: back }), force);
    expect(code).toBe(1);
    expect(failure(calls)).toBe(
      `fail: Couldn't move the old files aside: ${entries[1]}: EIO: i/o error, rename | Your files are split: 1 of 2 entries are in <cwd>/my-tools.backup-<time>, the rest are still in <cwd>/my-tools.`
    );
  });

  it('prints the rename error as it is when the whole folder fails to move aside', async () => {
    nonEmptyTarget();
    const back: RunDeps['backUp'] = (t, now, d) => backUp(t, now, { ...d, rename: failingOn(1) });
    const { calls, code } = await go(runDeps({ backUp: back }), force);
    expect(code).toBe(1);
    expect(calls.at(-1)).toBe('fail: EIO: i/o error, rename');
    expect(readdirSync(target).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('prints the message of an error, the first line as the title', async () => {
    const boom: RunDeps['generate'] = async () => {
      throw new Error('first\nsecond\nthird');
    };
    const { calls, code } = await go(runDeps({ generate: boom }));
    expect(code).toBe(1);
    expect(calls).toEqual(['intro', 'fail: first | second | third']);
  });

  it('prints an empty title for an error with an empty message', async () => {
    // The 'Something went wrong' default never applies: ''.split('\n') is [''], not [].
    const boom: RunDeps['generate'] = async () => {
      throw new Error('');
    };
    const { calls, code } = await go(runDeps({ generate: boom }));
    expect(code).toBe(1);
    expect(calls).toEqual(['intro', 'fail: ']);
  });

  it('prints a thrown string as it is', async () => {
    const boom: RunDeps['generate'] = async () => {
      throw 'just a string';
    };
    const { calls, code } = await go(runDeps({ generate: boom }));
    expect(code).toBe(1);
    expect(calls).toEqual(['intro', 'fail: just a string']);
  });

  it('removes the temporary folder with the rm it is given', async () => {
    const removed: string[] = [];
    const boom: RunDeps['generate'] = async () => {
      throw new Error('stop');
    };
    const rm: RunDeps['rm'] = async (path) => {
      removed.push(String(path));
    };
    await go(runDeps({ generate: boom, rm }));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/\.my-tools\.tmp-[0-9a-f]{8}$/);
  });
});
