// Runs publint --strict on package.json plus the bundle, minus dist/template: publint flags the
// template's own nested package.json files, which are data here, not part of this package.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'check-package-'));
try {
  mkdirSync(join(stage, 'dist'));
  cpSync(join(root, 'package.json'), join(stage, 'package.json'));
  for (const file of ['cli.js', 'THIRD_PARTY_NOTICES.txt']) {
    cpSync(join(root, 'dist', file), join(stage, 'dist', file));
  }
  execFileSync('pnpm', ['exec', 'publint', 'run', stage, '--strict', '--pack', 'false'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
