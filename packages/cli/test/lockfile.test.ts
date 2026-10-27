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

const tricky = `packages:

  # a comment between entries

  x@https://example.com/x.tgz:
    resolution: {tarball: https://example.com/x.tgz}

  # comment at the start of a line does not end the section
  x@file:../y:
    resolution: {directory: ../y}

  pkg@1.0.0(react@18.0.0):
    resolution: {integrity: sha512-z}

  node@runtime:26.12.1:
    resolution: {type: variations}
`;

describe('lockfileEntries', () => {
  it('reads keys that contain colons, peer suffixes and comments', () => {
    expect([...lockfileEntries(tricky)].sort()).toEqual([
      'node@runtime:26.12.1',
      'pkg@1.0.0(react@18.0.0)',
      'x@file:../y',
      'x@https://example.com/x.tgz',
    ]);
  });

  it('finds the node runtime in both sections of the bundled lockfile', () => {
    const without = bundled
      .split('\n')
      .filter((l) => !l.startsWith('  node@runtime:26.12.1:'))
      .join('\n');
    expect(without).not.toBe(bundled);
    expect(() => assertLockfileSubset(without, bundled)).toThrow(
      /\+ packages: node@runtime:26\.12\.1\n\+ snapshots: node@runtime:26\.12\.1/
    );
    expect(lockfileEntries(bundled)).toContain('node@runtime:26.12.1');
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
