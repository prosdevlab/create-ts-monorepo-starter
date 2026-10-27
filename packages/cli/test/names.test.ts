import { describe, expect, it } from 'vitest';
import { defaultScope, NameError, normalizeScope, packageNameFromFolder } from '../src/names';

describe('packageNameFromFolder', () => {
  it.each([
    ['my-tools', undefined, 'my-tools'],
    ['My Tools', undefined, 'my-tools'],
    ['/tmp/x/Acme_Libs', undefined, 'acme_libs'],
    ['.', '/home/u/proj', 'proj'],
    ['a//b  c!!d', undefined, 'b-c-d'],
    ['--lead.', undefined, 'lead'],
    [
      'C:\\work\\My Tools',
      undefined,
      process.platform === 'win32' ? 'my-tools' : 'c-work-my-tools',
    ],
  ])('%s (cwd %s) -> %s', (folder, cwd, expected) => {
    expect(packageNameFromFolder(folder, cwd)).toBe(expected);
  });

  it('throws NameError when nothing usable is left', () => {
    expect(() => packageNameFromFolder('---')).toThrow(NameError);
    expect(() => packageNameFromFolder('---')).toThrow(`Can't make an npm package name from "---"`);
  });

  it('accepts 214 characters and rejects 215', () => {
    expect(packageNameFromFolder('a'.repeat(214))).toHaveLength(214);
    expect(() => packageNameFromFolder('a'.repeat(215))).toThrow(NameError);
  });
});

describe('defaultScope', () => {
  it('prefixes the derived package name with @', () => {
    expect(defaultScope('My Tools')).toBe('@my-tools');
    expect(defaultScope('.', '/home/u/proj')).toBe('@proj');
  });

  it('throws NameError like packageNameFromFolder', () => {
    expect(() => defaultScope('---')).toThrow(NameError);
  });
});

describe('normalizeScope', () => {
  it.each([
    ['acme', '@acme'],
    ['@Acme', '@acme'],
    ['  @a.b_c-1 ', '@a.b_c-1'],
  ])('%s -> %s', (input, scope) => {
    expect(normalizeScope(input)).toEqual({ ok: true, scope });
  });

  it('rejects invalid characters with the typed input in the message', () => {
    expect(normalizeScope('@a b')).toEqual({
      ok: false,
      message: 'Scope "@a b" can only contain lowercase letters, digits, "-", "." and "_".',
    });
  });

  it.each(['', '@', 'a/b'])('rejects %j', (input) => {
    expect(normalizeScope(input).ok).toBe(false);
  });
});
