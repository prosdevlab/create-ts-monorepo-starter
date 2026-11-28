import { describe, expect, it } from 'vitest';
import type { ErrorCode, Left, Outcome } from '../src/outcome';
import { retryStep } from '../src/retry';
import type { RunPlan } from '../src/run';

const plan: RunPlan = {
  target: '/work/my-tools',
  folder: 'my-tools',
  folderName: 'my-tools',
  scope: '@my-tools',
  keep: ['lib', 'cli'],
  git: true,
  install: true,
  now: new Date(2026, 10, 28),
  holder: 'Ada',
};

const failed = (code: ErrorCode, left?: Left): Outcome => ({
  ok: false,
  error: { code, title: 'x', lines: [], fixes: [] },
  ...(left && { left }),
});

const ARGS = ['-y', '--scope', '@my-tools', '--examples', 'lib,cli'];

describe('retryStep', () => {
  it.each(['pnpm-too-old', 'pnpm-switch-failed', 'install-failed', 'interrupted'] as const)(
    'retries %s when nothing changed',
    (code) => {
      expect(retryStep(failed(code, { target: 'missing' }), plan, '/work')).toEqual({
        argv: [...ARGS, '--', 'my-tools'],
        cwd: '/work',
      });
    }
  );

  it.each([
    'usage',
    'target-not-empty',
    'cancelled',
    'lockfile-changed',
    'backup-failed',
    'move-failed',
    'unexpected',
  ] as const)('never retries %s', (code) => {
    expect(retryStep(failed(code, { target: 'missing' }), plan, '/work')).toBeUndefined();
  });

  it.each([
    ['a backup', { target: 'missing', backup: '/work/my-tools.backup-x' }],
    ['a leftover temporary folder', { target: 'missing', temp: '/work/.my-tools.tmp-1' }],
    ['pnpm still running', { target: 'missing', running: true }],
    ['a partial project', { target: 'partial' }],
    ['a split folder', { target: 'split', backup: '/work/b' }],
    ['a complete project', { target: 'complete' }],
    ['an unknown target', { target: 'unknown' }],
  ] as [string, Left][])('never retries with %s', (_, left) => {
    expect(retryStep(failed('install-failed', left), plan, '/work')).toBeUndefined();
  });

  it('never retries without left or without a plan', () => {
    expect(retryStep(failed('install-failed'), plan, '/work')).toBeUndefined();
    expect(
      retryStep(failed('install-failed', { target: 'missing' }), undefined, '/work')
    ).toBeUndefined();
  });

  it('never retries a success', () => {
    const ok = { ok: true, kind: 'checked', pnpm: { kind: 'none' }, warnings: [] } as Outcome;
    expect(retryStep(ok, plan, '/work')).toBeUndefined();
  });

  it('retries an empty or unchanged target', () => {
    expect(retryStep(failed('interrupted', { target: 'empty' }), plan, '/work')).toBeDefined();
    expect(retryStep(failed('interrupted', { target: 'unchanged' }), plan, '/work')).toBeDefined();
  });

  it('keeps --force only while the folder still has files and was to be replaced', () => {
    const replace = { ...plan, replace: true };
    const argv = (p: RunPlan, target: Left['target']) =>
      retryStep(failed('install-failed', { target }), p, '/work')?.argv;
    expect(argv(replace, 'unchanged')).toContain('--force');
    expect(argv(replace, 'missing')).not.toContain('--force');
    expect(argv(replace, 'empty')).not.toContain('--force');
    expect(argv(plan, 'unchanged')).not.toContain('--force');
  });

  it('writes --no-git, --no-install and --json from the plan', () => {
    const off = { ...plan, git: false, install: false };
    expect(
      retryStep(failed('install-failed', { target: 'missing' }), off, '/work', true)?.argv
    ).toEqual([...ARGS, '--no-git', '--no-install', '--json', '--', 'my-tools']);
  });

  it('puts the folder last, after --, so a folder starting with - stays a folder', () => {
    const dashed = { ...plan, folder: '-odd' };
    expect(
      retryStep(failed('install-failed', { target: 'missing' }), dashed, '/work')?.argv.slice(-2)
    ).toEqual(['--', '-odd']);
  });

  it('uses the absolute target when the folder as given is unknown', () => {
    const { folder: _, ...noFolder } = plan;
    expect(
      retryStep(failed('install-failed', { target: 'missing' }), noFolder, '/work')?.argv.at(-1)
    ).toBe('/work/my-tools');
  });
});
