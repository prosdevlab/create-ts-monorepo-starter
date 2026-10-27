import { describe, expect, it } from 'vitest';
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
    expect(await detectPnpm(fake(0, '12.15.0\n'), '/p')).toEqual({
      kind: 'ok',
      version: '12.15.0',
    });
    expect(await detectPnpm(fake(0, '10.26.2\n'), '/p')).toEqual({
      kind: 'ok',
      version: '10.26.2',
    });
    expect(await detectPnpm(fake(0, '9.15.9\n'), '/p')).toEqual({ kind: 'old', version: '9.15.9' });
  });

  it('is none when pnpm fails, is missing, or prints nonsense', async () => {
    expect(await detectPnpm(fake(127), '/p')).toEqual({ kind: 'none' });
    expect(await detectPnpm(fake(0, 'hello\n'), '/p')).toEqual({ kind: 'none' });
    const throwing: Exec = async () => {
      throw new Error('boom');
    };
    expect(await detectPnpm(throwing, '/p')).toEqual({ kind: 'none' });
  });

  it('runs from the given folder', async () => {
    const calls: unknown[] = [];
    await detectPnpm(async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { code: 0, stdout: '12.15.0', stderr: '' };
    }, '/parent');
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

  it('old has no command', () => {
    expect(installCommand({ kind: 'old', version: '9.0.0' }, dir, false)).toBeNull();
  });
});

describe('quoteWindowsArg', () => {
  it('quotes spaces, embedded quotes and empty arguments', () => {
    expect(quoteWindowsArg('C:\\my tools')).toBe('"C:\\my tools"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('')).toBe('""');
  });
});

describe('defaultExec', () => {
  it('collects output and exit code', async () => {
    const result = await defaultExec(
      process.execPath,
      ['-e', 'console.log("hi");process.exit(3)'],
      {
        cwd: process.cwd(),
      }
    );
    expect(result).toMatchObject({ code: 3, stdout: expect.stringContaining('hi') });
  });

  it('resolves 127 when the command does not exist', async () => {
    const result = await defaultExec('definitely-not-a-command-xyz', [], { cwd: process.cwd() });
    expect(result.code).toBe(127);
  });
});
