import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertLockfileSubset } from '../src/lockfile';
import { NameError, packageNameFromFolder } from '../src/names';
import { codeOf, ERROR_CODES, type ErrorCode, exitCode } from '../src/outcome';
import { switchFailure, tooOld } from '../src/pnpm';
import { planFromOptions, run } from '../src/run';
import { CancelledError } from '../src/ui';
import { backUp } from '../src/workspace';

const fail = (code: string) => ({ ok: false, error: { code } }) as never;

describe('exitCode', () => {
  const expected: Record<ErrorCode, number> = {
    usage: 2,
    'target-not-empty': 1,
    cancelled: 130,
    'pnpm-too-old': 3,
    'pnpm-switch-failed': 3,
    'install-failed': 4,
    'lockfile-changed': 1,
    'backup-failed': 1,
    'move-failed': 1,
    interrupted: 130,
    unexpected: 1,
  };

  it.each(Object.entries(expected))('%s exits %i', (code, exit) => {
    expect(exitCode(fail(code))).toBe(exit);
  });

  it('exits 0 for success', () => {
    expect(exitCode({ ok: true })).toBe(0);
  });

  it('exits 1 for a code it does not know', () => {
    expect(exitCode(fail('ENOSPC'))).toBe(1);
  });

  it('knows every code', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(expected).sort());
  });
});

describe('codeOf', () => {
  it('is unexpected for a Node error code', () => {
    expect(codeOf(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).toBe('unexpected');
  });

  it.each([new Error('plain'), 'text', null, undefined])('is unexpected for %s', (error) => {
    expect(codeOf(error)).toBe('unexpected');
  });

  it("returns the CLI's own code", () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'install-failed' }))).toBe(
      'install-failed'
    );
  });
});

describe('each source sets its own code', () => {
  it('tooOld', () => {
    expect(codeOf(tooOld('9.0.0', 'pnpm@12.15.0'))).toBe('pnpm-too-old');
  });

  it('switchFailure', () => {
    expect(codeOf(switchFailure('pnpm@12.15.0', '10.28.0', ''))).toBe('pnpm-switch-failed');
  });

  it('LockfileError', () => {
    const error = (() => {
      try {
        assertLockfileSubset('packages:\n', "packages:\n  'a@1.0.0':\n    x: 1\n");
      } catch (e) {
        return e;
      }
    })();
    expect(codeOf(error)).toBe('lockfile-changed');
  });

  it('NameError', () => {
    expect(codeOf(new NameError('bad'))).toBe('usage');
    expect(() => packageNameFromFolder('!!!')).toThrow(expect.objectContaining({ code: 'usage' }));
  });

  it('CancelledError', () => {
    expect(codeOf(new CancelledError('Cancelled'))).toBe('cancelled');
  });

  describe('run() with the real backUp', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'ctms-outcome-'));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const eio = (async () => {
      throw Object.assign(new Error('io'), { code: 'EIO' });
    }) as never;
    const ui = {
      intro() {},
      step() {},
      start() {},
      stop() {},
      warn() {},
      fail() {},
      outro() {},
    };
    const attempt = async (cwdIsTarget: boolean) => {
      const target = join(root, 'proj');
      mkdirSync(target);
      writeFileSync(join(target, 'a.txt'), 'a');
      const plan = planFromOptions(
        {
          folder: 'proj',
          git: false,
          install: false,
          force: false,
          yes: true,
          help: false,
          version: false,
        },
        root,
        new Date(2026, 9, 27),
        'Ada'
      );
      const template = join(root, 'template');
      mkdirSync(template);
      writeFileSync(join(template, 'package.json'), '{ "packageManager": "pnpm@12.15.0" }\n');
      writeFileSync(join(template, 'pnpm-lock.yaml'), 'packages:\n');
      const error = await run({ ...plan, replace: true }, ui, {
        cwd: cwdIsTarget ? target : root,
        templateDir: template,
        exec: async (cmd, args) => ({
          code: 0,
          stdout: `${cmd} ${args.join(' ')}` === 'pnpm --version' ? '12.15.0\n' : '',
          stderr: '',
        }),
        generate: async (input) => {
          mkdirSync(input.to);
          writeFileSync(join(input.to, 'pnpm-lock.yaml'), 'packages:\n');
        },
        backUp: (t, n, d) => backUp(t, n, { ...d, rename: eio }),
        onInterrupt: () => () => undefined,
      }).catch((e: unknown) => e);
      return error as Error & { cause: { code: string } };
    };

    it('failing in place', async () => {
      const error = await attempt(true);
      expect(error.message).toContain("Couldn't move the old files aside");
      expect(codeOf(error)).toBe('backup-failed');
      // backUp wraps the rename's error itself, so the errno is one level further down.
      expect((error.cause as { cause: { code: string } }).cause.code).toBe('EIO');
    });

    it('failing on a whole-folder rename', async () => {
      const error = await attempt(false);
      expect(error.message).toBe('io');
      expect(codeOf(error)).toBe('backup-failed');
      expect(error.cause.code).toBe('EIO');
    });
  });
});
