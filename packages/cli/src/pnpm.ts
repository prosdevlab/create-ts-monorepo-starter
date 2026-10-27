import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { pnpmSpec } from './template.js';

export type PnpmStatus =
  | { kind: 'ok'; version: string }
  | { kind: 'old'; version: string }
  | { kind: 'none' };

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string }
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Quote one argument for cmd.exe: wrap in double quotes, escape embedded ones. */
export function quoteWindowsArg(arg: string): string {
  return `"${arg.replaceAll('"', '\\"')}"`;
}

/** Runs a command, collecting output; a spawn failure resolves with code 127. */
export const defaultExec: Exec = (cmd, args, { cwd }) =>
  new Promise((resolve) => {
    const options = { cwd, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    // Windows runs pnpm/npm through .cmd shims, which need a shell and one quoted string.
    const child =
      process.platform === 'win32'
        ? spawn([cmd, ...args].map(quoteWindowsArg).join(' '), { ...options, shell: true })
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
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Runs `pnpm --version` in `cwd`, which must be outside the project so pnpm doesn't switch versions. */
export async function detectPnpm(exec: Exec, cwd: string): Promise<PnpmStatus> {
  const result = await exec('pnpm', ['--version'], { cwd }).catch(() => null);
  if (result?.code !== 0) return { kind: 'none' };
  const version = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
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
