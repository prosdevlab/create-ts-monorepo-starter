import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-template-release.mjs', import.meta.url));
const temps: string[] = [];

function check(pinned: string, latest: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
  temps.push(dir);
  const file = join(dir, 'template-version.json');
  writeFileSync(file, JSON.stringify({ repository: 'o/r', tag: pinned, commit: 'abc' }));
  return spawnSync(process.execPath, latest === undefined ? [script] : [script, latest], {
    encoding: 'utf8',
    env: { ...process.env, TEMPLATE_VERSION_FILE: file, LATEST_TAG: '' },
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-template-release', () => {
  it('fails naming the latest release when the pinned tag is behind', () => {
    const result = check('v0.0.0', 'v2.3.0');
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      'Template v2.3.0 is out; update packages/cli/template-version.json'
    );
  });

  it('passes when the pinned tag is the latest release', () => {
    expect(check('v2.3.0', 'v2.3.0').status).toBe(0);
  });

  it('fails when no latest tag is given', () => {
    expect(check('v2.3.0', undefined).status).toBe(1);
  });
});
