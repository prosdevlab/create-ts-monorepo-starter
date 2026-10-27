import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as p from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/main';
import { CANCELLED, type Prompts, type Ui } from '../../src/ui';
import { bin, exec, type Sandbox, sandbox, tail } from './helpers';

let box: Sandbox;
let passed: boolean;
beforeEach(({ task }) => {
  box = sandbox(task.name.split(' ')[0] ?? 'interrupt');
  passed = false;
});
afterEach(({ task }) => {
  passed = task.result?.state === 'pass';
  box.cleanup(passed);
});

const leftovers = (name: string) =>
  readdirSync(box.work).filter((entry) => entry.startsWith(`.${name}.tmp-`));

/** Resolves once no process in the group is left, so nothing can still write to the folder. */
async function groupGone(pid: number) {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`process group ${pid} is still running`);
}

const settle = () => new Promise((done) => setTimeout(done, 3000));

describe('interrupting and replacing', () => {
  // Windows has no SIGINT to send to another process; a terminal's Ctrl-C reaches the whole group.
  it.skipIf(process.platform === 'win32')(
    'Ctrl-C during the install exits 130 and leaves nothing',
    async () => {
      const child = spawn(process.execPath, [bin, 'p-int', '-y'], {
        cwd: box.work,
        env: box.env,
        detached: true,
      });
      let stdout = '';
      let sent = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes('Installing')) {
          sent = true;
          process.kill(-(child.pid as number), 'SIGINT');
        }
      });
      child.stderr.resume();
      const code = await new Promise<number | null>((done) => child.on('close', done));
      await groupGone(child.pid as number);
      // pnpm runs in its own process group: give anything still running time to write.
      await settle();
      expect(sent, stdout).toBe(true);
      expect(code).toBe(130);
      expect(existsSync(join(box.work, 'p-int'))).toBe(false);
      expect(leftovers('p-int')).toEqual([]);
    },
    120_000
  );

  // How timeouts, `timeout` and process managers stop a program: a signal to its pid alone.
  it.skipIf(process.platform === 'win32')(
    'SIGTERM to the CLI alone during the install stops pnpm and leaves nothing',
    async () => {
      // An empty pnpm store and cache, so the install is slow enough to still be running.
      const fresh = (name: string) => join(box.work, '..', name);
      const env = {
        ...box.env,
        XDG_DATA_HOME: fresh('data'),
        XDG_CACHE_HOME: fresh('cache'),
        XDG_STATE_HOME: fresh('state'),
      };
      const child = spawn(process.execPath, [bin, 'p-term', '-y'], { cwd: box.work, env });
      let stdout = '';
      let stderr = '';
      let sent = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes('Installing')) {
          sent = true;
          // Let pnpm get going first, so there is something to stop.
          setTimeout(() => child.kill('SIGTERM'), 3000);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise<number | null>((done) => child.on('close', done));
      await settle();
      expect(sent, stdout).toBe(true);
      expect(code, stderr).toBe(130);
      expect(stderr).toContain('Cancelled. Nothing was written.');
      expect(existsSync(join(box.work, 'p-term'))).toBe(false);
      expect(leftovers('p-term')).toEqual([]);
    },
    120_000
  );

  it('cancel at a prompt exits 130 and writes nothing', async () => {
    // Real clack prompts, aborted at once, so the first one returns clack's own cancel symbol.
    const sink = new PassThrough().resume();
    const aborted = { signal: AbortSignal.abort(), input: new PassThrough(), output: sink };
    const unexpected = () => Promise.reject(new Error('only the first prompt should run'));
    const prompts = {
      text: (options) => p.text({ ...options, ...aborted }),
      confirm: unexpected,
      multiselect: unexpected,
    } satisfies Prompts;
    const failures: string[] = [];
    const ui: Ui = {
      intro() {},
      step() {},
      start() {},
      stop() {},
      warn() {},
      fail: (title) => failures.push(title),
      outro() {},
    };
    const code = await main([], { cwd: box.work, interactive: true, ui, prompts });
    expect(code).toBe(130);
    expect(failures).toEqual([CANCELLED]);
    expect(CANCELLED).toBe('Cancelled. Nothing was written.');
    expect(readdirSync(box.work)).toEqual([]);
  });

  it('--force backs up a non-empty target, .git included, then creates the project', async () => {
    const target = join(box.work, 'p-force');
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'notes.txt'), 'keep me');
    writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/old\n');

    const result = await exec(process.execPath, [bin, 'p-force', '--force', '--no-install', '-y'], {
      cwd: box.work,
      env: box.env,
    });
    expect(result.code, tail(result)).toBe(0);

    const backups = readdirSync(box.work).filter((entry) => entry.startsWith('p-force.backup-'));
    expect(backups).toHaveLength(1);
    const backup = join(box.work, backups[0] as string);
    expect(readFileSync(join(backup, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(backup, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/old\n');

    expect(existsSync(join(target, 'notes.txt'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(manifest.name).toBe('p-force');
    const log = await exec('git', ['log', '--format=%s'], { cwd: target, env: box.env });
    expect(log.stdout).toMatch(/^chore: initial commit from create-ts-monorepo-starter /);
    expect(leftovers('p-force')).toEqual([]);
  }, 120_000);
});
