import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultExec,
  detectInvoker,
  detectPnpm,
  type Exec,
  installCommand,
  quoteWindowsArg,
} from '../src/pnpm';

const fake =
  (code: number, stdout = ''): Exec =>
  async () => ({ code, stdout, stderr: '' });

describe('detectPnpm', () => {
  it('classifies the version', async () => {
    expect(await detectPnpm('/p', fake(0, '12.15.0\n'))).toEqual({
      kind: 'ok',
      version: '12.15.0',
    });
    expect(await detectPnpm('/p', fake(0, '10.26.2\n'))).toEqual({
      kind: 'ok',
      version: '10.26.2',
    });
    expect(await detectPnpm('/p', fake(0, '9.15.9\n'))).toEqual({ kind: 'old', version: '9.15.9' });
  });

  it('accepts pre-releases', async () => {
    expect(await detectPnpm('/p', fake(0, '11.0.0-rc.1\n'))).toEqual({
      kind: 'ok',
      version: '11.0.0-rc.1',
    });
    expect(await detectPnpm('/p', fake(0, '9.0.0-beta.2\n'))).toEqual({
      kind: 'old',
      version: '9.0.0-beta.2',
    });
  });

  it('is none when pnpm fails, is missing, or prints nonsense', async () => {
    expect(await detectPnpm('/p', fake(127))).toEqual({ kind: 'none' });
    expect(await detectPnpm('/p', fake(0, 'hello\n'))).toEqual({ kind: 'none' });
    const throwing: Exec = async () => {
      throw new Error('boom');
    };
    expect(await detectPnpm('/p', throwing)).toEqual({ kind: 'none' });
  });

  it('runs from the given folder', async () => {
    const calls: unknown[] = [];
    await detectPnpm('/parent', async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { code: 0, stdout: '12.15.0', stderr: '' };
    });
    expect(calls).toEqual([['pnpm', ['--version'], { cwd: '/parent' }]]);
  });
});

describe('detectInvoker', () => {
  it('reads the first token of the user agent', () => {
    expect(detectInvoker('pnpm/12.15.0 npm/? node/v24.12.0 darwin arm64')).toBe('pnpm');
    expect(detectInvoker('npm/11.6.2 node/v24.12.0')).toBe('npm');
    expect(detectInvoker('yarn/4.9.0 npm/? node/v24.12.0')).toBe('yarn');
    expect(detectInvoker('bun/1.3.0')).toBe('bun');
    expect(detectInvoker('deno/2.0.0')).toBe('npm');
    expect(detectInvoker(undefined)).toBe('npm');
  });
});

describe('installCommand', () => {
  const dir = '/work/my-tools';

  it('ok installs in the project', () => {
    const ok = { kind: 'ok', version: '12.15.0' } as const;
    expect(installCommand(ok, dir, false)).toEqual({ cmd: 'pnpm', args: ['install'], cwd: dir });
    expect(installCommand(ok, dir, true)).toEqual({
      cmd: 'pnpm',
      args: ['install', '--lockfile-only'],
      cwd: dir,
    });
  });

  it('none goes through npm exec from the parent folder', () => {
    const base = ['exec', '--yes', '--package=pnpm@12.15.0', '--', 'pnpm', 'install', '--dir', dir];
    expect(installCommand({ kind: 'none' }, dir, false)).toEqual({
      cmd: 'npm',
      args: base,
      cwd: '/work',
    });
    expect(installCommand({ kind: 'none' }, dir, true)?.args).toEqual([...base, '--lockfile-only']);
  });

  it('rejects a relative directory', () => {
    expect(() => installCommand({ kind: 'none' }, 'my-tools', false)).toThrow('absolute');
  });

  it('old has no command', () => {
    expect(installCommand({ kind: 'old', version: '9.0.0' }, dir, false)).toBeNull();
  });
});

describe('quoteWindowsArg', () => {
  it('quotes spaces, embedded quotes and empty arguments', () => {
    expect(quoteWindowsArg('C:\\my tools')).toBe('"C:\\my tools"');
    expect(quoteWindowsArg('')).toBe('""');
  });

  it('rejects what cmd.exe would misread', () => {
    expect(() => quoteWindowsArg('say "hi"')).toThrow('cmd.exe');
    expect(() => quoteWindowsArg('%PATH%')).toThrow('cmd.exe');
    expect(() => quoteWindowsArg('C:\\dir\\')).toThrow('cmd.exe');
  });
});

describe('defaultExec', () => {
  // A scratch folder: npm refuses to run inside a project whose devEngines don't match.
  let cwd = '';
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'exec-test-'));
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('collects output and exit code', async () => {
    const result = await defaultExec(process.execPath, ['-e', 'console.log(1+1);process.exit(3)'], {
      cwd: cwd,
    });
    expect(result).toMatchObject({ code: 3, stdout: expect.stringContaining('2') });
  });

  it('passes awkward arguments through intact', async () => {
    const result = await defaultExec(
      process.execPath,
      ['-e', 'console.log(process.argv[1])', 'a b & c'],
      { cwd: cwd }
    );
    expect(result.stdout.trim()).toBe('a b & c');
  });

  it('runs a .cmd shim such as npm', async () => {
    const result = await defaultExec('npm', ['--version'], { cwd: cwd });
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports a signal death as 128 plus the signal number', async () => {
    if (process.platform === 'win32') return;
    const result = await defaultExec(
      process.execPath,
      ['-e', 'process.kill(process.pid, "SIGTERM")'],
      {
        cwd: cwd,
      }
    );
    expect(result.code).toBe(128 + 15);
  });

  it('resolves 127 when the command does not exist', async () => {
    const result = await defaultExec('definitely-not-a-command-xyz', [], { cwd: cwd });
    expect(result.code).toBe(127);
  });
});
