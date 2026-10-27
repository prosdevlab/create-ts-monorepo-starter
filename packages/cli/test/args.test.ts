import { describe, expect, it } from 'vitest';
import { EXAMPLES, parseArgv } from '../src/args';

function options(argv: string[]) {
  const result = parseArgv(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
  return result.options;
}

function message(argv: string[]) {
  const result = parseArgv(argv);
  if (result.ok) throw new Error('expected a failure');
  return result.message;
}

describe('parseArgv', () => {
  it('lists the examples', () => {
    expect(EXAMPLES).toEqual(['lib', 'cli', 'web']);
  });

  it('defaults', () => {
    expect(options([])).toEqual({
      git: true,
      install: true,
      force: false,
      yes: false,
      help: false,
      version: false,
    });
  });

  it('reads a folder and -y', () => {
    expect(options(['my-tools', '-y'])).toMatchObject({
      folder: 'my-tools',
      yes: true,
      git: true,
      install: true,
    });
  });

  it('reads --examples and --no-install', () => {
    expect(options(['x', '--examples', 'lib,cli', '--no-install'])).toMatchObject({
      examples: ['lib', 'cli'],
      install: false,
    });
  });

  it('trims, drops empty entries and removes duplicates keeping order', () => {
    expect(options(['x', '--examples', ' web, lib,,web ,lib'])).toMatchObject({
      examples: ['web', 'lib'],
    });
  });

  it('reads --no-git, --force, --yes, --help, --version and short forms', () => {
    expect(options(['--no-git'])).toMatchObject({ git: false });
    expect(options(['--force'])).toMatchObject({ force: true });
    expect(options(['--yes'])).toMatchObject({ yes: true });
    expect(options(['--help'])).toMatchObject({ help: true });
    expect(options(['-h'])).toMatchObject({ help: true });
    expect(options(['--version'])).toMatchObject({ version: true });
    expect(options(['-v'])).toMatchObject({ version: true });
  });

  it('records --scope as typed without validating it', () => {
    expect(options(['x', '--scope', '@Not Valid'])).toMatchObject({ scope: '@Not Valid' });
  });

  it('rejects an unknown example', () => {
    expect(message(['x', '--examples', 'api'])).toBe(
      'Unknown example "api". Choose from lib, cli, web.'
    );
  });

  it('rejects an empty example list', () => {
    expect(message(['x', '--examples', ''])).toBe('Choose at least one example.');
    expect(message(['x', '--examples', ' , '])).toBe('Choose at least one example.');
  });

  it('rejects an unknown option', () => {
    expect(message(['--frobnicate'])).toBe(
      'Unknown option --frobnicate. Run with --help to see the options.'
    );
  });

  it('rejects more than one folder', () => {
    expect(message(['a', 'b'])).toBe('Expected one folder, got 2: a, b');
  });

  it('turns other parser errors into a message instead of throwing', () => {
    expect(message(['--scope'])).toMatch(/--scope/);
  });
});
