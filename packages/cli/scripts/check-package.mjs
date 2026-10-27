// Packs the real tarball and runs publint --strict on it. Messages about dist/template/ are
// skipped: those are the template's own nested package.json files, which are data here.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'check-package-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', out], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  const [tarball] = readdirSync(out);
  const { messages, pkg } = await publint({
    strict: true,
    pack: { tarball: readFileSync(join(out, tarball)).buffer },
  });
  const reported = messages.filter((m) => !m.args?.filePath?.includes('dist/template/'));
  for (const message of reported) {
    console.error(`${message.type}: ${formatMessage(message, pkg)}`);
  }
  if (reported.length > 0) process.exitCode = 1;
  else console.log('publint: all good');
} catch (error) {
  console.error(`check-package failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
