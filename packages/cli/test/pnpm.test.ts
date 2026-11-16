import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkSwitch,
  defaultExec,
  detectInvoker,
  detectPnpm,
  type Exec,
  hasLiveChildren,
  installCommand,
  PNPM_HELP,
  quoteWindowsArg,
  stopChildren,
  switchFailure,
  switchInstaller,
  windowsCommandLine,
} from '../src/pnpm';

const fake =
  (code: number, stdout = ''): Exec =>
  async () => ({ code, stdout, stderr: '' });

describe('detectPnpm', () => {
  it('classifies the version', async () => {
    expect(await detectPnpm(fake(0, '12.15.0\n'))).toEqual({
      kind: 'ok',
      version: '12.15.0',
    });
    expect(await detectPnpm(fake(0, '10.26.2\n'))).toEqual({
      kind: 'ok',
      version: '10.26.2',
    });
    expect(await detectPnpm(fake(0, '9.15.9\n'))).toEqual({ kind: 'old', version: '9.15.9' });
  });

  it('treats pnpm 10 below 10.26 as old: it cannot switch itself to pnpm 12', async () => {
    expect(await detectPnpm(fake(0, '10.25.0\n'))).toEqual({ kind: 'old', version: '10.25.0' });
    expect(await detectPnpm(fake(0, '10.0.0\n'))).toEqual({ kind: 'old', version: '10.0.0' });
    expect(await detectPnpm(fake(0, '10.26.2\n'))).toEqual({ kind: 'ok', version: '10.26.2' });
    expect(await detectPnpm(fake(0, '11.0.0\n'))).toEqual({ kind: 'ok', version: '11.0.0' });
  });

  it('accepts pre-releases', async () => {
    expect(await detectPnpm(fake(0, '11.0.0-rc.1\n'))).toEqual({
      kind: 'ok',
      version: '11.0.0-rc.1',
    });
    expect(await detectPnpm(fake(0, '9.0.0-beta.2\n'))).toEqual({
      kind: 'old',
      version: '9.0.0-beta.2',
    });
  });

  it('is none when pnpm fails, is missing, or prints nonsense', async () => {
    expect(await detectPnpm(fake(127))).toEqual({ kind: 'none' });
    expect(await detectPnpm(fake(0, 'hello\n'))).toEqual({ kind: 'none' });
    const throwing: Exec = async () => {
      throw new Error('boom');
    };
    expect(await detectPnpm(throwing)).toEqual({ kind: 'none' });
  });

  it('runs from the temp folder by default, or the given folder', async () => {
    const calls: unknown[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { code: 0, stdout: '12.15.0', stderr: '' };
    };
    await detectPnpm(exec);
    await detectPnpm(exec, '/parent');
    expect(calls).toEqual([
      ['pnpm', ['--version'], { cwd: tmpdir() }],
      ['pnpm', ['--version'], { cwd: '/parent' }],
    ]);
  });
});

/** What pnpm 10.28.0 printed on macOS when its switch to 12.15.0 left a shell shim in place. */
const switchError = (tools: string) =>
  `ERROR  Failed to switch pnpm to v12.15.0. Looks like pnpm CLI is missing at "${tools}/bin" or is incorrect\n` +
  `spawnSync ${tools}/bin/pnpm Unknown system error -8\n`;

describe('checkSwitch', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ctms-switch-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runs pnpm --version in a folder pinned to the version, then removes it', async () => {
    const seen: { cwd: string; manifest: string }[] = [];
    const exec: Exec = async (_cmd, _args, { cwd }) => {
      seen.push({ cwd, manifest: readFileSync(join(cwd, 'package.json'), 'utf8') });
      return { code: 0, stdout: '12.15.0\n', stderr: '' };
    };
    await checkSwitch('pnpm@12.15.0', '10.28.0', exec, root);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.manifest ?? '')).toEqual({ packageManager: 'pnpm@12.15.0' });
    expect(existsSync(seen[0]?.cwd ?? '')).toBe(false);
  });

  it('throws a ToolchainError when the switch fails, and still removes the folder', async () => {
    let cwd = '';
    const exec: Exec = async (_cmd, _args, opts) => {
      cwd = opts.cwd;
      return { code: 1, stdout: '', stderr: switchError('/nowhere/12.15.0') };
    };
    const error = await checkSwitch('pnpm@12.15.0', '10.28.0', exec, root, async () => false).catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({ name: 'ToolchainError' });
    expect((error as { lines: string[] }).lines).toContain(
      `Fix your pnpm so it can switch to 12.15.0: ${PNPM_HELP}`
    );
    expect(existsSync(cwd)).toBe(false);
  });

  it('offers the install script only when it exists', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: switchError('/t') });
    const asked: string[] = [];
    const exists = async (path: string) => {
      asked.push(path);
      return true;
    };
    const error = await checkSwitch('pnpm@12.15.0', '10.28.0', exec, root, exists).catch(
      (e: unknown) => e
    );
    expect(asked).toEqual([join('/t', 'node_modules', 'pnpm', 'install.js')]);
    expect((error as { lines: string[] }).lines).toContain(`Fix: node ${asked[0]}`);
  });
});

describe('switchInstaller', () => {
  it("reads the install script's path from pnpm's error", () => {
    expect(switchInstaller(switchError('/home/me/.tools/pnpm/12.15.0'))).toBe(
      join('/home/me/.tools/pnpm/12.15.0', 'node_modules', 'pnpm', 'install.js')
    );
  });

  it('is undefined for any other output', () => {
    expect(switchInstaller('')).toBeUndefined();
    expect(switchInstaller('ERR_PNPM_SOMETHING_ELSE')).toBeUndefined();
  });
});

describe('switchFailure', () => {
  it("names pnpm's error, the install script that fixes it, and the retry", () => {
    const error = switchFailure('pnpm@12.15.0', '10.28.0', switchError('/t'), '/t/install.js');
    expect(error).toMatchObject({
      name: 'ToolchainError',
      message: "pnpm 10.28.0 couldn't switch to pnpm 12.15.0, which this project needs",
    });
    expect(error.lines).toEqual([
      expect.stringMatching(/^pnpm: ERROR {2}Failed to switch pnpm to v12\.15\.0\./),
      'pnpm: spawnSync /t/bin/pnpm Unknown system error -8',
      'Fix: node /t/install.js',
      'Then run this command again. Nothing was created.',
    ]);
  });

  it('points to the README without an install script to run', () => {
    expect(switchFailure('pnpm@12.15.0', '10.28.0', '').lines).toEqual([
      `Fix your pnpm so it can switch to 12.15.0: ${PNPM_HELP}`,
      'Then run this command again. Nothing was created.',
    ]);
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
    expect(installCommand(ok, dir, false)).toEqual({
      cmd: 'pnpm',
      args: ['install', '--no-frozen-lockfile'],
      cwd: dir,
    });
    expect(installCommand(ok, dir, true)).toEqual({
      cmd: 'pnpm',
      args: ['install', '--no-frozen-lockfile', '--lockfile-only'],
      cwd: dir,
    });
  });

  it('none goes through npm exec from the parent folder', () => {
    const base = [
      'exec',
      '--yes',
      '--package=pnpm@12.15.0',
      '--',
      'pnpm',
      'install',
      '--dir',
      dir,
      '--no-frozen-lockfile',
    ];
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

describe('windowsCommandLine', () => {
  it('leaves a bare command name unquoted and quotes the arguments', () => {
    expect(windowsCommandLine('npm', ['exec', '--dir', 'C:\\my tools'])).toBe(
      'npm "exec" "--dir" "C:\\my tools"'
    );
  });

  it('quotes a command given as a path', () => {
    expect(windowsCommandLine('C:\\Program Files\\nodejs\\node.exe', ['-v'])).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "-v"'
    );
  });

  it('rejects a bare name with a metacharacter', () => {
    expect(() => windowsCommandLine('npm&calc', [])).toThrow('cmd.exe');
    expect(() => windowsCommandLine('', [])).toThrow('cmd.exe');
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
    expect(hasLiveChildren()).toBe(false);
  });

  // Windows: cmd.exe can't take this script's quotes, so taskkill /T has no automated test.
  it.skipIf(process.platform === 'win32')(
    'stopChildren stops a running child and what it started, and the exec resolves',
    async () => {
      // The child starts a grandchild that ignores SIGTERM, and prints its pid.
      const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      console.log(g.pid);
      setInterval(() => {}, 1000);`;
      const running = defaultExec(process.execPath, ['-e', script], { cwd });
      for (let i = 0; i < 100 && !hasLiveChildren(); i += 1)
        await new Promise((d) => setTimeout(d, 20));
      expect(hasLiveChildren()).toBe(true);
      await new Promise((d) => setTimeout(d, 500));
      expect(await stopChildren({ timeout: 5000, grace: 300 })).toBe(true);
      const result = await running;
      expect(result.code).not.toBe(0);
      expect(hasLiveChildren()).toBe(false);
      const grandchild = Number(result.stdout.trim());
      expect(grandchild).toBeGreaterThan(0);
      const alive = () => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive()).toBe(false);
    },
    15_000
  );

  it('stopChildren with nothing running resolves true at once', async () => {
    expect(await stopChildren()).toBe(true);
  });
});
