import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { pnpmSpec } from './template.js';

export type PnpmStatus =
  | { kind: 'ok'; version: string }
  | { kind: 'old'; version: string }
  | { kind: 'none' };

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> }
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Quote one argument for cmd.exe. Rejects what quoting can't make safe: `"`, `%`, a trailing `\`. */
export function quoteWindowsArg(arg: string): string {
  if (arg.includes('"') || arg.includes('%') || arg.endsWith('\\')) {
    throw new Error(`Cannot pass this argument to cmd.exe safely: ${arg}`);
  }
  return `"${arg}"`;
}

/**
 * The cmd.exe command line. A bare command name stays unquoted: a quoted name makes `%~dp0` in a
 * .cmd shim resolve to the cwd. A path (it may contain spaces) is quoted, which keeps `%~dp0` right.
 */
export function windowsCommandLine(cmd: string, args: string[]): string {
  const isPath = /[\\/ ]/.test(cmd);
  if (!isPath && !/^[A-Za-z0-9._-]+$/.test(cmd)) {
    throw new Error(`Cannot run this command name through cmd.exe safely: ${cmd}`);
  }
  return [isPath ? quoteWindowsArg(cmd) : cmd, ...args.map(quoteWindowsArg)].join(' ');
}

/** `process.env` with `env` laid over it; an `undefined` value removes the variable. */
function mergeEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

/** Runs a command, collecting output; a spawn failure resolves with code 127. */
export const defaultExec: Exec = (cmd, args, { cwd, env }) =>
  new Promise((resolve) => {
    const options = {
      cwd,
      env: mergeEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    // Windows runs pnpm/npm through .cmd shims, which need a shell and one quoted string.
    const child =
      process.platform === 'win32'
        ? spawn(windowsCommandLine(cmd, args), { ...options, shell: true })
        : spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr + error.message }));
    child.on('close', (code, signal) => {
      let exit = code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
      // cmd.exe starts fine and reports a missing command as 9009, or 1 plus a message.
      if (
        process.platform === 'win32' &&
        (code === 9009 || (code === 1 && /is not recognized/.test(stderr)))
      ) {
        exit = 127;
      }
      resolve({ code: exit, stdout, stderr });
    });
  });

/** Runs `pnpm --version` in `cwd`, which must be outside the project so pnpm doesn't switch versions. */
export async function detectPnpm(cwd: string, exec: Exec = defaultExec): Promise<PnpmStatus> {
  const result = await exec('pnpm', ['--version'], { cwd }).catch(() => null);
  if (result?.code !== 0) return { kind: 'none' };
  const version = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const match = /^(\d+)\.\d+\.\d+(?:-[\w.]+)?$/.exec(version);
  if (!match) return { kind: 'none' };
  return { kind: Number(match[1]) < 10 ? 'old' : 'ok', version };
}

/** The package manager that ran us, from `npm_config_user_agent`; unknown means npm. */
export function detectInvoker(userAgent: string | undefined): 'pnpm' | 'npm' | 'yarn' | 'bun' {
  const name = userAgent?.split(' ')[0]?.split('/')[0];
  return name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : 'npm';
}

/** The install command for `dir`, or null when pnpm is too old to use. */
export function installCommand(
  status: PnpmStatus,
  dir: string,
  lockfileOnly: boolean
): { cmd: string; args: string[]; cwd: string } | null {
  if (!isAbsolute(dir)) throw new Error(`installCommand needs an absolute directory, got: ${dir}`);
  const extra = lockfileOnly ? ['--lockfile-only'] : [];
  if (status.kind === 'ok') return { cmd: 'pnpm', args: ['install', ...extra], cwd: dir };
  if (status.kind === 'old') return null;
  return {
    cmd: 'npm',
    args: [
      'exec',
      '--yes',
      `--package=${pnpmSpec()}`,
      '--',
      'pnpm',
      'install',
      '--dir',
      dir,
      ...extra,
    ],
    cwd: dirname(dir),
  };
}
