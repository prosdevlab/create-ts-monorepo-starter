// Points template-version.json at a template release and adds the matching changeset.
// The release is the first argument (a tag such as v2.3.1), or the latest release when none is given.
// GITHUB_TOKEN, when set, raises GitHub's rate limit. TEMPLATE_VERSION_FILE, CHANGESET_DIR and
// GITHUB_API override the version file, the changeset folder and the API URL (used by the tests).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const versionFile = resolve(
  process.env.TEMPLATE_VERSION_FILE ?? join(root, 'template-version.json')
);
const changesetDir = resolve(process.env.CHANGESET_DIR ?? join(root, '../../.changeset'));
const api = process.env.GITHUB_API ?? 'https://api.github.com';
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function get(path) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`${api}${path}`, { headers }).catch((error) =>
    fail(`Couldn't reach GitHub: ${error.message}`)
  );
  if (!response.ok) fail(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

const pinned = JSON.parse(readFileSync(versionFile, 'utf8'));
const { repository } = pinned;
const release = process.argv[2]
  ? await get(`/repos/${repository}/releases/tags/${process.argv[2]}`)
  : await get(`/repos/${repository}/releases/latest`);
const tag = release.tag_name;

const next = TAG.exec(tag ?? '');
const current = TAG.exec(pinned.tag ?? '');
if (!next) fail(`Release tag ${tag} isn't vMAJOR.MINOR.PATCH`);
if (!current) fail(`Pinned tag ${pinned.tag} isn't vMAJOR.MINOR.PATCH`);
const order = (match) => match.slice(1).map(Number);
const [a, b] = [order(current), order(next)];
const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const cmp = compare(a, b);
if (cmp === 0) {
  console.log(`Already on template ${tag}; nothing to do.`);
  process.exit(0);
}
if (cmp > 0) fail(`Template ${tag} is older than the pinned ${pinned.tag}; refusing to go back`);

const { sha } = await get(`/repos/${repository}/commits/${tag}`);
// A template patch release is a CLI patch; anything bigger is a CLI minor (the CLI is 0.x).
const bump = a[0] === b[0] && a[1] === b[1] ? 'patch' : 'minor';

writeFileSync(versionFile, `${JSON.stringify({ repository, tag, commit: sha }, null, 2)}\n`);
const changeset = join(changesetDir, `template-${tag.replaceAll('.', '-')}.md`);
writeFileSync(
  changeset,
  `---\n"create-ts-monorepo-starter": ${bump}\n---\n\nBundle template ${tag} (https://github.com/${repository}/releases/tag/${tag}).\n`
);

console.log(`Template ${pinned.tag} -> ${tag} (${sha})`);
console.log(`Updated ${versionFile}`);
console.log(`Added ${changeset} (${bump})`);
// Every release since the pinned one, oldest first: skipped releases can change things too.
const releases = (await get(`/repos/${repository}/releases?per_page=100`))
  .map((entry) => ({ entry, match: TAG.exec(entry.tag_name ?? '') }))
  .filter(({ match }) => match)
  .map(({ entry, match }) => ({ entry, version: order(match) }))
  .filter(({ version }) => compare(version, a) > 0 && compare(version, b) <= 0)
  .sort((x, y) => compare(x.version, y.version));
for (const { entry } of releases) {
  console.log(`\n## ${entry.tag_name}\n`);
  console.log((entry.body ?? '').trim() || '(no release notes)');
}
console.log('\nNext: pnpm build && pnpm test && pnpm test:e2e');
