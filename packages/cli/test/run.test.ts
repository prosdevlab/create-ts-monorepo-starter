import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm as rmPromise, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outcome } from '../src/outcome';
import type { Exec, ToolchainError } from '../src/pnpm';
import { leftBehind, leftOf, planFromOptions, type RunDeps, type RunPlan, run } from '../src/run';
import type { Ui } from '../src/ui';
import { backUp, moveIntoPlace, type Probe } from '../src/workspace';

const LOCKFILE = `lockfileVersion: '9.0'

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-x}
`;

let root: string;
let template: string;
let log: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctms-run-'));
  template = join(root, 'template');
  mkdirSync(template);
  writeFileSync(join(template, 'package.json'), '{ "packageManager": "pnpm@12.15.0" }\n');
  writeFileSync(join(template, 'pnpm-lock.yaml'), LOCKFILE);
  log = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const options = { git: true, install: true, force: false, yes: true, help: false, version: false };

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    ...planFromOptions({ ...options, folder: 'my-tools' }, root, new Date(2026, 9, 27), 'Ada'),
    ...overrides,
  };
}

type Reply = { code: number; stdout?: string; stderr?: string };

/** Records each command; `replies` overrides the default answer for a command line prefix. */
function fakeExec(replies: Record<string, Reply | ((cwd: string) => Promise<Reply>)> = {}): Exec {
  return async (cmd, args, { cwd }) => {
    const line = [cmd, ...args].join(' ');
    log.push(line);
    const key = Object.keys(replies).find((prefix) => line.startsWith(prefix));
    const reply = key ? replies[key] : undefined;
    const answer = typeof reply === 'function' ? await reply(cwd) : reply;
    if (answer) return { stdout: '', stderr: '', ...answer };
    if (line === 'pnpm --version') return { code: 0, stdout: '12.15.0\n', stderr: '' };
    if (line.startsWith('git rev-parse')) return { code: 128, stdout: '', stderr: 'not a repo' };
    if (line === 'git config user.name') return { code: 0, stdout: 'Ada\n', stderr: '' };
    if (line === 'git config user.email')
      return { code: 0, stdout: 'ada@example.com\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function recordingUi(): Ui & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    intro: () => calls.push('intro'),
    step: (done, detail) => calls.push(`step: ${done}${detail ? ` | ${detail}` : ''}`),
    start: (label) => calls.push(`start: ${label}`),
    stop: () => calls.push('stop'),
    warn: (title, lines) => calls.push(`warn: ${[title, ...lines].join(' | ')}`),
    fail: (title, lines) => calls.push(`fail: ${[title, ...lines].join(' | ')}`),
    outro: () => calls.push('outro'),
  };
}

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    templateDir: template,
    exec: fakeExec(),
    generate: async (input) => {
      log.push('generate');
      await mkdir(input.to);
      await writeFile(join(input.to, 'package.json'), `{ "name": "${input.folderName}" }\n`);
      await writeFile(join(input.to, 'pnpm-lock.yaml'), LOCKFILE);
    },
    moveIntoPlace: async (temp, target) => {
      log.push('move');
      await rename(temp, target);
    },
    onInterrupt: () => {
      log.push('interrupt');
      return () => log.push('unregister');
    },
    ...overrides,
  };
}

/** Everything in the parent folder except the fake template. */
const leftovers = () => readdirSync(root).filter((name) => name !== 'template');

describe('planFromOptions', () => {
  it('fills the defaults from the folder', () => {
    const now = new Date(2026, 9, 27);
    const result = planFromOptions({ ...options, folder: 'My Tools' }, '/work', now, undefined);
    expect(result).toEqual({
      target: resolve('/work', 'My Tools'),
      folder: 'My Tools',
      folderName: 'my-tools',
      scope: '@my-tools',
      keep: ['lib', 'cli', 'web'],
      git: true,
      install: true,
      now,
      holder: '[YOUR NAME]',
    });
  });

  it('normalizes a given scope and keeps the chosen examples', () => {
    const result = planFromOptions(
      { ...options, folder: 'x', scope: 'Acme', examples: ['cli'], git: false, install: false },
      '/work',
      new Date(),
      'Ada'
    );
    expect(result).toMatchObject({ scope: '@acme', keep: ['cli'], git: false, install: false });
    expect(result.holder).toBe('Ada');
  });

  it('rejects a missing folder and an invalid scope', () => {
    expect(() => planFromOptions(options, '/work', new Date(), undefined)).toThrow(/folder/);
    expect(() =>
      planFromOptions({ ...options, folder: 'x', scope: '@a b' }, '/work', new Date(), undefined)
    ).toThrow(/Scope "@a b"/);
  });
});

describe('run', () => {
  it('runs the steps in order and moves the project into place', async () => {
    const ui = recordingUi();
    const result = await run(plan(), ui, deps());
    expect(log.map((line) => line.replace(/-m .*/, '-m <message>'))).toEqual([
      'interrupt',
      'pnpm --version',
      'pnpm --version',
      'generate',
      'git rev-parse --is-inside-work-tree',
      'git init -q -b main',
      'pnpm install --no-frozen-lockfile',
      'git init -q -b main',
      'git add -A',
      'git config user.name',
      'git config user.email',
      'git commit -q --no-verify -m <message>',
      'move',
      'unregister',
    ]);
    expect(log.find((line) => line.startsWith('git commit'))).toMatch(
      /-m chore: initial commit from create-ts-monorepo-starter \d+\.\d+\.\d+\S* \(template \S+\)$/
    );
    expect(result).toMatchObject({
      pnpm: { kind: 'ok', version: '12.15.0' },
      installed: true,
      git: 'committed',
      packages: ['@my-tools/lib', '@my-tools/shared', '@my-tools/cli', '@my-tools/web'],
    });
    expect(result.seconds).toBeGreaterThanOrEqual(0);
    expect(leftovers()).toEqual(['my-tools']);
    expect(ui.calls).toEqual([
      'step: Created my-tools | @my-tools/lib, @my-tools/shared, @my-tools/cli, @my-tools/web',
      'start: Installing dependencies with pnpm 12.15.0',
      'stop',
      expect.stringMatching(/^step: Installed dependencies with pnpm 12\.15\.0 \(\d+s\)$/),
      'step: Initialized git with a first commit',
    ]);
  });

  it('names the removed examples in the created step', async () => {
    const ui = recordingUi();
    await run(plan({ keep: ['lib', 'cli'], scope: '@acme' }), ui, deps());
    expect(ui.calls[0]).toBe(
      'step: Created my-tools | @acme/lib, @acme/shared, @acme/cli; web removed'
    );
  });

  it('removes the temporary folder and unregisters when generate throws', async () => {
    const failing = deps({
      generate: async (input) => {
        log.push('generate');
        await mkdir(input.to);
        await writeFile(join(input.to, 'half.txt'), 'x');
        throw new Error('disk full');
      },
    });
    await expect(run(plan(), recordingUi(), failing)).rejects.toThrow('disk full');
    expect(leftovers()).toEqual([]);
    expect(log).toEqual([
      'interrupt',
      'pnpm --version',
      'pnpm --version',
      'generate',
      'unregister',
    ]);
  });

  it('stops before generating when pnpm is too old to switch', async () => {
    // Going on would commit the template's lockfile, which still names @monorepo/ packages.
    const exec = fakeExec({ 'pnpm --version': { code: 0, stdout: '9.15.9\n' } });
    const error = await run(plan(), recordingUi(), deps({ exec })).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'ToolchainError',
      message: 'pnpm 9.15.9 is too old for this project',
    });
    expect((error as ToolchainError).lines.at(-1)).toBe(
      'Then run this command again. Nothing was created.'
    );
    expect(log).not.toContain('generate');
    expect(log.filter((line) => line === 'pnpm --version')).toHaveLength(1);
    expect(log.some((line) => line.startsWith('git '))).toBe(false);
    expect(log.at(-1)).toBe('unregister');
    expect(leftovers()).toEqual([]);
  });

  it('installs through npm exec when pnpm is missing, after a warning', async () => {
    const ui = recordingUi();
    const exec = fakeExec({ 'pnpm --version': { code: 127 } });
    const result = await run(plan(), ui, deps({ exec }));
    expect(result.pnpm).toEqual({ kind: 'none' });
    expect(result.installed).toBe(true);
    expect(log).toContainEqual(expect.stringMatching(/^npm exec --yes --package=pnpm@12\.15\.0 /));
    expect(ui.calls).toContain(
      "warn: pnpm isn't installed | Installing with a temporary pnpm 12.15.0 instead (npm exec)."
    );
    expect(ui.calls).toContainEqual(
      expect.stringMatching(/^step: Installed dependencies \(\d+s\)$/)
    );
  });

  it('only updates the lockfile with install off', async () => {
    const ui = recordingUi();
    const result = await run(plan({ install: false }), ui, deps());
    expect(log).toContain('pnpm install --no-frozen-lockfile --lockfile-only');
    expect(result.installed).toBe(false);
    expect(ui.calls).toContain('start: Updating the lockfile');
  });

  it('skips git inside an existing repository, and with git off', async () => {
    const exec = fakeExec({ 'git rev-parse': { code: 0, stdout: 'true\n' } });
    const inside = await run(plan(), recordingUi(), deps({ exec }));
    expect(inside.git).toBe('inside-repo');
    expect(
      log.filter((line) => line.startsWith('git ') && !line.startsWith('git rev-parse'))
    ).toEqual([]);

    rmSync(join(root, 'my-tools'), { recursive: true });
    log = [];
    const off = await run(plan({ git: false }), recordingUi(), deps());
    expect(off.git).toBe('off');
    expect(log.some((line) => line.startsWith('git '))).toBe(false);
  });

  it('reports a missing git and a missing identity', async () => {
    const noGit = await run(
      plan(),
      recordingUi(),
      deps({ exec: fakeExec({ 'git init': { code: 127 } }) })
    );
    expect(noGit.git).toBe('no-git');

    rmSync(join(root, 'my-tools'), { recursive: true });
    const ui = recordingUi();
    const exec = fakeExec({ 'git config user.email': { code: 1 } });
    const noIdentity = await run(plan(), ui, deps({ exec }));
    expect(noIdentity.git).toBe('no-identity');
    expect(ui.calls).toContainEqual(
      expect.stringMatching(/^warn: Initialized git without a commit/)
    );
  });

  it('warns and still moves the project into place when the commit fails', async () => {
    const ui = recordingUi();
    const exec = fakeExec({
      'git commit': { code: 1, stderr: 'error: gpg failed to sign the data' },
    });
    const result = await run(plan(), ui, deps({ exec }));
    expect(result.git).toBe('failed');
    expect(ui.calls).toContainEqual(
      expect.stringMatching(/^warn: Couldn't make the first commit \| .*gpg failed/)
    );
    expect(leftovers()).toEqual(['my-tools']);
    expect(log.at(-1)).toBe('unregister');
  });

  it('warns and continues without git when git init fails', async () => {
    const ui = recordingUi();
    const exec = fakeExec({ 'git init': { code: 129, stderr: "error: unknown switch `b'" } });
    const result = await run(plan(), ui, deps({ exec }));
    expect(result.git).toBe('failed');
    expect(log.filter((line) => line.startsWith('git init'))).toHaveLength(1);
    expect(log.some((line) => line.startsWith('git commit'))).toBe(false);
    expect(ui.calls).toContainEqual(expect.stringMatching(/^warn: Couldn't initialize git/));
    expect(leftovers()).toEqual(['my-tools']);
  });

  it('fails with the last 20 lines of output when the install fails, leaving nothing', async () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const exec = fakeExec({ 'pnpm install': { code: 1, stdout: output, stderr: 'ERR_PNPM_X' } });
    const ui = recordingUi();
    const error = await run(plan(), ui, deps({ exec })).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: "Couldn't install dependencies (pnpm exited with 1)" });
    const lines = (error as { lines: string[] }).lines;
    expect(lines).toHaveLength(20);
    expect(lines.at(0)).toBe('line 12');
    expect(lines.at(-1)).toBe('ERR_PNPM_X');
    expect(ui.calls).toContain('stop');
    expect(leftovers()).toEqual([]);
    expect(log.at(-1)).toBe('unregister');
  });

  it.each([
    ['pnpm install', { install: true }, {}],
    ['pnpm install --no-frozen-lockfile --lockfile-only', { install: false }, {}],
    ['npm exec', { install: true }, { 'pnpm --version': { code: 127 } }],
  ])('gives a failed install the code install-failed (%s)', async (prefix, overrides, base) => {
    const exec = fakeExec({ ...base, [prefix]: { code: 1, stderr: 'boom' } });
    const error = await run(plan(overrides), recordingUi(), deps({ exec })).catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({
      code: 'install-failed',
      message: expect.stringMatching(/^Couldn't /),
    });
  });

  it('stops before the commit when the install added lockfile entries', async () => {
    const exec = fakeExec({
      'pnpm install': async (cwd) => {
        const lockfile = join(cwd, 'pnpm-lock.yaml');
        const text = await readFile(lockfile, 'utf8');
        await writeFile(lockfile, `${text}\n  evil@6.6.6:\n    resolution: {integrity: x}\n`);
        return { code: 0 };
      },
    });
    await expect(run(plan(), recordingUi(), deps({ exec }))).rejects.toThrow(
      /Lockfile changed during install:\n\+ packages: evil@6\.6\.6/
    );
    expect(log.some((line) => line.startsWith('git commit'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('moves a non-empty target aside first when asked to replace it', async () => {
    const target = join(root, 'my-tools');
    mkdirSync(target);
    writeFileSync(join(target, 'notes.txt'), 'keep me');
    const ui = recordingUi();
    const result = await run(plan({ replace: true }), ui, deps());
    expect(result.backup).toBe(`${target}.backup-20261027-000000`);
    expect(await readFile(join(`${target}.backup-20261027-000000`, 'notes.txt'), 'utf8')).toBe(
      'keep me'
    );
    expect(await readdir(target)).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(ui.calls).toContain('step: Moved the old my-tools to my-tools.backup-20261027-000000');
  });

  it('backs up the current folder entry by entry, so it keeps its path', async () => {
    const target = join(root, 'my-tools');
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'notes.txt'), 'keep me');
    const ui = recordingUi();
    const moveIntoPlace: RunDeps['moveIntoPlace'] = async (temp, to) => {
      log.push('move');
      // The real moveIntoPlace moves entries into an empty target; the folder must still exist.
      expect(await readdir(to)).toEqual([]);
      for (const entry of await readdir(temp)) await rename(join(temp, entry), join(to, entry));
      rmSync(temp, { recursive: true });
    };
    const result = await run(plan({ replace: true }), ui, deps({ cwd: target, moveIntoPlace }));
    const backup = `${target}.backup-20261027-000000`;
    expect(result.backup).toBe(backup);
    expect((await readdir(backup)).sort()).toEqual(['notes.txt', 'src']);
    expect(await readdir(target)).toEqual(['package.json', 'pnpm-lock.yaml']);
  });

  it('stops before generating when pnpm cannot switch to the template version', async () => {
    const exec = fakeExec({
      'pnpm --version': async (cwd) =>
        cwd === tmpdir()
          ? { code: 0, stdout: '10.28.0\n' }
          : { code: 1, stderr: 'ERROR  Failed to switch pnpm to v12.15.0.' },
    });
    const error = await run(plan(), recordingUi(), deps({ exec })).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'ToolchainError',
      message: "pnpm 10.28.0 couldn't switch to pnpm 12.15.0, which this project needs",
    });
    expect(log).not.toContain('generate');
    expect(log.at(-1)).toBe('unregister');
    expect(leftovers()).toEqual([]);
  });

  it('skips the switch check when pnpm is missing', async () => {
    await run(plan(), recordingUi(), deps({ exec: fakeExec({ 'pnpm --version': { code: 127 } }) }));
    expect(log.filter((line) => line === 'pnpm --version')).toHaveLength(1);
  });

  it('runs pnpm --version outside any project, then in a folder pinned to the template pnpm', async () => {
    const cwds: string[] = [];
    const base = fakeExec();
    const exec: Exec = async (cmd, args, opts) => {
      if (cmd === 'pnpm' && args[0] === '--version') cwds.push(opts.cwd);
      return base(cmd, args, opts);
    };
    await run(plan(), recordingUi(), deps({ exec }));
    expect(cwds).toEqual([tmpdir(), expect.stringContaining(join(tmpdir(), 'ctms-pnpm-'))]);
  });

  it('never touches a non-empty target without replace', async () => {
    const target = join(root, 'my-tools');
    mkdirSync(target);
    writeFileSync(join(target, 'notes.txt'), 'keep me');
    await expect(run(plan(), recordingUi(), deps({ moveIntoPlace: undefined }))).rejects.toThrow(
      /has files/
    );
    expect(leftovers()).toEqual(['my-tools']);
    expect(await readdir(target)).toEqual(['notes.txt']);
  });

  it('removes the temporary folder with the rm it is given', async () => {
    const removed: string[] = [];
    const rm: RunDeps['rm'] = async (path, options) => {
      removed.push(String(path));
      expect(options).toEqual({ recursive: true, force: true });
    };
    const generate: RunDeps['generate'] = async () => {
      throw new Error('stop here');
    };
    await expect(run(plan(), recordingUi(), deps({ generate, rm }))).rejects.toThrow('stop here');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/\.my-tools\.tmp-[0-9a-f]{8}$/);
  });

  describe('on Ctrl-C', () => {
    type Exit = (code: number, outcome: { removed: boolean; stopped: boolean }) => void;
    const CLEAN = { removed: true, stopped: true };
    let interrupt: Exit | undefined;
    const catching = (overrides: Partial<RunDeps> = {}) =>
      deps({
        onInterrupt: (_temp, options) => {
          interrupt = options?.exit;
          return () => log.push('unregister');
        },
        ...overrides,
      });
    beforeEach(() => {
      interrupt = undefined;
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    });

    it('says nothing was written before the backup starts', async () => {
      const ui = recordingUi();
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, CLEAN);
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      expect(ui.calls).toEqual(['stop', 'fail: Cancelled. Nothing was written.']);
      expect(process.exit).toHaveBeenCalledWith(130);
    });

    it('says where the files are once they were moved aside', async () => {
      const target = join(root, 'my-tools');
      mkdirSync(target);
      writeFileSync(join(target, 'notes.txt'), 'keep me');
      const ui = recordingUi();
      const moveIntoPlace: RunDeps['moveIntoPlace'] = async () => {
        interrupt?.(130, CLEAN);
      };
      await run(plan({ replace: true }), ui, catching({ moveIntoPlace }));
      const backup = `${target}.backup-20261027-000000`;
      expect(ui.calls.slice(-2)).toEqual([
        'stop',
        `fail: Cancelled. Your files are in ${backup}. | The new project in ${target} may be incomplete.`,
      ]);
      expect(ui.calls.join('\n')).not.toContain('Nothing was written');
      expect(process.exit).toHaveBeenCalledWith(130);
    });

    it('names the temp folder when it could not be deleted, and a pnpm that would not stop', async () => {
      const ui = recordingUi();
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, { removed: false, stopped: false });
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      const last = ui.calls.at(-1) ?? '';
      expect(last).toMatch(
        /^fail: Cancelled\. \| Couldn't delete the temporary folder .*\.my-tools\.tmp-[0-9a-f]{8}: delete it yourself\. \| pnpm may still be running in it\.$/
      );
      expect(last).not.toContain('Nothing was written');
    });

    it('never returns from a command once a signal arrived', async () => {
      let start: (() => void) | undefined;
      const ui = recordingUi();
      const exec = fakeExec({
        'pnpm install': async () => {
          start?.();
          return { code: 143 };
        },
      });
      const running = run(
        plan(),
        ui,
        deps({
          exec,
          onInterrupt: (_temp, options) => {
            start = options?.onStart;
            return () => undefined;
          },
        })
      );
      const settled = await Promise.race([
        running.then(
          () => 'resolved',
          () => 'rejected'
        ),
        new Promise((done) => setTimeout(() => done('pending'), 100)),
      ]);
      expect(settled).toBe('pending');
      expect(ui.calls.some((call) => call.startsWith('fail:'))).toBe(false);
    });

    it('does not claim nothing was written after the move', async () => {
      const ui = recordingUi();
      await run(plan(), ui, catching());
      interrupt?.(130, CLEAN);
      expect(ui.calls.at(-1)).toBe(
        `fail: Cancelled after the project was created in ${join(root, 'my-tools')}.`
      );
    });

    describe('while the disk is busy', () => {
      const BACKUP = 'my-tools.backup-20261027-000000';
      /** Fires the interrupt like a signal would, then never returns, as a real `process.exit` wouldn't. */
      const hang =
        (outcome: { removed: boolean; stopped: boolean }): typeof rename =>
        () => {
          interrupt?.(130, outcome);
          return new Promise<void>(() => undefined);
        };
      const nonEmpty = () => {
        const target = join(root, 'my-tools');
        mkdirSync(target);
        writeFileSync(join(target, 'notes.txt'), 'keep me');
        return target;
      };
      /** `run` never settles here, so wait for the message instead. */
      const message = async (ui: ReturnType<typeof recordingUi>) => {
        await vi.waitFor(() =>
          expect(ui.calls.some((call) => call.startsWith('fail:'))).toBe(true)
        );
        return ui.calls.slice(ui.calls.lastIndexOf('stop'));
      };

      it('names both places while backing up a folder that is not the current one', async () => {
        const target = nonEmpty();
        const ui = recordingUi();
        const backUpHung: RunDeps['backUp'] = (t, now, d) =>
          backUp(t, now, { ...d, rename: hang(CLEAN) });
        void run(plan({ replace: true }), ui, catching({ backUp: backUpHung }));
        expect(await message(ui)).toEqual([
          'stop',
          `fail: Cancelled. Your files are in ${target}, or in ${BACKUP} beside it.`,
        ]);
        expect(process.exit).toHaveBeenCalledWith(130);
      });

      it('names the target, the backup and a split while backing up the current folder', async () => {
        const target = nonEmpty();
        const ui = recordingUi();
        const backUpHung: RunDeps['backUp'] = (t, now, d) =>
          backUp(t, now, { ...d, rename: hang(CLEAN) });
        void run(plan({ replace: true }), ui, catching({ cwd: target, backUp: backUpHung }));
        expect(await message(ui)).toEqual([
          'stop',
          `fail: Cancelled. Your files are in ${target}, in ${BACKUP} beside it, or split between the two.`,
        ]);
      });

      it('adds both leftovers while backing up when nothing was cleaned up or stopped', async () => {
        const target = nonEmpty();
        const ui = recordingUi();
        const backUpHung: RunDeps['backUp'] = (t, now, d) =>
          backUp(t, now, { ...d, rename: hang({ removed: false, stopped: false }) });
        void run(plan({ replace: true }), ui, catching({ cwd: target, backUp: backUpHung }));
        expect((await message(ui)).at(-1)).toMatch(
          new RegExp(
            `^fail: Cancelled\\. Your files are in .*my-tools, in ${BACKUP} beside it, or split between the two\\. \\| Couldn't delete the temporary folder .*\\.my-tools\\.tmp-[0-9a-f]{8}: delete it yourself\\. \\| pnpm may still be running in it\\.$`
          )
        );
      });

      it('says the move was cancelled when no backup exists', async () => {
        const ui = recordingUi();
        const move: RunDeps['moveIntoPlace'] = (temp, to) =>
          moveIntoPlace(temp, to, { rename: hang(CLEAN) });
        void run(plan(), ui, catching({ moveIntoPlace: move }));
        expect(await message(ui)).toEqual([
          'stop',
          `fail: Cancelled while moving the project into place. | The new project in ${join(root, 'my-tools')} may be incomplete.`,
        ]);
        expect(process.exit).toHaveBeenCalledWith(130);
      });

      it('adds the pnpm line when the temp folder went but pnpm did not stop', async () => {
        const ui = recordingUi();
        const move: RunDeps['moveIntoPlace'] = (temp, to) =>
          moveIntoPlace(temp, to, { rename: hang({ removed: true, stopped: false }) });
        void run(plan(), ui, catching({ moveIntoPlace: move }));
        expect(await message(ui)).toEqual([
          'stop',
          `fail: Cancelled while moving the project into place. | The new project in ${join(root, 'my-tools')} may be incomplete. | pnpm may still be running in it.`,
        ]);
      });

      it('adds the temp folder line when pnpm stopped but the folder could not be deleted', async () => {
        const ui = recordingUi();
        const move: RunDeps['moveIntoPlace'] = (temp, to) =>
          moveIntoPlace(temp, to, { rename: hang({ removed: false, stopped: true }) });
        void run(plan(), ui, catching({ moveIntoPlace: move }));
        expect((await message(ui)).at(-1)).toMatch(
          /^fail: Cancelled while moving the project into place\. \| The new project in .*my-tools may be incomplete\. \| Couldn't delete the temporary folder .*\.my-tools\.tmp-[0-9a-f]{8}: delete it yourself\.$/
        );
      });
    });

    it('says only that pnpm may still run when the temp folder went but pnpm did not stop', async () => {
      const ui = recordingUi();
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, { removed: true, stopped: false });
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      expect(ui.calls).toEqual([
        'stop',
        'fail: Cancelled. Nothing was written. | pnpm may still be running in it.',
      ]);
    });

    it('says only that the temp folder is left when pnpm stopped but the folder stayed', async () => {
      const ui = recordingUi();
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, { removed: false, stopped: true });
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      expect(ui.calls).toHaveLength(2);
      expect(ui.calls.at(-1)).toMatch(
        /^fail: Cancelled\. \| Couldn't delete the temporary folder .*\.my-tools\.tmp-[0-9a-f]{8}: delete it yourself\.$/
      );
    });

    it('still exits 130 when the Ui throws, and the error stays in the handler', async () => {
      const ui = recordingUi();
      ui.fail = () => {
        throw new Error('write EPIPE');
      };
      const generate: RunDeps['generate'] = async () => {
        expect(() => interrupt?.(130, CLEAN)).not.toThrow();
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      expect(process.exit).toHaveBeenCalledWith(130);
    });
  });
});

describe('what the run left behind', () => {
  const STAMP = '20261027-000000';
  const CLEAN = { removed: true, stopped: true };
  const never = () => new Promise<void>(() => undefined);
  const eio = () => Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
  /** A `rename` that fails with EIO (never retried) on its Nth call. */
  const failingOn = (nth: number): typeof rename => {
    let calls = 0;
    return (async (from, to) => {
      calls += 1;
      if (calls === nth) throw eio();
      await rename(from, to);
    }) as typeof rename;
  };
  const target = () => join(root, 'my-tools');
  const backupDir = () => `${target()}.backup-${STAMP}`;
  const nonEmpty = (...names: string[]) => {
    mkdirSync(target());
    for (const name of names.length ? names : ['notes.txt']) {
      writeFileSync(join(target(), name), name);
    }
  };
  const backUpWith =
    (renameFn: typeof rename): RunDeps['backUp'] =>
    (t, now, d) =>
      backUp(t, now, { ...d, rename: renameFn });
  const moveWith =
    (renameFn: typeof rename): RunDeps['moveIntoPlace'] =>
    (temp, to) =>
      moveIntoPlace(temp, to, { rename: renameFn });
  /** Runs to a failure and returns the `left` that run() recorded. */
  const stopped = async (planOverrides: Partial<RunPlan>, overrides: Partial<RunDeps> = {}) => {
    const error = await run(plan(planOverrides), recordingUi(), deps(overrides)).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    return leftOf(error);
  };

  describe('after a failure, against the disk', () => {
    it('a toolchain failure with replace on a non-empty target leaves it unchanged', async () => {
      nonEmpty();
      const exec = fakeExec({ 'pnpm --version': { code: 0, stdout: '9.15.9\n' } });
      expect(await stopped({ replace: true }, { exec })).toEqual({ target: 'unchanged' });
      expect(readdirSync(target())).toEqual(['notes.txt']);
    });

    it('a failed install leaves the target as it was, with no temp folder', async () => {
      const exec = fakeExec({ 'pnpm install': { code: 1 } });
      expect(await stopped({}, { exec })).toEqual({ target: 'missing' });
      mkdirSync(target());
      expect(await stopped({}, { exec })).toEqual({ target: 'empty' });
      expect(leftovers()).toEqual(['my-tools']);
    });

    it('never touches a non-empty target without replace', async () => {
      nonEmpty();
      expect(await stopped({}, { moveIntoPlace: undefined })).toEqual({ target: 'unchanged' });
      expect(readdirSync(target())).toEqual(['notes.txt']);
    });

    it('backup failing on the first entry, in place: unchanged, no backup folder', async () => {
      nonEmpty('a.txt', 'b.txt');
      const left = await stopped(
        { replace: true },
        { cwd: target(), backUp: backUpWith(failingOn(1)) }
      );
      expect(left).toEqual({ target: 'unchanged' });
      expect(readdirSync(target()).sort()).toEqual(['a.txt', 'b.txt']);
      expect(leftovers().some((name) => name.includes('.backup-'))).toBe(false);
    });

    it('backup failing on a later entry: split, the backup holds exactly the moved entries', async () => {
      nonEmpty('a.txt', 'b.txt');
      const left = await stopped(
        { replace: true },
        { cwd: target(), backUp: backUpWith(failingOn(2)) }
      );
      expect(left).toEqual({ target: 'split', backup: backupDir() });
      const moved = readdirSync(backupDir());
      expect(moved).toHaveLength(1);
      expect([...moved, ...readdirSync(target())].sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('backup failing on a whole-folder rename: unchanged, no backup', async () => {
      nonEmpty('a.txt', 'b.txt');
      const left = await stopped({ replace: true }, { backUp: backUpWith(failingOn(1)) });
      expect(left).toEqual({ target: 'unchanged' });
      expect(readdirSync(target()).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('move failing after an in-place backup, before any entry moved: empty, with the backup', async () => {
      nonEmpty('a.txt');
      const left = await stopped(
        { replace: true },
        { cwd: target(), moveIntoPlace: moveWith(failingOn(1)) }
      );
      expect(left).toEqual({ target: 'empty', backup: backupDir() });
      expect(readdirSync(backupDir())).toEqual(['a.txt']);
    });

    it('move failing after a whole-folder backup: missing, with the backup', async () => {
      nonEmpty('a.txt');
      const left = await stopped({ replace: true }, { moveIntoPlace: moveWith(failingOn(1)) });
      expect(left).toEqual({ target: 'missing', backup: backupDir() });
      expect(readdirSync(backupDir())).toEqual(['a.txt']);
    });

    it('move failing partway into an empty target: partial', async () => {
      mkdirSync(target());
      const left = await stopped({}, { moveIntoPlace: moveWith(failingOn(2)) });
      expect(left).toEqual({ target: 'partial' });
      expect(readdirSync(target())).toHaveLength(1);
    });

    it('reports a temporary folder that could not be deleted', async () => {
      const exec = fakeExec({ 'pnpm install': { code: 1, stderr: 'network down' } });
      const rm: RunDeps['rm'] = async () => {
        throw new Error('EBUSY');
      };
      const error = await run(plan(), recordingUi(), deps({ exec, rm })).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'install-failed' });
      expect(leftOf(error)).toEqual({
        target: 'missing',
        temp: expect.stringMatching(/\.my-tools\.tmp-[0-9a-f]{8}$/),
      });
    });

    it('reports the temporary folder by what is on disk, not by whether rm threw', async () => {
      const exec = fakeExec({ 'pnpm install': { code: 1, stderr: 'network down' } });
      // An rm that resolves but leaves the folder: still reported.
      const keeps: RunDeps['rm'] = async () => undefined;
      const kept = await run(plan(), recordingUi(), deps({ exec, rm: keeps })).catch(
        (e: unknown) => e
      );
      expect(leftOf(kept)).toHaveProperty('temp');
      // An rm that deletes, then throws: nothing is left, so nothing is reported.
      const deletes: RunDeps['rm'] = async (path, options) => {
        await rmPromise(path, options);
        throw new Error('EBUSY after the fact');
      };
      const gone = await run(plan(), recordingUi(), deps({ exec, rm: deletes })).catch(
        (e: unknown) => e
      );
      expect(gone).toMatchObject({ code: 'install-failed' });
      expect(leftOf(gone)).not.toHaveProperty('temp');
    });

    it('rethrows a thrown string untouched and records nothing for it', async () => {
      const generate: RunDeps['generate'] = async () => {
        throw 'just a string';
      };
      const error = await run(plan(), recordingUi(), deps({ generate })).catch((e: unknown) => e);
      expect(error).toBe('just a string');
      expect(leftOf(error)).toBeUndefined();
    });
  });

  describe('leftBehind, with a fake read', () => {
    const reads =
      (found: Record<string, Probe>) =>
      (path: string): Probe =>
        found[path] ?? 'missing';
    const T = '/t';
    const B = '/t.backup';
    const row = (
      phase: Parameters<typeof leftBehind>[0],
      before: Parameters<typeof leftBehind>[1],
      found: Record<string, Probe>
    ) => leftBehind(phase, before, reads(found), T);

    it.each([
      ['missing', { target: 'missing' }],
      ['empty', { target: 'empty' }],
      ['not-empty', { target: 'unchanged' }],
    ] as const)('working, before %s', (before, left) => {
      const read = () => {
        throw new Error('not read');
      };
      expect(leftBehind({ at: 'working' }, before, read, T)).toEqual(left);
    });

    it('working with an unknown before is unknown', () => {
      expect(leftBehind({ at: 'working' }, undefined, reads({}), T)).toEqual({ target: 'unknown' });
    });

    it('backing up before onPath: unchanged, nothing read, no backup', () => {
      const read = () => {
        throw new Error('not read');
      };
      expect(leftBehind({ at: 'backing-up', inPlace: true }, 'not-empty', read, T)).toEqual({
        target: 'unchanged',
      });
    });

    it.each([
      ['backing-up', { at: 'backing-up', inPlace: true, backup: B }],
      ['backed-up', { at: 'backed-up', backup: B }],
    ] as const)('%s, with a backup path', (_name, phase) => {
      expect(row(phase, 'not-empty', { [T]: 'not-empty', [B]: 'missing' })).toEqual({
        target: 'unchanged',
      });
      expect(row(phase, 'not-empty', { [T]: 'not-empty', [B]: 'empty' })).toEqual({
        target: 'unchanged',
      });
      expect(row(phase, 'not-empty', { [T]: 'not-empty', [B]: 'not-empty' })).toEqual({
        target: 'split',
        backup: B,
      });
      expect(row(phase, 'not-empty', { [T]: 'missing', [B]: 'not-empty' })).toEqual({
        target: 'missing',
        backup: B,
      });
      expect(row(phase, 'not-empty', { [T]: 'empty', [B]: 'not-empty' })).toEqual({
        target: 'empty',
        backup: B,
      });
      expect(row(phase, 'not-empty', { [T]: 'missing', [B]: 'missing' })).toEqual({
        target: 'unknown',
      });
      expect(row(phase, 'not-empty', { [T]: 'unreadable', [B]: 'not-empty' })).toEqual({
        target: 'unknown',
        backup: B,
      });
      // Files still in the target, and a backup that can't be read: never "unchanged".
      expect(row(phase, 'not-empty', { [T]: 'not-empty', [B]: 'unreadable' })).toEqual({
        target: 'unknown',
      });
    });

    it('moving: an empty or missing target keeps the backup only if it holds files', () => {
      const phase = { at: 'moving', backup: B } as const;
      expect(row(phase, 'not-empty', { [T]: 'missing', [B]: 'not-empty' })).toEqual({
        target: 'missing',
        backup: B,
      });
      expect(row(phase, 'not-empty', { [T]: 'empty', [B]: 'empty' })).toEqual({ target: 'empty' });
      expect(row({ at: 'moving' }, 'missing', { [T]: 'missing' })).toEqual({ target: 'missing' });
      // backUp has returned: a backup that can't be read is still where the files are.
      expect(row(phase, 'not-empty', { [T]: 'missing', [B]: 'unreadable' })).toEqual({
        target: 'missing',
        backup: B,
      });
    });

    it('moving into a target that has files is partial, unless nothing was allowed to move', () => {
      expect(row({ at: 'moving' }, 'missing', { [T]: 'not-empty' })).toEqual({ target: 'partial' });
      expect(row({ at: 'moving' }, 'empty', { [T]: 'not-empty' })).toEqual({ target: 'partial' });
      expect(
        row({ at: 'moving', backup: B }, 'not-empty', { [T]: 'not-empty', [B]: 'not-empty' })
      ).toEqual({ target: 'partial', backup: B });
      expect(row({ at: 'moving' }, 'not-empty', { [T]: 'not-empty' })).toEqual({
        target: 'unchanged',
      });
      // The target's state at the start couldn't be read: don't guess.
      expect(row({ at: 'moving' }, undefined, { [T]: 'not-empty' })).toEqual({ target: 'unknown' });
    });

    it('moved is complete, without reading, with the backup if there is one', () => {
      const read = () => {
        throw new Error('not read');
      };
      expect(leftBehind({ at: 'moved' }, 'missing', read, T)).toEqual({ target: 'complete' });
      expect(leftBehind({ at: 'moved', backup: B }, 'not-empty', read, T)).toEqual({
        target: 'complete',
        backup: B,
      });
    });

    it('an unreadable target is unknown, naming the backup only if it holds files', () => {
      const phase = { at: 'moving', backup: B } as const;
      expect(row(phase, 'not-empty', { [T]: 'unreadable', [B]: 'not-empty' })).toEqual({
        target: 'unknown',
        backup: B,
      });
      expect(row(phase, 'not-empty', { [T]: 'unreadable', [B]: 'unreadable' })).toEqual({
        target: 'unknown',
      });
    });
  });

  describe('on Ctrl-C, through onOutcome', () => {
    type Exit = (code: number, outcome: { removed: boolean; stopped: boolean }) => void;
    let interrupt: Exit | undefined;
    let outcomes: Outcome[];
    beforeEach(() => {
      interrupt = undefined;
      outcomes = [];
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    });
    const catching = (overrides: Partial<RunDeps> = {}) =>
      deps({
        onInterrupt: (_temp, options) => {
          interrupt = options?.exit;
          return () => log.push('unregister');
        },
        onOutcome: (outcome) => outcomes.push(outcome),
        ...overrides,
      });
    /** Fires the interrupt like a signal, then never returns, as a real `process.exit` wouldn't. */
    const hang =
      (outcome = CLEAN, land = false): typeof rename =>
      async (from, to) => {
        if (land) await rename(from, to);
        interrupt?.(130, outcome);
        return never();
      };
    const left = async (ui: ReturnType<typeof recordingUi>) => {
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(ui.calls.some((call) => call.startsWith('fail:'))).toBe(true);
      const [outcome] = outcomes;
      expect(outcome).toMatchObject({ ok: false, error: { code: 'interrupted' } });
      return outcome && !outcome.ok ? outcome.left : undefined;
    };
    const ctrlC = async (planOverrides: Partial<RunPlan>, overrides: Partial<RunDeps>) => {
      const ui = recordingUi();
      void run(plan(planOverrides), ui, catching(overrides));
      return { ui, found: await left(ui) };
    };

    it('while working: the target as it was', async () => {
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, CLEAN);
        throw new Error('stop here');
      };
      const ui = recordingUi();
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      expect(outcomes[0]).toMatchObject({ left: { target: 'missing' } });
      expect(outcomes[0]).not.toHaveProperty('left.temp');
    });

    it('says what stayed behind when nothing was cleaned up or stopped', async () => {
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, { removed: false, stopped: false });
        throw new Error('stop here');
      };
      await expect(run(plan(), recordingUi(), catching({ generate }))).rejects.toThrow();
      expect(outcomes[0]).toMatchObject({
        left: { target: 'missing', temp: expect.stringMatching(/\.my-tools\.tmp-/), running: true },
      });
    });

    it('while backing up a folder that is not the current one, before the rename lands: unchanged', async () => {
      nonEmpty();
      const { found } = await ctrlC({ replace: true }, { backUp: backUpWith(hang()) });
      expect(found).toEqual({ target: 'unchanged' });
      expect(readdirSync(target())).toEqual(['notes.txt']);
    });

    it('after the whole-folder rename landed, reports the backup', async () => {
      nonEmpty();
      const { found } = await ctrlC({ replace: true }, { backUp: backUpWith(hang(CLEAN, true)) });
      expect(found).toEqual({ target: 'missing', backup: backupDir() });
    });

    it('after a target that is a file was renamed away, reports it as the backup', async () => {
      writeFileSync(target(), 'i am a file');
      const { found } = await ctrlC({ replace: true }, { backUp: backUpWith(hang(CLEAN, true)) });
      expect(found).toEqual({ target: 'missing', backup: backupDir() });
    });

    it('names the -1 folder when the base backup name is taken', async () => {
      nonEmpty();
      mkdirSync(backupDir());
      writeFileSync(join(backupDir(), 'older.txt'), 'older');
      const { ui, found } = await ctrlC(
        { replace: true },
        { backUp: backUpWith(hang(CLEAN, true)) }
      );
      expect(found).toEqual({ target: 'missing', backup: `${backupDir()}-1` });
      expect(ui.calls.at(-1)).toBe(
        `fail: Cancelled. Your files are in ${target()}, or in my-tools.backup-${STAMP}-1 beside it.`
      );
    });

    it('in place, before the first entry moves: unchanged, and the empty backup folder is removed', async () => {
      nonEmpty('a.txt', 'b.txt');
      const { found } = await ctrlC(
        { replace: true },
        { cwd: target(), backUp: backUpWith(hang()) }
      );
      expect(found).toEqual({ target: 'unchanged' });
      expect(existsSync(backupDir())).toBe(false);
      expect(readdirSync(target()).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('in place, with a report that throws: still exits 130 and removes the empty backup folder', async () => {
      nonEmpty('a.txt', 'b.txt');
      const report = () => {
        throw new Error('write EPIPE');
      };
      void run(
        plan({ replace: true }),
        recordingUi(),
        catching({ cwd: target(), backUp: backUpWith(hang()), report })
      );
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(process.exit).toHaveBeenCalledWith(130);
      expect(existsSync(backupDir())).toBe(false);
      expect(readdirSync(target()).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('gives onOutcome what report returned', async () => {
      const retry = { argv: ['-y', '--', 'my-tools'], cwd: root };
      const ui = recordingUi();
      const report = (outcome: Outcome): Outcome => (outcome.ok ? outcome : { ...outcome, retry });
      const generate: RunDeps['generate'] = async () => {
        interrupt?.(130, CLEAN);
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate, report }))).rejects.toThrow('stop here');
      expect(outcomes[0]).toMatchObject({ error: { code: 'interrupted' }, retry });
      // The default text print was replaced, not added to.
      expect(ui.calls.some((call) => call.startsWith('fail:'))).toBe(false);
    });

    it('in place, after one entry moved: split, and the backup folder and its entry stay', async () => {
      nonEmpty('a.txt', 'b.txt');
      const { found } = await ctrlC(
        { replace: true },
        { cwd: target(), backUp: backUpWith(hang(CLEAN, true)) }
      );
      expect(found).toEqual({ target: 'split', backup: backupDir() });
      expect(readdirSync(backupDir())).toHaveLength(1);
      expect(readdirSync(target())).toHaveLength(1);
    });

    it('before the backup path is known, an earlier empty backup folder is not touched', async () => {
      nonEmpty('a.txt');
      mkdirSync(backupDir());
      const backUpEarly: RunDeps['backUp'] = async () => {
        interrupt?.(130, CLEAN);
        return never() as never;
      };
      const { found } = await ctrlC({ replace: true }, { cwd: target(), backUp: backUpEarly });
      expect(found).toEqual({ target: 'unchanged' });
      expect(existsSync(backupDir())).toBe(true);
    });

    it('while moving with no backup, after the rename landed: partial', async () => {
      const { found } = await ctrlC({}, { moveIntoPlace: moveWith(hang(CLEAN, true)) });
      expect(found).toEqual({ target: 'partial' });
    });

    it('while moving after a backup, before the rename lands: missing, with the backup', async () => {
      nonEmpty();
      const { found } = await ctrlC({ replace: true }, { moveIntoPlace: moveWith(hang()) });
      expect(found).toEqual({ target: 'missing', backup: backupDir() });
    });

    it('after the move: complete', async () => {
      const ui = recordingUi();
      await run(plan(), ui, catching());
      interrupt?.(130, CLEAN);
      expect(outcomes[0]).toMatchObject({ left: { target: 'complete' } });
    });

    it('after the move with a backup: complete, naming it', async () => {
      nonEmpty();
      await run(plan({ replace: true }), recordingUi(), catching());
      interrupt?.(130, CLEAN);
      expect(outcomes[0]).toMatchObject({ left: { target: 'complete', backup: backupDir() } });
    });

    describe('when reading the disk or reporting fails', () => {
      it.each([
        ['backing up', 'backUp'],
        ['moving', 'moveIntoPlace'],
      ] as const)(
        'still prints and exits 130 when the probe throws while %s',
        async (_name, step) => {
          nonEmpty();
          const probe = vi.fn((): never => {
            throw new Error('EIO on read');
          });
          const ui = recordingUi();
          const overrides =
            step === 'backUp'
              ? { backUp: backUpWith(hang()) }
              : { moveIntoPlace: moveWith(hang()) };
          void run(plan({ replace: true }), ui, catching({ ...overrides, probe }));
          await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(130));
          expect(probe).toHaveBeenCalled();
          expect(ui.calls.at(-1)).toMatch(/^fail: Cancelled\. Your files are in /);
          expect(outcomes[0]).toMatchObject({ left: { target: 'unknown' } });
        }
      );

      it('still prints and exits 130 when onOutcome throws', async () => {
        nonEmpty();
        const ui = recordingUi();
        const onOutcome = vi.fn((): never => {
          throw new Error('consumer broke');
        });
        void run(plan({ replace: true }), ui, catching({ backUp: backUpWith(hang()), onOutcome }));
        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(130));
        expect(onOutcome).toHaveBeenCalled();
        expect(ui.calls.at(-1)).toMatch(/^fail: Cancelled\. Your files are in /);
      });
    });
  });
});
