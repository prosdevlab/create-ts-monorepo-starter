import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

it('the published tarball keeps every template file', () => {
  const out = mkdtempSync(join(tmpdir(), 'pack-test-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: root, stdio: 'pipe' });
    const tarball = execFileSync('node', ['-e', "console.log(fs.readdirSync('.')[0])"], {
      cwd: out,
      encoding: 'utf8',
    }).trim();
    const listed = new Set(
      execFileSync('tar', ['-tzf', join(out, tarball)], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    );
    const manifest: string[] = JSON.parse(
      readFileSync(join(root, 'dist/template-manifest.json'), 'utf8')
    );
    const missing = manifest.filter((p) => !listed.has(`package/dist/template/${p}`));
    expect(missing).toEqual([]);
    expect(listed.has('package/dist/cli.js')).toBe(true);
    expect(listed.has('package/dist/THIRD_PARTY_NOTICES.txt')).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
