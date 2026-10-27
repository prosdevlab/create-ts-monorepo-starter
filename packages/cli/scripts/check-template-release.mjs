// Fails when the template has a newer release than the one pinned in template-version.json.
// The latest release tag comes from the first argument or LATEST_TAG; TEMPLATE_VERSION_FILE overrides the file.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const versionFile = resolve(
  process.env.TEMPLATE_VERSION_FILE ?? join(root, 'template-version.json')
);
const latest = (process.argv[2] ?? process.env.LATEST_TAG ?? '').trim();
const { tag } = JSON.parse(readFileSync(versionFile, 'utf8'));

if (!latest) {
  console.error('No latest template release tag given (argument or LATEST_TAG).');
  process.exit(1);
}
if (latest !== tag) {
  console.error(`Template ${latest} is out; update packages/cli/template-version.json`);
  process.exit(1);
}
console.log(`Template ${tag} is the latest release.`);
