import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DOTFILE_RENAMES, templateDir, templateVersion } from '../src/template';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/fetch-template.mjs');
const pinned = JSON.parse(readFileSync(join(root, 'template-version.json'), 'utf8'));
const temps: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'template-test-'));
  temps.push(dir);
  return dir;
}

function fetchTemplate(env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bundled template', () => {
  it('the bundled template is the pinned release', () => {
    expect(templateVersion()).toEqual({ tag: pinned.tag, commit: pinned.commit });
    const manifest: string[] = JSON.parse(
      readFileSync(join(templateDir(), '..', 'template-manifest.json'), 'utf8')
    );
    for (const path of manifest) expect(existsSync(join(templateDir(), path)), path).toBe(true);
    expect(manifest).toEqual(
      expect.arrayContaining([
        '_gitignore',
        'pnpm-lock.yaml',
        'packages/lib/package.json',
        '.github/workflows/ci.yml',
      ])
    );
    expect(DOTFILE_RENAMES).toEqual({ _gitignore: '.gitignore', _npmrc: '.npmrc' });
  });

  it('fetch refuses a tag that moved', () => {
    const dir = tempDir();
    const versionFile = join(dir, 'template-version.json');
    writeFileSync(versionFile, JSON.stringify({ ...pinned, commit: '0'.repeat(40) }));
    const result = fetchTemplate({
      TEMPLATE_VERSION_FILE: versionFile,
      TEMPLATE_DIST: join(dir, 'dist'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/v2\.3\.0 points at [0-9a-f]{40}, expected 0{40}/);
    expect(existsSync(join(dir, 'dist'))).toBe(false);
  });

  it('turbo passes TEMPLATE_REF to the build task', () => {
    const turbo = JSON.parse(readFileSync(join(root, '../../turbo.json'), 'utf8'));
    expect(turbo.tasks.build.env).toContain('TEMPLATE_REF');
  });

  it('fetch with TEMPLATE_REF records the branch commit', () => {
    const dist = join(tempDir(), 'dist');
    const result = fetchTemplate({ TEMPLATE_REF: 'main', TEMPLATE_DIST: dist });
    expect(result.status, result.stderr).toBe(0);
    const version = JSON.parse(readFileSync(join(dist, 'template-version.json'), 'utf8'));
    expect(version.tag).toBeNull();
    expect(version.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(dist, 'template', '_gitignore'))).toBe(true);
  });
});
