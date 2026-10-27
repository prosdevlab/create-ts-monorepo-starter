import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { helpText } from '../src/ui';

// Runs the *built* command the way a user would. CI builds before testing; locally run `pnpm build` first.
const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('built cli bin', () => {
  beforeAll(() => {
    if (!existsSync(bin))
      throw new Error(`${bin} is missing: run \`pnpm build\` before the tests.`);
  });

  it('starts with a node shebang and is executable', () => {
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(() => accessSync(bin, constants.X_OK)).not.toThrow();
  });

  it('prints the help and exits 0', () => {
    const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${helpText()}\n`);
    expect(result.stderr).toBe('');
  });
});
