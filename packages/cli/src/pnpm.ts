import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CliError, type Details, type Fix } from './outcome.js';
import { redact } from './redact.js';
import { pnpmSpec } from './template.js';

export type PnpmStatus =
  | { kind: 'ok'; version: string }
  | { kind: 'old'; version: string }
  | { kind: 'none' };

/** A pnpm the run can go on with: `old` stops before anything is created. */
export type UsablePnpm = Exclude<PnpmStatus, { kind: 'old' }>;

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

// Children still running, so an interrupt can stop them (and what they started) before cleaning up.
const live = new Set<ChildProcess>();

/** True while a command started by `defaultExec` is still running. */
export function hasLiveChildren(): boolean {
  return live.size > 0;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** True once no process is left in the child's process group (POSIX), or the child closed (Windows). */
function gone(child: ChildProcess, closed: Set<ChildProcess>): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return closed.has(child);
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

export interface StopOptions {
  /** How long to wait in all, in ms. */
  timeout?: number;
  /** How long SIGTERM gets before SIGKILL, in ms (POSIX). */
  grace?: number;
}

/**
 * Stops every running child and everything it started: SIGTERM to its process group, then SIGKILL
 * after `grace` (POSIX), or `taskkill /T /F` (Windows). Resolves true once all are gone, false if
 * some are still running after `timeout`.
 */
export async function stopChildren({
  timeout = 5000,
  grace = 1500,
}: StopOptions = {}): Promise<boolean> {
  const children = [...live];
  if (children.length === 0) return true;
  const closed = new Set<ChildProcess>();
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) closed.add(child);
    else child.once('close', () => closed.add(child));
  }
  if (process.platform === 'win32') {
    for (const child of children) {
      if (child.pid === undefined) continue;
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
    }
  } else {
    for (const child of children) signalGroup(child, 'SIGTERM');
  }
  const started = Date.now();
  let killed = process.platform === 'win32';
  for (;;) {
    if (children.every((child) => gone(child, closed))) return true;
    const elapsed = Date.now() - started;
    if (elapsed >= timeout) return false;
    if (!killed && elapsed >= grace) {
      killed = true;
      for (const child of children) signalGroup(child, 'SIGKILL');
    }
    await pause(50);
  }
}

/**
 * Runs a command, collecting output; a spawn failure resolves with code 127. On POSIX the child
 * leads its own process group (`detached`), so `stopChildren` can stop it and what it started.
 */
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
        : spawn(cmd, args, { ...options, detached: true });
    live.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      live.delete(child);
      resolve({ code: 127, stdout, stderr: stderr + error.message });
    });
    child.on('close', (code, signal) => {
      live.delete(child);
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

/**
 * Runs `pnpm --version` in `cwd`: by default the temp folder, outside any project whose
 * `packageManager` would make pnpm switch versions. Below 10.26, pnpm can't switch itself to 12.
 */
export async function detectPnpm(
  exec: Exec = defaultExec,
  cwd: string = tmpdir()
): Promise<PnpmStatus> {
  const result = await exec('pnpm', ['--version'], { cwd }).catch(() => null);
  if (result?.code !== 0) return { kind: 'none' };
  const version = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const match = /^(\d+)\.(\d+)\.\d+(?:-[\w.]+)?$/.exec(version);
  if (!match) return { kind: 'none' };
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return { kind: major < 10 || (major === 10 && minor < 26) ? 'old' : 'ok', version };
}

/** A toolchain problem the user has to fix before anything is created; `lines` say how. */
export class ToolchainError extends CliError {
  constructor(
    code: 'pnpm-too-old' | 'pnpm-switch-failed',
    message: string,
    lines: string[],
    details: Details
  ) {
    super(code, message, lines, details);
    this.name = 'ToolchainError';
  }
}

export const PNPM_HELP = 'https://github.com/prosdevlab/create-ts-monorepo-starter#pnpm';

/** The stop for a pnpm older than 10.26, which can't switch itself to the template's pnpm. */
export function tooOld(found: string, spec: string): ToolchainError {
  const version = spec.slice('pnpm@'.length);
  const fix = { argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' } satisfies Fix;
  return new ToolchainError(
    'pnpm-too-old',
    `pnpm ${found} is too old for this project`,
    [
      `This project needs pnpm 10.26 or newer, which switches itself to pnpm ${version}.`,
      `Upgrade pnpm: ${fix.argv.join(' ')} (or https://pnpm.io/installation)`,
      'Then run this command again. Nothing was created.',
    ],
    { fixes: [fix], required: { pnpm: '>=10.26' }, found: { pnpm: found } }
  );
}

/** Whether a file exists; injected so `checkSwitch` stays testable without a real pnpm. */
export type Exists = (path: string) => Promise<boolean>;

const fileExists: Exists = (path) =>
  access(path).then(
    () => true,
    () => false
  );

/**
 * Runs `pnpm --version` in an empty folder pinned to `spec` (`pnpm@12.15.0`), where pnpm switches
 * itself to that version as the install will. Throws a ToolchainError when the switch fails.
 * `onDir` gets that folder as soon as it exists, so an interrupt handler can remove it: an
 * interrupted pnpm never returns, and then this function never gets to.
 */
export async function checkSwitch(
  spec: string,
  found: string,
  exec: Exec = defaultExec,
  root: string = tmpdir(),
  exists: Exists = fileExists,
  onDir: (dir: string) => void = () => undefined
): Promise<void> {
  const dir = await mkdtemp(join(root, 'ctms-pnpm-'));
  onDir(dir);
  try {
    await writeFile(join(dir, 'package.json'), `${JSON.stringify({ packageManager: spec })}\n`);
    const result = await exec('pnpm', ['--version'], { cwd: dir }).catch(() => null);
    if (result?.code === 0) return;
    const output = result ? `${result.stdout}\n${result.stderr}` : '';
    const installer = switchInstaller(output);
    const runnable = installer !== undefined && (await exists(installer));
    throw switchFailure(spec, found, output, runnable ? installer : undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The install script of the pnpm a failed switch downloaded, read from pnpm's error: it says the CLI
 * "is missing at <tools>/bin" when the script that puts the binary there never ran.
 */
export function switchInstaller(output: string): string | undefined {
  const tools = /missing at "([^"]+?)[\\/]bin"/.exec(output)?.[1];
  return tools === undefined ? undefined : join(tools, 'node_modules', 'pnpm', 'install.js');
}

/** The stop for a failed switch: pnpm's words, the fix (`installer`, or the README), and a retry. */
export function switchFailure(
  spec: string,
  found: string,
  output: string,
  installer?: string
): ToolchainError {
  const version = spec.slice('pnpm@'.length);
  const said = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map(redact);
  const fix: Fix = installer
    ? { argv: ['node', installer], scope: 'user' }
    : { see: PNPM_HELP, scope: 'user' };
  return new ToolchainError(
    'pnpm-switch-failed',
    `pnpm ${found} couldn't switch to pnpm ${version}, which this project needs`,
    [
      ...said.map((line) => `pnpm: ${line}`),
      'argv' in fix
        ? `Fix: ${fix.argv.join(' ')}`
        : `Fix your pnpm so it can switch to ${version}: ${fix.see}`,
      'Then run this command again. Nothing was created.',
    ],
    { fixes: [fix], required: { pnpm: version }, found: { pnpm: found } }
  );
}

/** The install command for `dir`, or null when pnpm is too old to use. */
export function installCommand(
  status: UsablePnpm,
  dir: string,
  lockfileOnly: boolean
): { cmd: string; args: string[]; cwd: string } {
  if (!isAbsolute(dir)) throw new Error(`installCommand needs an absolute directory, got: ${dir}`);
  // The bundled lockfile always needs updating, and pnpm freezes it by default when CI is set.
  const extra = ['--no-frozen-lockfile', ...(lockfileOnly ? ['--lockfile-only'] : [])];
  if (status.kind === 'ok') return { cmd: 'pnpm', args: ['install', ...extra], cwd: dir };
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
