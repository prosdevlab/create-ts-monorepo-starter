import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Example } from '../src/args';
import { generate } from '../src/generate';
import { templateDir } from '../src/template';

const temps: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'generate-test-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, base) : [path.slice(base.length + 1)];
  });
}

function textFiles(dir: string): [string, string][] {
  return files(dir).map((file) => [file, readFileSync(join(dir, file), 'utf8')]);
}

async function run(keep: Example[], to = tempDir(), from = templateDir()) {
  await generate({
    from,
    to,
    folderName: 'my-tools',
    scope: '@acme',
    holder: 'Ada Lovelace',
    year: 2026,
    keep,
  });
  return to;
}

describe('generate', () => {
  it('all examples', async () => {
    const to = await run(['lib', 'cli', 'web']);
    for (const name of ['shared', 'lib', 'cli', 'web']) {
      expect(existsSync(join(to, 'packages', name))).toBe(true);
    }
    expect(existsSync(join(to, '.gitignore'))).toBe(true);
    expect(existsSync(join(to, '_gitignore'))).toBe(false);
    expect(existsSync(join(to, 'scripts/check-examples.mjs'))).toBe(false);
    expect(existsSync(join(to, 'scripts/check-examples.test.ts'))).toBe(false);
    for (const [file, text] of textFiles(to)) {
      if (file !== 'pnpm-lock.yaml') expect(text, file).not.toContain('@monorepo');
      expect(text, file).not.toContain('example:');
      expect(text, file).not.toContain('template-only');
    }
    expect(JSON.parse(readFileSync(join(to, 'package.json'), 'utf8')).name).toBe('my-tools');
    expect(readFileSync(join(to, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 Ada Lovelace');
    const readme = readFileSync(join(to, 'README.md'), 'utf8');
    expect(readme.startsWith('# my-tools\n')).toBe(true);
    expect(readme).toMatch(/^my-tools\/$/m);
    expect(readme).toContain('cd my-tools');
    expect(readme).toContain('yourusername/my-tools.git');
    expect(readme).not.toContain('ts-monorepo-starter');
  });

  it('keeps hooks executable', async () => {
    const to = await run(['lib']);
    if (process.platform !== 'win32') {
      expect(statSync(join(to, '.husky/pre-commit')).mode & 0o111).not.toBe(0);
    }
  });

  it('lib and cli only', async () => {
    const to = await run(['lib', 'cli']);
    expect(existsSync(join(to, 'packages/web'))).toBe(false);
    for (const [file, text] of textFiles(to)) {
      if (file === 'pnpm-lock.yaml') continue;
      for (const word of ['packages/web', '@acme/web', 'playwright', 'size-limit', 'axe-core']) {
        expect(text, `${file}: ${word}`).not.toContain(word);
      }
    }
  });

  it('cli only', async () => {
    const to = await run(['cli']);
    expect(existsSync(join(to, 'packages/shared'))).toBe(false);
    expect(existsSync(join(to, 'packages/lib'))).toBe(false);
    for (const file of ['tsconfig.json', 'vitest.config.ts']) {
      const text = readFileSync(join(to, file), 'utf8');
      expect(text, file).not.toMatch(/shared|packages\/lib|@acme\/lib/);
    }
  });

  it('a folder with spaces', async () => {
    const to = join(tempDir(), 'My Tools');
    await run(['lib', 'cli', 'web'], to);
    expect(JSON.parse(readFileSync(join(to, 'package.json'), 'utf8')).name).toBe('my-tools');
  });

  it('template drift', async () => {
    const from = join(tempDir(), 'template');
    cpSync(templateDir(), from, { recursive: true });
    const license = join(from, 'LICENSE');
    writeFileSync(license, readFileSync(license, 'utf8').replace('2025 prosdevlab', 'someone'));
    await expect(run(['lib'], tempDir(), from)).rejects.toThrow(
      'Template changed: "Copyright (c) 2025 prosdevlab" not found in LICENSE'
    );
  });

  it('never modifies the source', async () => {
    const before = textFiles(templateDir());
    await run(['cli']);
    expect(textFiles(templateDir())).toEqual(before);
  });
});
