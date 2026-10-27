import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { rename as fsRename, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS = [100, 200, 400, 800, 1600];

const pad = (n: number) => String(n).padStart(2, '0');

/** `<parent>/.<name>.tmp-<8 hex>`, beside the target so the final rename stays on one volume. */
export function tempPath(
  target: string,
  random: () => string = () => randomBytes(4).toString('hex')
): string {
  return join(dirname(target), `.${basename(target)}.tmp-${random()}`);
}

/** `<target>.backup-YYYYMMDD-HHMMSS` in local time. */
export function backupPath(target: string, now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${target}.backup-${date}-${time}`;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

export async function targetState(target: string): Promise<'missing' | 'empty' | 'not-empty'> {
  const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return 'missing';
  if (!info.isDirectory()) return 'not-empty';
  return (await readdir(target)).length === 0 ? 'empty' : 'not-empty';
}

/** Renames the folder aside and returns the new path; an existing backup gets a `-N` suffix. */
export async function backUp(target: string, now: Date): Promise<string> {
  const base = backupPath(target, now);
  let candidate = base;
  for (let n = 1; await exists(candidate); n += 1) candidate = `${base}-${n}`;
  await fsRename(target, candidate);
  return candidate;
}

export type MoveDeps = {
  rename?: typeof fsRename;
  sleep?: (ms: number) => Promise<void>;
};

/** Moves `temp` to `target`: whole folder if missing, entry by entry if empty (e.g. the cwd). */
export async function moveIntoPlace(
  temp: string,
  target: string,
  deps: MoveDeps = {}
): Promise<void> {
  const rename = deps.rename ?? fsRename;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  // Windows scanners and indexers briefly lock fresh files, so a refused rename is retried.
  const move = async (from: string, to: string) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const delay = RETRY_DELAYS[attempt];
        if (!code || !RETRY_CODES.has(code) || delay === undefined) throw error;
        await sleep(delay);
      }
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
  await rm(temp, { recursive: true, force: true });
}

/** On SIGINT or SIGTERM, deletes `temp` and exits 130. Returns the unregister function. */
export function onInterrupt(
  temp: string,
  deps: { exit?: (code: number) => void } = {}
): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const handler = () => {
    rmSync(temp, { recursive: true, force: true });
    exit(130);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
