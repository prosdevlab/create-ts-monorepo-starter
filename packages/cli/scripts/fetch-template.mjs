// Bundles the pinned ts-monorepo-starter release into dist/template (see template-version.json).
// TEMPLATE_REF=<branch> bundles that branch instead. TEMPLATE_VERSION_FILE and TEMPLATE_DIST
// override the version file and output folder (used by the tests).
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const versionFile = resolve(
  process.env.TEMPLATE_VERSION_FILE ?? join(root, 'template-version.json')
);
const dist = resolve(process.env.TEMPLATE_DIST ?? join(root, 'dist'));
const ref = process.env.TEMPLATE_REF || undefined;
const renames = { '.gitignore': '_gitignore', '.npmrc': '_npmrc' };

const { repository, tag, commit: pinned } = JSON.parse(readFileSync(versionFile, 'utf8'));
const checkout = ref ?? tag;
const work = mkdtempSync(join(tmpdir(), 'ts-monorepo-starter-'));
const clone = join(work, 'template');

function fail(message) {
  rmSync(work, { recursive: true, force: true });
  console.error(message);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

// Renames dotfiles at any depth and returns every file path, relative to the template root.
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    let path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`the template contains a symlink: ${path}`);
    if (entry.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (renames[entry.name]) {
      const renamed = join(dir, renames[entry.name]);
      renameSync(path, renamed);
      path = renamed;
    }
    files.push(path);
  }
  return files;
}

try {
  git(
    '-c',
    'advice.detachedHead=false',
    '-c',
    'core.autocrlf=false',
    'clone',
    '--depth',
    '1',
    '--branch',
    checkout,
    `https://github.com/${repository}.git`,
    clone
  );
  const commit = git('-C', clone, 'rev-parse', 'HEAD');
  if (!ref && commit !== pinned) fail(`${tag} points at ${commit}, expected ${pinned}`);

  rmSync(join(clone, '.git'), { recursive: true, force: true });
  const manifest = walk(clone)
    .map((file) => relative(clone, file).split('\\').join('/'))
    .sort();

  console.log(`Bundling ${ref ? `branch ${ref}` : tag} at ${commit}`);
  rmSync(join(dist, 'template'), { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(clone, join(dist, 'template'), { recursive: true });
  writeFileSync(join(dist, 'template-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dist, 'template-version.json'),
    `${JSON.stringify({ repository, tag: ref ? null : tag, commit }, null, 2)}\n`
  );
} catch (error) {
  fail(`Could not fetch the template: ${error.message}`);
}
rmSync(work, { recursive: true, force: true });
