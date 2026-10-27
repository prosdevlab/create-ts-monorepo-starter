import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../src/pnpm';
import { planFromOptions, type RunDeps, type RunPlan, run } from '../src/run';
import type { Ui } from '../src/ui';

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
      'generate',
      'git rev-parse --is-inside-work-tree',
      'git init -q -b main',
      'pnpm --version',
      'pnpm install',
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
    expect(log).toEqual(['interrupt', 'generate', 'unregister']);
  });

  it('skips the install when pnpm is too old, and still commits', async () => {
    const ui = recordingUi();
    const exec = fakeExec({ 'pnpm --version': { code: 0, stdout: '9.15.9\n' } });
    const result = await run(plan(), ui, deps({ exec }));
    expect(result).toMatchObject({ installed: false, git: 'committed' });
    expect(result.pnpm).toEqual({ kind: 'old', version: '9.15.9' });
    expect(log).not.toContain('pnpm install');
    expect(log.some((line) => line.startsWith('git commit'))).toBe(true);
    expect(ui.calls).toContainEqual(
      expect.stringMatching(/^fail: pnpm 9\.15\.9 is too old for this project \| /)
    );
    expect(leftovers()).toEqual(['my-tools']);
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
    expect(log).toContain('pnpm install --lockfile-only');
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

  it('warns and still moves the project into place when the commit fails (Ruling 11)', async () => {
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

  describe('on Ctrl-C', () => {
    type Exit = (code: number) => void;
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
        interrupt?.(130);
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
        interrupt?.(130);
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

    it('does not claim nothing was written after the move', async () => {
      const ui = recordingUi();
      await run(plan(), ui, catching());
      interrupt?.(130);
      expect(ui.calls.at(-1)).toBe(
        `fail: Cancelled after the project was created in ${join(root, 'my-tools')}.`
      );
    });

    it('still exits 130 when the Ui throws', async () => {
      const ui = recordingUi();
      ui.fail = () => {
        throw new Error('write EPIPE');
      };
      const generate: RunDeps['generate'] = async () => {
        expect(() => interrupt?.(130)).toThrow('EPIPE');
        throw new Error('stop here');
      };
      await expect(run(plan(), ui, catching({ generate }))).rejects.toThrow('stop here');
      expect(process.exit).toHaveBeenCalledWith(130);
    });
  });
});
