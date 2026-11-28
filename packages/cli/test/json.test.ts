import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crashJson, SCHEMA_VERSION, toJson, versionJson } from '../src/json';
import type { Outcome } from '../src/outcome';
import type { RunPlan, RunResult } from '../src/run';
import { cliVersion, pnpmSpec, templateVersion } from '../src/template';

const cli = { version: cliVersion(), template: templateVersion() };
const pinned = pnpmSpec().slice('pnpm@'.length);
const work = resolve('/work');
const target = join(work, 'my-tools');

const plan = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  target,
  folder: 'my-tools',
  folderName: 'my-tools',
  scope: '@my-tools',
  keep: ['cli', 'lib'],
  git: true,
  install: true,
  now: new Date(2026, 10, 28),
  holder: 'Ada',
  ...overrides,
});

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  pnpm: { kind: 'ok', version: '10.28.0' },
  installed: true,
  git: 'committed',
  packages: ['@my-tools/lib', '@my-tools/shared', '@my-tools/cli'],
  seconds: 12,
  warnings: [],
  ...overrides,
});

const CHECKLIST = [
  {
    item: 'Previews on every PR: install the pkg.pr.new app, set PKG_PR_NEW',
    readme: 'Preview Packages',
  },
  {
    item: 'Private vulnerability reporting: Settings → Advanced Security',
    readme: 'Issues, Pull Requests and Security Reports',
  },
  {
    item: 'Publish to npm: add a repository field to each package, a trusted publisher for ci.yml, set NPM_PUBLISH',
    readme: 'Setting Up npm Publishing',
  },
];

/** The object, after the same trip through JSON a consumer makes: no undefined keys survive. */
const json = (outcome: Outcome) => {
  const object = toJson(outcome);
  expect(JSON.parse(JSON.stringify(object))).toStrictEqual(object);
  return object;
};

describe('toJson', () => {
  it('maps a created project, and never the plan internals', () => {
    const object = json({
      ok: true,
      kind: 'created',
      plan: plan(),
      result: result(),
      warnings: [],
      left: { target: 'complete' },
    });
    expect(object).toStrictEqual({
      schemaVersion: 1,
      cli,
      ok: true,
      kind: 'created',
      project: {
        path: target,
        folder: 'my-tools',
        name: 'my-tools',
        scope: '@my-tools',
        examples: { kept: ['lib', 'cli'], removed: ['web'] },
      },
      git: 'committed',
      install: { ran: true, seconds: 12 },
      pnpm: { found: '10.28.0', pinned },
      left: { target: 'complete' },
      warnings: [],
      next: [
        { argv: ['pnpm', 'build'], cwd: target },
        { argv: ['pnpm', 'test'], cwd: target },
      ],
      checklist: CHECKLIST,
    });
    expect(JSON.stringify(object)).not.toMatch(/Ada|holder|"now"/);
  });

  it('maps a project made in place over a backup, with no pnpm, and nothing installed', () => {
    const backup = join(work, 'my-tools.backup-20261128-090000');
    const warning = {
      code: 'pnpm-missing',
      title: "pnpm isn't installed",
      lines: ['Installing with a temporary pnpm instead (npm exec).'],
      fixes: [{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' as const }],
    };
    const object = json({
      ok: true,
      kind: 'created',
      // The folder as given, resolved against a cwd that isn't the target's parent.
      plan: plan({ folder: '../work/my-tools', replace: true }),
      result: result({ pnpm: { kind: 'none' }, installed: false, seconds: 0, backup }),
      warnings: [warning],
      left: { target: 'complete', backup },
    });
    expect(object).toMatchObject({
      project: { path: target, folder: '../work/my-tools' },
      install: { ran: false, seconds: 0 },
      pnpm: { found: null, pinned },
      left: { target: 'complete', backup },
      warnings: [warning],
      next: [
        { argv: ['npm', 'install', '-g', 'pnpm'], cwd: target },
        { argv: ['pnpm', 'install'], cwd: target },
        { argv: ['pnpm', 'build'], cwd: target },
        { argv: ['pnpm', 'test'], cwd: target },
      ],
    });
  });

  it('maps --check, ready and without pnpm', () => {
    expect(
      json({ ok: true, kind: 'checked', pnpm: { kind: 'ok', version: '10.28.0' }, warnings: [] })
    ).toStrictEqual({
      schemaVersion: 1,
      cli,
      ok: true,
      kind: 'checked',
      pnpm: { found: '10.28.0', pinned },
      warnings: [],
    });
    const warning = { code: 'pnpm-missing', title: 't', lines: ['l'], fixes: [] };
    expect(
      json({ ok: true, kind: 'checked', pnpm: { kind: 'none' }, warnings: [warning] })
    ).toStrictEqual({
      schemaVersion: 1,
      cli,
      ok: true,
      kind: 'checked',
      pnpm: { found: null, pinned },
      warnings: [warning],
    });
  });

  it('maps a failure with everything it can carry', () => {
    const temp = join(work, '.my-tools.tmp-0a1b2c3d');
    const object = json({
      ok: false,
      error: {
        code: 'install-failed',
        title: "Couldn't install dependencies (pnpm exited with 1)",
        lines: ['ERR_PNPM_FETCH'],
        fixes: [{ see: 'https://pnpm.io/installation', scope: 'user' }],
        output: ['ERR_PNPM_FETCH'],
        required: { pnpm: '>=10.26' },
        found: { pnpm: '9.0.0' },
      },
      left: { target: 'unchanged', temp, running: true },
      retry: { argv: ['-y', '--json', '--', 'my-tools'], cwd: work },
    });
    expect(object).toStrictEqual({
      schemaVersion: 1,
      cli,
      ok: false,
      kind: 'failed',
      error: {
        code: 'install-failed',
        title: "Couldn't install dependencies (pnpm exited with 1)",
        lines: ['ERR_PNPM_FETCH'],
        fixes: [{ see: 'https://pnpm.io/installation', scope: 'user' }],
        output: ['ERR_PNPM_FETCH'],
        required: { pnpm: '>=10.26' },
        found: { pnpm: '9.0.0' },
      },
      left: { target: 'unchanged', temp, running: true },
      retry: { argv: ['-y', '--json', '--', 'my-tools'], cwd: work },
    });
  });

  it('leaves out what a failure lacks', () => {
    expect(
      json({ ok: false, error: { code: 'usage', title: 'bad flag', lines: [], fixes: [] } })
    ).toStrictEqual({
      schemaVersion: 1,
      cli,
      ok: false,
      kind: 'failed',
      error: { code: 'usage', title: 'bad flag', lines: [], fixes: [] },
    });
  });

  it('copies, so changing the outcome later changes nothing printed', () => {
    const lines = ['a'];
    const object = toJson({
      ok: false,
      error: { code: 'unexpected', title: 't', lines, fixes: [] },
    });
    lines.push('b');
    expect(object).toMatchObject({ error: { lines: ['a'] } });
  });
});

describe('versionJson and crashJson', () => {
  it('prints the version object', () => {
    expect(versionJson()).toStrictEqual({ schemaVersion: 1, cli, ok: true, kind: 'version' });
  });

  it('prints an unexpected failure from the error alone', () => {
    expect(crashJson(new Error('boom\nat line 2'))).toStrictEqual({
      schemaVersion: 1,
      cli,
      ok: false,
      kind: 'failed',
      error: { code: 'unexpected', title: 'boom', lines: ['at line 2'], fixes: [] },
    });
    expect(SCHEMA_VERSION).toBe(1);
  });
});
