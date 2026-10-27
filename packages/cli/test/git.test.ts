import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIdentity, initAndCommit, insideGitRepo } from '../src/git';
import { defaultExec, type Exec } from '../src/pnpm';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctms-git-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An Exec that runs git against a config of our choosing, not the developer's. */
function withEnv(env: Record<string, string | undefined>): Exec {
  return (cmd, args, opts) => defaultExec(cmd, args, { ...opts, env: { ...env, ...opts.env } });
}

function isolatedEnv(configFile: string, home: string): Record<string, string | undefined> {
  return {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: configFile,
    GIT_CONFIG_NOSYSTEM: '1',
    // undefined removes a variable a developer's shell may have set.
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
  };
}

function identityExec(): Exec {
  const config = join(root, 'gitconfig');
  writeFileSync(config, '[user]\n\tname = Test\n\temail = test@example.com\n');
  return withEnv(isolatedEnv(config, root));
}

function noIdentityExec(): Exec {
  const home = join(root, 'empty-home');
  mkdirSync(home);
  return withEnv(isolatedEnv(join(home, 'gitconfig'), home));
}

const git = async (exec: Exec, cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd })).stdout.trim();

describe('insideGitRepo', () => {
  it('is true in a subfolder of a repo and false in a plain folder', async () => {
    const exec = identityExec();
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    expect(await insideGitRepo(join(repo, 'sub'), exec)).toBe(true);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await insideGitRepo(plain, exec)).toBe(false);
  });
});

describe('gitIdentity', () => {
  it('reads name and email, and reports none when unset', async () => {
    expect(await gitIdentity(root, identityExec())).toEqual({
      name: 'Test',
      email: 'test@example.com',
    });
    expect(await gitIdentity(root, noIdentityExec())).toEqual({});
  });
});

describe('initAndCommit', () => {
  it('commits with the message even when a pre-commit hook fails', async () => {
    const exec = identityExec();
    const dir = join(root, 'proj');
    const hooks = join(root, 'hooks');
    mkdirSync(dir);
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    writeFileSync(join(dir, 'a.txt'), 'a');
    // Repo-local config counts, so the failing hook is wired up before the commit.
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await exec('git', ['config', 'core.hooksPath', hooks], { cwd: dir });
    expect(await initAndCommit(dir, 'chore: first', exec)).toBe('committed');
    expect(await git(exec, dir, 'log', '--format=%s')).toBe('chore: first');
    expect(await git(exec, dir, 'branch', '--show-current')).toBe('main');
  });

  it('initializes and stages but does not commit without an identity', async () => {
    const exec = noIdentityExec();
    const dir = join(root, 'proj');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'a');
    expect(await initAndCommit(dir, 'chore: first', exec)).toBe('no-identity');
    expect(existsSync(join(dir, '.git'))).toBe(true);
    const log = await exec('git', ['log'], { cwd: dir });
    expect(log.code).not.toBe(0);
    expect(await git(exec, dir, 'diff', '--cached', '--name-only')).toBe('a.txt');
  });

  it('returns no-git when git is missing', async () => {
    const missing: Exec = async () => ({ code: 127, stdout: '', stderr: '' });
    expect(await initAndCommit(root, 'x', missing)).toBe('no-git');
  });
});
