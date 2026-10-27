import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLockfileSubset, LockfileError, lockfileEntries } from '../src/lockfile';
import { templateDir } from '../src/template';

const fixture = `lockfileVersion: '9.0'

packages:

  '@scope/pkg@1.0.0':
    resolution: {integrity: sha512-x}

  plain@2.0.0:
    resolution: {integrity: sha512-y}

snapshots:

  plain@2.0.0: {}
---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      nope@9.9.9:
        version: 1.0.0

packages:

  other@3.0.0:
    engines: {node: '>=1'}

snapshots:

  other@3.0.0:
    dependencies:
      plain: 2.0.0
`;

const bundled = readFileSync(join(templateDir(), 'pnpm-lock.yaml'), 'utf8');

describe('lockfileEntries', () => {
  it('reads packages and snapshots from every document and unquotes keys', () => {
    expect([...lockfileEntries(fixture)].sort()).toEqual([
      '@scope/pkg@1.0.0',
      'other@3.0.0',
      'plain@2.0.0',
    ]);
  });

  it('reads both documents of the bundled lockfile', () => {
    const entries = lockfileEntries(bundled);
    expect(entries).toContain('typescript@7.0.2');
    expect(entries).toContain('@pnpm/exe.android-arm64@12.15.0');
    expect([...entries].some((e) => e.startsWith('@commitlint/cli@21.2.4('))).toBe(true);
  });
});

describe('assertLockfileSubset', () => {
  it('passes when entries were only removed', () => {
    expect(() =>
      assertLockfileSubset(fixture, fixture.replace(/ {2}plain@2.0.0: \{\}\n/, ''))
    ).not.toThrow();
  });

  it('passes for an identical lockfile', () => {
    expect(() => assertLockfileSubset(bundled, bundled)).not.toThrow();
  });

  it('names an added entry', () => {
    const added = `${bundled}\npackages:\n\n  left-pad@1.3.0:\n    resolution: {}\n`;
    expect(() => assertLockfileSubset(bundled, added)).toThrow(LockfileError);
    expect(() => assertLockfileSubset(bundled, added)).toThrow(
      'Lockfile changed during install:\n+ packages: left-pad@1.3.0'
    );
  });

  it('lists at most 10 and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => `  p${i}@1.0.0:\n    x: 1\n`).join('\n');
    const generated = `packages:\n\n${many}`;
    let message = '';
    try {
      assertLockfileSubset('packages:\n', generated);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n')).toHaveLength(12);
    expect(message).toContain('+ packages: p9@1.0.0');
    expect(message).not.toContain('p10@1.0.0');
    expect(message.endsWith('…and 3 more')).toBe(true);
  });

  it('treats a snapshot as distinct from a package of the same key', () => {
    expect(() =>
      assertLockfileSubset('packages:\n\n  a@1.0.0:\n    x: 1\n', 'snapshots:\n\n  a@1.0.0: {}\n')
    ).toThrow('+ snapshots: a@1.0.0');
  });
});
