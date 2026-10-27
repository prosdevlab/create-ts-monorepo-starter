import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { RunPlan, RunResult } from '../src/run';
import { templateVersion } from '../src/template';
import { helpText, plainUi, versionText } from '../src/ui';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

/** A real (non-terminal) stream that keeps what was written. */
function collector() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, read: () => text };
}

function capture() {
  const out = collector();
  const err = collector();
  return { ui: plainUi({ out: out.stream, err: err.stream }), out: out.read, err: err.read };
}

const plan: RunPlan = {
  target: resolve('acme-tools'),
  folderName: 'acme-tools',
  scope: '@acme',
  keep: ['lib', 'cli'],
  git: true,
  install: true,
  now: new Date(2026, 9, 27),
  holder: 'Ada',
};

const result: RunResult = {
  pnpm: { kind: 'ok', version: '12.15.0' },
  installed: true,
  git: 'committed',
  packages: ['@acme/lib', '@acme/shared', '@acme/cli'],
  seconds: 9,
};

describe('versionText', () => {
  it('names the CLI version and the bundled template tag', () => {
    const { tag, commit } = templateVersion();
    expect(versionText()).toBe(
      `create-ts-monorepo-starter ${version} · template ${tag ?? commit.slice(0, 7)}`
    );
  });
});

describe('helpText', () => {
  it('is the Help screen', () => {
    expect(helpText()).toBe(
      [
        versionText(),
        'Create a TypeScript monorepo for CLIs, libraries and browser libraries.',
        '',
        'Usage',
        '  pnpm create ts-monorepo-starter [folder] [options]',
        '',
        'Options',
        '  --scope <@name>     npm scope for the packages   default: @<folder>',
        '  --examples <list>   lib, cli, web, comma-separated default: all three',
        "  --no-git            don't initialize git",
        "  --no-install        don't install dependencies",
        '  --force             move a non-empty folder aside first',
        '  -y, --yes           accept every default, ask nothing',
        '  -h, --help          show this help',
        '  -v, --version       show the CLI and template versions',
        '',
        'Examples',
        '  pnpm create ts-monorepo-starter my-tools',
        '  pnpm create ts-monorepo-starter my-tools -y',
        '  npm create ts-monorepo-starter@latest my-tools -- --examples lib,cli',
        '',
        'npm needs -- before the options. Docs: README of the generated project.',
      ].join('\n')
    );
  });
});

describe('plainUi', () => {
  it('prints the header and one ✓ line per step', () => {
    const { ui, out } = capture();
    ui.intro();
    ui.step('Created acme-tools', '@acme/lib, @acme/shared, @acme/cli; web removed');
    ui.start('Installing dependencies with pnpm 12.15.0');
    ui.stop();
    ui.step('Installed dependencies with pnpm 12.15.0 (9s)');
    expect(out()).toBe(
      [
        versionText(),
        '✓ Created acme-tools (@acme/lib, @acme/shared, @acme/cli; web removed)',
        'Installing dependencies with pnpm 12.15.0…',
        '✓ Installed dependencies with pnpm 12.15.0 (9s)',
        '',
      ].join('\n')
    );
  });

  it('sends warnings and failures to stderr', () => {
    const { ui, out, err } = capture();
    ui.warn("pnpm isn't installed", ['Installing with a temporary pnpm instead.']);
    ui.fail('pnpm 9.15.9 is too old for this project', ['Install skipped.']);
    expect(out()).toBe('');
    expect(err()).toBe(
      [
        "! pnpm isn't installed",
        '  Installing with a temporary pnpm instead.',
        '✗ pnpm 9.15.9 is too old for this project',
        '  Install skipped.',
        '',
      ].join('\n')
    );
  });

  it('lists the next commands, then previews, security reporting and publishing', () => {
    const { ui, out } = capture();
    ui.outro(result, plan);
    const text = out();
    expect(text).toBe(
      [
        '',
        'Next: cd acme-tools && pnpm build && pnpm test',
        '',
        'When you want them (README section in brackets):',
        '  • Previews on every PR: install the pkg.pr.new app, set PKG_PR_NEW [Preview Packages]',
        '  • Private vulnerability reporting: Settings → Advanced Security [Issues, Pull Requests and Security Reports]',
        '  • Publish to npm: add a repository field to each package, a trusted publisher for ci.yml, set NPM_PUBLISH [Setting Up npm Publishing]',
        '',
      ].join('\n')
    );
    const order = ['cd acme-tools', 'pnpm build && pnpm test', 'PKG_PR_NEW', 'vulnerability'];
    const positions = [...order, 'repository field', 'ci.yml', 'NPM_PUBLISH'].map((s) =>
      text.indexOf(s)
    );
    expect(positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] as number)))).toBe(
      true
    );
  });

  it('asks for pnpm before the first commit when none is installed', () => {
    const { ui, out } = capture();
    ui.outro({ ...result, pnpm: { kind: 'none' } }, plan);
    const text = out();
    expect(text).toContain(
      [
        'One step left before your first commit:',
        '  npm install -g pnpm',
        '  The git hooks run pnpm. Any pnpm from 10.26 on switches itself to 12.',
        '',
        'Next: cd acme-tools && pnpm build && pnpm test',
      ].join('\n')
    );
  });

  it('tells an old pnpm to upgrade, then install', () => {
    const { ui, out } = capture();
    ui.outro({ ...result, pnpm: { kind: 'old', version: '9.15.9' }, installed: false }, plan);
    expect(out()).toContain(
      [
        'Upgrade pnpm, then install:',
        '  npm install -g pnpm',
        '  Any pnpm from 10.26 on switches itself to 12.15.0 for this project.',
        '',
        'Next: cd acme-tools && pnpm install && pnpm build && pnpm test',
      ].join('\n')
    );
  });

  it('says the first pnpm install still has to run with install off', () => {
    const { ui, out } = capture();
    ui.outro({ ...result, installed: false }, { ...plan, install: false });
    expect(out()).toContain(
      [
        "Dependencies aren't installed: the first pnpm install installs them and the git hooks.",
        '',
        'Next: cd acme-tools && pnpm install && pnpm build && pnpm test',
      ].join('\n')
    );
  });

  it('leaves out cd when the project is the current folder', () => {
    const { ui, out } = capture();
    ui.outro(result, { ...plan, target: process.cwd() });
    expect(out()).toContain('Next: pnpm build && pnpm test');
  });
});
