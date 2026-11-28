import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CANCEL_SYMBOL } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, main, TOOLCHAIN } from '../src/main';
import { exitCode, type Outcome } from '../src/outcome';
import type { Exec } from '../src/pnpm';
import type { RunDeps } from '../src/run';
import { pnpmSpec } from '../src/template';
import type { Prompts, Ui } from '../src/ui';
import { backUp, type InterruptDeps, moveIntoPlace } from '../src/workspace';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
let cwd: string;
let listening: ((...args: never) => unknown)[][];
let exitCodeBefore: typeof process.exitCode;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ctms-main-'));
  listening = SIGNALS.map((signal) => process.listeners(signal));
  exitCodeBefore = process.exitCode;
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
  // `execute` registers its handlers for the life of the process; a test process outlives many.
  SIGNALS.forEach((signal, i) => {
    for (const listener of process.listeners(signal)) {
      if (!listening[i]?.includes(listener)) process.off(signal, listener as () => void);
    }
  });
  process.exitCode = exitCodeBefore;
});

/** The command-level handler's seams: `fire` runs every handler registered, as a signal would. */
const signals = () => {
  const handlers: (() => void)[] = [];
  const log: string[] = [];
  const deps: InterruptDeps = {
    on: (handler) => {
      handlers.push(handler);
      return () => undefined;
    },
    live: () => true,
    // Resolves on a later tick, as a real stop does.
    stop: () => {
      log.push('stop');
      return new Promise((done) => setTimeout(() => done(true), 5));
    },
    remove: (path) => {
      log.push(`remove ${path}`);
      rmSync(path, { recursive: true, force: true });
    },
    exit: (code) => log.push(`exit ${code}`),
  };
  const fire = () => {
    for (const handler of handlers) handler();
  };
  return { deps, log, handlers, fire };
};

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

  it('reports a missing pnpm as a pnpm-missing warning on the outcome', async () => {
    const outcome = await execute(['--check'], {
      cwd,
      ui: recordingUi().ui,
      exec: pnpm({ code: 127 }),
    });
    expect(outcome).toMatchObject({
      ok: true,
      kind: 'checked',
      warnings: [
        {
          code: 'pnpm-missing',
          fixes: [{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }],
        },
      ],
    });
  });

  it('gives a too-old pnpm its fix, what it needed and what it found', async () => {
    const outcome = await execute(['--check'], {
      cwd,
      ui: recordingUi().ui,
      exec: pnpm({ code: 0, stdout: '9.15.9\n' }),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'pnpm-too-old',
        fixes: [{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }],
        required: { pnpm: '>=10.26' },
        found: { pnpm: '9.15.9' },
      },
    });
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

  it('fails, exit 1, when the exec that detects pnpm throws synchronously', async () => {
    const { calls, ui } = recordingUi();
    const exec: Exec = () => {
      throw new Error('spawn exploded');
    };
    expect(await main(['--check'], { cwd, ui, exec })).toBe(1);
    expect(calls).toEqual(['intro', 'fail: spawn exploded']);
  });

  it('fails, exit 1, when the exec that checks the switch throws synchronously', async () => {
    const { calls, ui } = recordingUi();
    let n = 0;
    // An async exec that rejects is caught by checkSwitch as a failed switch: only a sync throw escapes.
    const exec: Exec = () => {
      n += 1;
      if (n > 1) throw new Error('spawn exploded');
      return Promise.resolve({ code: 0, stdout: '10.28.0\n', stderr: '' });
    };
    expect(await main(['--check'], { cwd, ui, exec })).toBe(1);
    expect(calls).toEqual(['intro', 'fail: spawn exploded']);
  });

  it('fails, exit 1, when reading the git identity throws, and creates nothing', async () => {
    const { calls, ui } = recordingUi();
    const exec: Exec = (cmd) => {
      if (cmd === 'git') throw new Error('git exploded');
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    expect(await main(['my-tools', '-y'], { cwd, ui, exec })).toBe(1);
    expect(calls).toEqual(['fail: git exploded']);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('reads the git identity through the exec it is given', async () => {
    const seen: string[] = [];
    const exec: Exec = (cmd, args) => {
      seen.push([cmd, ...args].join(' '));
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    };
    await execute(['my-tools', '-y'], {
      cwd,
      ui: recordingUi().ui,
      exec,
      runDeps: { exec: () => Promise.reject(new Error('stop before the run does anything')) },
    });
    expect(seen).toEqual(['git config user.name', 'git config user.email']);
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
      "fail: Couldn't install dependencies (pnpm exited with 1) | ERR_PNPM_FETCH | network down | Retry: create-ts-monorepo-starter -y --scope @my-tools --examples lib,cli,web --no-git -- my-tools",
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

  /** The outcome `execute` returns, and what the Ui was shown. */
  const outcomeOf = async (deps: RunDeps, argv = ['my-tools', '-y', '--no-git']) => {
    const { calls, ui } = recordingUi();
    const outcome = await execute(argv, { cwd, ui, runDeps: deps });
    return { calls, outcome };
  };

  describe('on Ctrl-C', () => {
    type Exit = (code: number, outcome: { removed: boolean; stopped: boolean }) => void;
    /** A run whose `generate` fires the interrupt and never returns, as a real exit would leave it. */
    const interrupted = async (outcome: { removed: boolean; stopped: boolean }) => {
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      let exit: Exit | undefined;
      const reported: Outcome[] = [];
      const deps = runDeps({
        onInterrupt: (_temp, options) => {
          exit = options?.exit;
          return () => undefined;
        },
        onOutcome: (o) => reported.push(o),
        generate: () => {
          exit?.(130, outcome);
          return new Promise<never>(() => undefined);
        },
      });
      const { calls, ui } = recordingUi();
      void main(['my-tools', '-y', '--no-git'], { cwd, ui, runDeps: deps });
      await vi.waitFor(() => expect(reported).toHaveLength(1));
      return { calls, outcome: reported[0] };
    };

    it("reports through execute's report: the retry, in the outcome and the text", async () => {
      const { calls, outcome } = await interrupted({ removed: true, stopped: true });
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'interrupted' },
        left: { target: 'missing' },
        retry: {
          argv: [
            '-y',
            '--scope',
            '@my-tools',
            '--examples',
            'lib,cli,web',
            '--no-git',
            '--',
            'my-tools',
          ],
          cwd,
        },
      });
      expect(calls.filter((call) => call.startsWith('fail:'))).toEqual([
        'fail: Cancelled. Nothing was written. | Retry: create-ts-monorepo-starter -y --scope @my-tools --examples lib,cli,web --no-git -- my-tools',
      ]);
      expect(process.exit).toHaveBeenCalledWith(130);
    });

    it('offers no retry when the temporary folder stayed or pnpm may still run', async () => {
      for (const state of [
        { removed: false, stopped: true },
        { removed: true, stopped: false },
      ]) {
        const { calls, outcome } = await interrupted(state);
        expect(outcome).not.toHaveProperty('retry');
        expect(calls.join('\n')).not.toContain('Retry:');
        vi.restoreAllMocks();
      }
    });
  });

  it('removes credentials from a failed install, in the text and in error.output', async () => {
    const stderr =
      'GET https://ada:hunter2@r.example/x\n//r.example/:_authToken=abc123\nERR_PNPM_FETCH';
    const exec$ = exec({ 'pnpm install': { code: 1, stderr } });
    const { calls, outcome } = await outcomeOf(runDeps({ exec: exec$ }));
    const shown = [
      'GET https://ada:***@r.example/x',
      '//r.example/:_authToken=***',
      'ERR_PNPM_FETCH',
    ];
    expect(calls.join('\n')).not.toMatch(/hunter2|abc123/);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'install-failed', lines: shown, output: shown },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/hunter2|abc123/);
  });

  it('prints the redacted lines for a failed install', async () => {
    const exec$ = exec({ 'pnpm install': { code: 1, stderr: '_authToken=abc123' } });
    const { calls } = await go(runDeps({ exec: exec$ }));
    expect(calls.at(-1)).toBe(
      "fail: Couldn't install dependencies (pnpm exited with 1) | _authToken=*** | Retry: create-ts-monorepo-starter -y --scope @my-tools --examples lib,cli,web --no-git -- my-tools"
    );
  });

  it('has error.output only for a failed install', async () => {
    const changed = `${LOCKFILE}\n  right-pad@2.0.0:\n    resolution: {integrity: sha512-y}\n`;
    const { outcome } = await outcomeOf(runDeps({ generate: generate(changed) }));
    expect(outcome).toMatchObject({ ok: false, error: { code: 'lockfile-changed' } });
    expect(outcome).not.toHaveProperty('error.output');
  });

  it('reports a failed git init as a warning on the created outcome, redacted', async () => {
    const exec$ = exec({
      'git init': { code: 129, stderr: 'fatal: https://ada:hunter2@r.example' },
    });
    const { calls, outcome } = await outcomeOf(runDeps({ exec: exec$ }), ['my-tools', '-y']);
    expect(outcome).toMatchObject({
      ok: true,
      warnings: [
        {
          code: 'git-failed',
          title: "Couldn't initialize git",
          lines: ['fatal: https://ada:***@r.example'],
          fixes: [],
        },
      ],
    });
    expect(calls).toContain("warn: Couldn't initialize git | fatal: https://ada:***@r.example");
  });

  it('has no warnings for a clean run', async () => {
    const { outcome } = await outcomeOf(runDeps(), ['my-tools', '-y']);
    expect(outcome).toMatchObject({ ok: true, kind: 'created', warnings: [] });
  });

  it('reports a missing pnpm as a warning with its fix, and an install time of 0 without installing', async () => {
    const exec$: Exec = async (cmd, args) => {
      if (cmd === 'pnpm') return { code: 127, stdout: '', stderr: '' };
      return exec()(cmd, args, {});
    };
    const { outcome } = await outcomeOf(runDeps({ exec: exec$ }), [
      'my-tools',
      '-y',
      '--no-git',
      '--no-install',
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { seconds: 0 },
      warnings: [
        {
          code: 'pnpm-missing',
          fixes: [{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }],
        },
      ],
    });
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

  describe('execute: the code of every exit', () => {
    const outcomeOf = async (deps: RunDeps, argv = ['my-tools', '-y', '--no-git']) => {
      const { ui } = recordingUi();
      return execute(argv, { cwd, ui, runDeps: deps });
    };
    const codeOf = async (deps: RunDeps, argv?: string[]) => {
      const outcome = await outcomeOf(deps, argv);
      return outcome.ok ? 'ok' : outcome.error.code;
    };

    it('target-not-empty, with no left', async () => {
      nonEmptyTarget();
      const outcome = await outcomeOf(runDeps());
      expect(outcome).toMatchObject({ ok: false, error: { code: 'target-not-empty' } });
      expect(outcome).not.toHaveProperty('left');
      expect(exitCode(outcome)).toBe(1);
    });

    it('backup-failed, on a first entry and on a whole-folder rename', async () => {
      nonEmptyTarget();
      const inPlace: RunDeps['backUp'] = (t, now, d) =>
        backUp(t, now, { ...d, rename: failingOn(1) });
      expect(await codeOf(runDeps({ cwd: target, backUp: inPlace }), force)).toBe('backup-failed');
      expect(await codeOf(runDeps({ backUp: inPlace }), force)).toBe('backup-failed');
    });

    it('move-failed, with and without a backup', async () => {
      const move: RunDeps['moveIntoPlace'] = (temp, to) =>
        moveIntoPlace(temp, to, { rename: failingOn(1) });
      expect(await codeOf(runDeps({ moveIntoPlace: move }))).toBe('move-failed');
      nonEmptyTarget();
      expect(await codeOf(runDeps({ moveIntoPlace: move }), force)).toBe('move-failed');
    });

    it('lockfile-changed and install-failed', async () => {
      const changed = `${LOCKFILE}\n  right-pad@2.0.0:\n    resolution: {integrity: sha512-y}\n`;
      expect(await codeOf(runDeps({ generate: generate(changed) }))).toBe('lockfile-changed');
      const failed = exec({ 'pnpm install': { code: 1 } });
      expect(await codeOf(runDeps({ exec: failed }))).toBe('install-failed');
    });

    it('unexpected, from a plain Error and from an ENOSPC error', async () => {
      const plain: RunDeps['generate'] = async () => {
        throw new Error('boom');
      };
      const enospc: RunDeps['generate'] = async () => {
        throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      };
      expect(await codeOf(runDeps({ generate: plain }))).toBe('unexpected');
      const outcome = await outcomeOf(runDeps({ generate: enospc }));
      expect(outcome).toMatchObject({ ok: false, error: { code: 'unexpected' } });
      expect(exitCode(outcome)).toBe(1);
    });

    it('cancelled, with no left', async () => {
      const { ui } = recordingUi();
      const prompts = { text: async () => cancelled } as unknown as Prompts;
      const outcome = await execute([], { cwd, interactive: true, ui, prompts });
      expect(outcome).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      expect(outcome).not.toHaveProperty('left');
    });

    it('usage, from a NameError, with no left', async () => {
      const outcome = await outcomeOf(runDeps(), ['my-tools', '-y', '--scope', '@a b']);
      expect(outcome).toMatchObject({ ok: false, error: { code: 'usage' } });
      expect(outcome).not.toHaveProperty('left');
    });

    it('a created project is complete, with the backup when there was one', async () => {
      nonEmptyTarget();
      const outcome = await outcomeOf(runDeps(), force);
      expect(outcome).toMatchObject({ ok: true, kind: 'created', left: { target: 'complete' } });
      expect(outcome.ok && outcome.kind === 'created' && outcome.left.backup).toMatch(/\.backup-/);
    });
  });

  it('shows the install error, exit 4 and left.temp when the cleanup fails too', async () => {
    const rm: RunDeps['rm'] = async () => {
      throw new Error('EBUSY: resource busy');
    };
    const failed = exec({ 'pnpm install': { code: 1, stderr: 'network down' } });
    const { calls, code } = await go(runDeps({ exec: failed, rm }));
    expect(code).toBe(4);
    expect(folder(calls.at(-1) ?? '')).toMatch(
      /^fail: Couldn't install dependencies \(pnpm exited with 1\) \| network down \| Couldn't delete the temporary folder <cwd>[\\/]\.my-tools\.tmp-[0-9a-f]{8}: delete it yourself\.$/
    );
    const { ui } = recordingUi();
    const outcome = await execute(['my-tools', '-y', '--no-git'], {
      cwd,
      ui,
      runDeps: runDeps({ exec: failed, rm }),
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'install-failed' } });
    expect(!outcome.ok && outcome.left?.temp).toMatch(/\.my-tools\.tmp-[0-9a-f]{8}$/);
  });
});

describe('the command-level interrupt', () => {
  const LOCKFILE = "lockfileVersion: '9.0'\n";
  const isScratch = (path: string) => basename(path).startsWith('ctms-pnpm-');
  /** `main` never resolves once interrupted: the handler exits. */
  const pending = (promise: Promise<unknown>) => {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    return () => settled;
  };
  const cancelled = (calls: string[]) => calls.filter((call) => call.startsWith('fail:'));

  it('during --check: stops pnpm, removes its folder, reports once and exits 130', async () => {
    const { deps, log, fire } = signals();
    let dir = '';
    // The stopped pnpm exits non-zero a tick later; nothing may act on that.
    const exec: Exec = async (_cmd, _args, { cwd: at }) => {
      if (!isScratch(at)) return { code: 0, stdout: '10.28.0\n', stderr: '' };
      dir = at;
      fire();
      await new Promise((done) => setTimeout(done, 1));
      return { code: 1, stdout: '', stderr: 'killed' };
    };
    const { calls, ui } = recordingUi();
    const settled = pending(main(['--check'], { cwd, ui, exec, interruptDeps: deps }));
    await vi.waitFor(() => expect(log).toContain('exit 130'));
    await new Promise((done) => setTimeout(done, 20));
    expect(log).toEqual(['stop', `remove ${dir}`, 'exit 130']);
    expect(existsSync(dir)).toBe(false);
    expect(cancelled(calls)).toEqual(['fail: Cancelled. Nothing was written.']);
    expect(settled()).toBe(false);
  });

  it('while reading the git identity: the same, and run never starts', async () => {
    const { deps, log, fire } = signals();
    // Both reads start together; firing on the second lets the first one's result arrive after
    // the signal, and dropping it is all that stops the command from going on.
    const exec: Exec = async (_cmd, args) => {
      if (args[1] === 'user.email') {
        fire();
        await new Promise((done) => setTimeout(done, 1));
      }
      return { code: 0, stdout: 'Ada\n', stderr: '' };
    };
    const generate = vi.fn();
    const { calls, ui } = recordingUi();
    const settled = pending(
      main(['my-tools', '-y'], { cwd, ui, exec, interruptDeps: deps, runDeps: { generate } })
    );
    await vi.waitFor(() => expect(log).toContain('exit 130'));
    await new Promise((done) => setTimeout(done, 20));
    expect(log).toEqual(['stop', 'exit 130']);
    expect(generate).not.toHaveBeenCalled();
    expect(readdirSync(cwd)).toEqual([]);
    expect(calls).toEqual(['stop', 'fail: Cancelled. Nothing was written.']);
    expect(settled()).toBe(false);
  });

  it('during the folder check, which runs no command: only the cancel is printed', async () => {
    const { deps, log, fire } = signals();
    mkdirSync(join(cwd, 'my-tools'));
    writeFileSync(join(cwd, 'my-tools', 'a.txt'), 'a');
    const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
    const { calls, ui } = recordingUi();
    // The last thing before the folder is read: the command finds it not empty after the signal.
    const firing: Ui = {
      ...ui,
      intro: () => {
        ui.intro();
        fire();
      },
    };
    const settled = pending(
      main(['my-tools', '-y'], { cwd, ui: firing, exec, interruptDeps: deps })
    );
    await vi.waitFor(() => expect(log).toContain('exit 130'));
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual(['intro', 'stop', 'fail: Cancelled. Nothing was written.']);
    expect(settled()).toBe(false);
  });

  it('right before run(): run never starts', async () => {
    const { deps, log, fire } = signals();
    const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
    const generate = vi.fn();
    const { calls, ui } = recordingUi();
    const firing: Ui = {
      ...ui,
      intro: () => {
        ui.intro();
        fire();
      },
    };
    const settled = pending(
      main(['my-tools', '-y'], {
        cwd,
        ui: firing,
        exec,
        interruptDeps: deps,
        runDeps: { exec, generate },
      })
    );
    await vi.waitFor(() => expect(log).toContain('exit 130'));
    await new Promise((done) => setTimeout(done, 20));
    expect(generate).not.toHaveBeenCalled();
    expect(calls).toEqual(['intro', 'stop', 'fail: Cancelled. Nothing was written.']);
    expect(settled()).toBe(false);
  });

  it("does nothing while run() runs: run's own handler owns the signal", async () => {
    const { deps, log, fire } = signals();
    const template = join(cwd, 'template');
    mkdirSync(template);
    writeFileSync(join(template, 'package.json'), '{ "packageManager": "pnpm@12.15.0" }\n');
    writeFileSync(join(template, 'pnpm-lock.yaml'), LOCKFILE);
    const exec: Exec = async (cmd, args) =>
      cmd === 'pnpm' && args[0] === '--version'
        ? { code: 0, stdout: '12.15.0\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const runDeps: RunDeps = {
      templateDir: template,
      exec,
      onInterrupt: () => () => undefined,
      generate: async (input) => {
        fire();
        await mkdir(input.to);
        await writeFile(join(input.to, 'package.json'), '{}\n');
        await writeFile(join(input.to, 'pnpm-lock.yaml'), LOCKFILE);
      },
    };
    const { calls, ui } = recordingUi();
    const code = await main(['my-tools', '-y', '--no-git'], {
      cwd,
      ui,
      exec,
      interruptDeps: deps,
      runDeps,
    });
    expect(code).toBe(0);
    expect(log).toEqual([]);
    expect(calls.join('\n')).not.toContain('Cancelled');
  });

  it('after the outcome is printed, a signal only keeps its exit code', async () => {
    const { deps, log, fire, handlers } = signals();
    const exec: Exec = async () => ({ code: 0, stdout: '9.15.9\n', stderr: '' });
    const { calls, ui } = recordingUi();
    const code = await main(['--check'], { cwd, ui, exec, interruptDeps: deps });
    expect(code).toBe(TOOLCHAIN);
    const printed = [...calls];
    // The command-level handler and the exit-code one; only the second still acts.
    expect(handlers).toHaveLength(2);
    fire();
    await new Promise((done) => setTimeout(done, 20));
    expect(process.exitCode).toBe(TOOLCHAIN);
    expect(log).toEqual([]);
    expect(calls).toEqual(printed);
  });
});
