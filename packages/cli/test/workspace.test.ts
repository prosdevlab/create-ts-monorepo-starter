import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backUp,
  backupPath,
  moveIntoPlace,
  onInterrupt,
  targetState,
  tempPath,
} from '../src/workspace';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctms-ws-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (dir: string, rel: string, content: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

describe('paths', () => {
  it('builds the backup path in local time', () => {
    expect(backupPath(join('/x', 'my-tools'), new Date(2026, 9, 27, 10, 42, 5))).toBe(
      `${resolve('/x', 'my-tools')}.backup-20261027-104205`
    );
  });

  it('puts the temp folder beside the target', () => {
    const target = join(root, 'my-tools');
    const temp = tempPath(target);
    expect(dirname(temp)).toBe(root);
    expect(basename(temp)).toMatch(/^\.my-tools\.tmp-[0-9a-f]{8}$/);
    expect(dirname(tempPath('.'))).toBe(dirname(process.cwd()));
    expect(basename(tempPath(target, () => 'deadbeef'))).toBe('.my-tools.tmp-deadbeef');
  });
});

describe('path resolution', () => {
  it('treats a trailing slash like none', () => {
    const now = new Date(2026, 9, 27, 10, 42, 5);
    expect(backupPath('x/', now)).toBe(backupPath('x', now));
    expect(backupPath('.', now)).toBe(backupPath(process.cwd(), now));
  });
});

describe('targetState', () => {
  it('tells missing, empty and not-empty apart', async () => {
    const dir = join(root, 'a');
    expect(await targetState(dir)).toBe('missing');
    mkdirSync(dir);
    expect(await targetState(dir)).toBe('empty');
    put(dir, 'f.txt', 'x');
    expect(await targetState(dir)).toBe('not-empty');
    expect(await targetState(join(dir, 'f.txt'))).toBe('not-empty');
  });
});

describe('moveIntoPlace', () => {
  it('moves a folder into a missing target', async () => {
    const temp = join(root, '.t');
    put(temp, 'a/b.txt', 'hi');
    const target = join(root, 'out');
    await moveIntoPlace(temp, target);
    expect(readFileSync(join(target, 'a', 'b.txt'), 'utf8')).toBe('hi');
    expect(existsSync(temp)).toBe(false);
  });

  it('moves entries into an empty target', async () => {
    const temp = join(root, '.t');
    put(temp, 'a/b.txt', 'hi');
    put(temp, '.hidden', 'h');
    const target = join(root, 'out');
    mkdirSync(target);
    await moveIntoPlace(temp, target);
    expect(readdirSync(target).sort()).toEqual(['.hidden', 'a']);
    expect(existsSync(temp)).toBe(false);
  });

  it('retries a refused rename', async () => {
    const temp = join(root, '.t');
    put(temp, 'f', 'x');
    const target = join(root, 'out');
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const refuse = (n: number, code = 'EPERM') => {
      let calls = 0;
      const err = Object.assign(new Error(code), { code });
      return {
        calls: () => calls,
        rename: (async () => {
          calls += 1;
          if (calls <= n) throw err;
        }) as never,
        err,
      };
    };

    const twice = refuse(2);
    await moveIntoPlace(temp, target, { rename: twice.rename, sleep });
    expect(twice.calls()).toBe(3);
    expect(sleeps).toEqual([100, 200]);

    sleeps.length = 0;
    const always = refuse(6);
    await expect(moveIntoPlace(temp, target, { rename: always.rename, sleep })).rejects.toBe(
      always.err
    );
    expect(sleeps).toEqual([100, 200, 400, 800, 1600]);
    expect(always.calls()).toBe(6);
  });

  it('names both paths when the target is on another device', async () => {
    const temp = join(root, '.t');
    const target = join(root, 'out');
    const err = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    const attempt = moveIntoPlace(temp, target, {
      rename: (async () => {
        throw err;
      }) as never,
      sleep: async () => undefined,
    });
    await expect(attempt).rejects.toThrow(/different devices/);
    await expect(attempt).rejects.toThrow(temp);
    await expect(attempt).rejects.toThrow(target);
  });

  it('refuses a temp folder inside the target', async () => {
    const target = join(root, 'out');
    const temp = join(target, '.t');
    mkdirSync(temp, { recursive: true });
    await expect(moveIntoPlace(temp, target)).rejects.toThrow(/inside the target/);
    await expect(moveIntoPlace(target, target)).rejects.toThrow(/inside the target/);
    // A name that merely starts with two dots is still inside.
    const dotted = join(target, '..cache');
    mkdirSync(dotted);
    await expect(moveIntoPlace(dotted, target)).rejects.toThrow(/inside the target/);
  });

  it('retries EACCES only on win32', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const run = async (platform: NodeJS.Platform) => {
      const sleeps: number[] = [];
      await moveIntoPlace(join(root, '.t'), join(root, 'out'), {
        platform,
        rename: (async () => {
          if (sleeps.length < 1) throw err;
        }) as never,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }).catch((error) => {
        if (error !== err) throw error;
        return 'refused';
      });
      return sleeps;
    };
    expect(await run('win32')).toEqual([100]);
    expect(await run('linux')).toEqual([]);
  });

  it('rethrows other errors without retrying', async () => {
    const sleeps: number[] = [];
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    await expect(
      moveIntoPlace(join(root, '.t'), join(root, 'out'), {
        rename: (async () => {
          throw err;
        }) as never,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      })
    ).rejects.toBe(err);
    expect(sleeps).toEqual([]);
  });
});

describe('backUp', () => {
  it('keeps every file, including .git, in the backup', async () => {
    const target = join(root, 'proj');
    put(target, 'src/a.ts', 'const a = 1;\n');
    put(target, '.git/HEAD', 'ref: refs/heads/main\n');
    const bytes = Buffer.from([0, 255, 1, 2]);
    writeFileSync(join(target, 'bin.dat'), bytes);
    const now = new Date(2026, 9, 27, 10, 42, 5);
    const backup = await backUp(target, now);
    expect(backup).toBe(backupPath(target, now));
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(backup, 'src/a.ts'), 'utf8')).toBe('const a = 1;\n');
    expect(readFileSync(join(backup, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(readFileSync(join(backup, 'bin.dat')).equals(bytes)).toBe(true);
  });

  it('never overwrites an existing backup', async () => {
    const now = new Date(2026, 9, 27, 10, 42, 5);
    const target = join(root, 'proj');
    put(target, 'f', 'new');
    put(backupPath(target, now), 'f', 'old');
    const backup = await backUp(target, now);
    expect(backup).toBe(`${backupPath(target, now)}-1`);
    expect(readFileSync(join(backupPath(target, now), 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(backup, 'f'), 'utf8')).toBe('new');
  });
});

describe('onInterrupt', () => {
  it('removes the temp folder and exits 130', () => {
    const temp = join(root, '.t');
    put(temp, 'f', 'x');
    const codes: number[] = [];
    const off = onInterrupt(temp, { exit: (code) => codes.push(code) });
    try {
      process.emit('SIGINT');
      expect(existsSync(temp)).toBe(false);
      expect(codes).toEqual([130]);
    } finally {
      off();
    }
  });

  it('stops listening once unregistered', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const off = onInterrupt(join(root, '.t'), { exit: () => undefined });
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    off();
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });
});
