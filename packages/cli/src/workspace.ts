import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { rename as fsRename, lstat, mkdir, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hasLiveChildren, stopChildren } from './pnpm.js';

const RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const RETRY_DELAYS = [100, 200, 400, 800, 1600];

const pad = (n: number) => String(n).padStart(2, '0');

/** `<parent>/.<name>.tmp-<8 hex>`, beside the target so the final rename stays on one volume. */
export function tempPath(
  target: string,
  random: () => string = () => randomBytes(4).toString('hex')
): string {
  target = resolve(target);
  return join(dirname(target), `.${basename(target)}.tmp-${random()}`);
}

/** `<target>.backup-YYYYMMDD-HHMMSS` in local time. */
export function backupPath(target: string, now: Date): string {
  target = resolve(target);
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${target}.backup-${date}-${time}`;
}

// lstat, so a dangling symlink counts as taken; only ENOENT means the name is free.
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );

export async function targetState(target: string): Promise<'missing' | 'empty' | 'not-empty'> {
  target = resolve(target);
  const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return 'missing';
  if (!info.isDirectory()) return 'not-empty';
  return (await readdir(target)).length === 0 ? 'empty' : 'not-empty';
}

export type MoveDeps = {
  rename?: typeof fsRename;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
};

/** True when `child` is `parent` or inside it (a name that merely starts with `..` is inside). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * A rename that retries a refused move: Windows scanners and indexers briefly lock fresh files.
 * EACCES is a transient lock on Windows but a real permission error elsewhere.
 */
function retryingRename(deps: MoveDeps): (from: string, to: string) => Promise<void> {
  const retryCodes =
    (deps.platform ?? process.platform) === 'win32'
      ? new Set([...RETRY_CODES, 'EACCES'])
      : RETRY_CODES;
  const rename = deps.rename ?? fsRename;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return async (from, to) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const delay = RETRY_DELAYS[attempt];
        if (!code || !retryCodes.has(code) || delay === undefined) throw error;
        await sleep(delay);
      }
    }
  };
}

const real = (path: string) => realpath(path).catch(() => resolve(path));

/** True when `cwd` is `target` or inside it: renaming `target` would move the shell standing in it. */
export async function holdsCwd(target: string, cwd: string = process.cwd()): Promise<boolean> {
  return isInside(await real(target), await real(cwd));
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/**
 * Moves the folder's contents aside and returns the backup path; an existing backup gets a `-N`
 * suffix. Renames the whole folder, unless it is (or holds) the current folder: then it moves
 * each entry into a new backup folder, so the folder the shell stands in keeps its path.
 */
export async function backUp(
  target: string,
  now: Date,
  deps: MoveDeps & { cwd?: string } = {}
): Promise<string> {
  target = resolve(target);
  const base = backupPath(target, now);
  let candidate = base;
  for (let n = 1; await exists(candidate); n += 1) candidate = `${base}-${n}`;
  const move = retryingRename(deps);
  if (!(await holdsCwd(target, deps.cwd))) {
    await move(target, candidate);
    return candidate;
  }
  await mkdir(candidate);
  const entries = await readdir(target);
  for (const [index, entry] of entries.entries()) {
    try {
      await move(join(target, entry), join(candidate, entry));
    } catch (error) {
      const where =
        index === 0
          ? `Your files are all still in ${target}.`
          : `Your files are split: ${index} of ${entries.length} entries are in ${candidate}, the rest are still in ${target}.`;
      if (index === 0) await rmdir(candidate).catch(() => undefined);
      throw new Error(
        `Couldn't move the old files aside: ${entry}: ${firstLine(error)}\n${where}`,
        {
          cause: error,
        }
      );
    }
  }
  return candidate;
}

/** Moves `temp` to `target`: whole folder if missing, entry by entry if empty (e.g. the cwd). */
export async function moveIntoPlace(
  temp: string,
  target: string,
  deps: MoveDeps = {}
): Promise<void> {
  temp = resolve(temp);
  target = resolve(target);
  if (isInside(target, temp)) {
    throw new Error(`The temporary folder ${temp} is inside the target ${target}`);
  }
  const rename = retryingRename(deps);
  const move = async (from: string, to: string) => {
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new Error(
          `Cannot move ${temp} to ${target}: they are on different devices. Choose a target on the same drive.`,
          { cause: error }
        );
      }
      throw error;
    }
  };

  const state = await targetState(target);
  if (state === 'not-empty') throw new Error(`Cannot move into a folder that has files: ${target}`);
  if (state === 'missing') {
    await mkdir(dirname(target), { recursive: true });
    await move(temp, target);
    return;
  }
  for (const entry of await readdir(temp)) await move(join(temp, entry), join(target, entry));
  await rmdir(temp);
}

/** What an interrupt managed: the temp folder is gone, and every child process stopped. */
export interface InterruptOutcome {
  removed: boolean;
  stopped: boolean;
}

export interface InterruptDeps {
  exit?: (code: number, outcome: InterruptOutcome) => void;
  /** Called as soon as a signal arrives, before anything is stopped or removed. */
  onStart?: () => void;
  live?: () => boolean;
  stop?: () => Promise<boolean>;
  remove?: (path: string) => void;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * On SIGINT, SIGTERM or SIGHUP: stops the running commands (pnpm and what it started), waiting
 * at most 5 s, then deletes `temp` and exits 130. Returns the unregister function.
 */
export function onInterrupt(temp: string, deps: InterruptDeps = {}): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const live = deps.live ?? hasLiveChildren;
  const stop = deps.stop ?? (() => stopChildren({ timeout: 5000 }));
  const remove =
    deps.remove ??
    ((path: string) =>
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  let handling = false;
  const finish = (stopped: boolean) => {
    let removed = false;
    try {
      remove(temp);
      removed = !existsSync(temp);
    } catch {
      removed = false;
    } finally {
      exit(130, { removed, stopped });
    }
  };
  const handler = () => {
    // A second signal while the first is handled changes nothing.
    if (handling) return;
    handling = true;
    deps.onStart?.();
    // Nothing running: finish now, before any other callback can run.
    if (!live()) {
      finish(true);
      return;
    }
    stop().then(finish, () => finish(false));
  };
  for (const signal of SIGNALS) process.on(signal, handler);
  return () => {
    for (const signal of SIGNALS) process.off(signal, handler);
  };
}
