import { cp, open, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLES, type Example } from './args.js';
import { applyMarkers, commentStyle } from './markers.js';
import { DOTFILE_RENAMES } from './template.js';

const EXAMPLE_DIRS: Record<Example, string[]> = {
  lib: ['packages/shared', 'packages/lib'],
  cli: ['packages/cli'],
  web: ['packages/web'],
};

// Files that only make sense inside the template repo itself.
const TEMPLATE_ONLY_FILES = ['scripts/check-examples.mjs', 'scripts/check-examples.test.ts'];

// pnpm rewrites the lockfile after generation, so it is never edited here.
const LOCKFILE = 'pnpm-lock.yaml';

interface GenerateInput {
  from: string;
  to: string;
  folderName: string;
  scope: string;
  holder: string;
  year: number;
  keep: Example[];
}

/** Repo-relative paths (with `/`) of every file under `dir`. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(dir, path) : [path];
    })
  );
  return nested.flat();
}

async function isText(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

type Edit = { file: string; from: string | RegExp; to: string };

function identityEdits(input: GenerateInput): Edit[] {
  const { folderName, holder, year } = input;
  return [
    { file: 'package.json', from: '"name": "ts-monorepo-starter"', to: `"name": "${folderName}"` },
    { file: 'README.md', from: '# TypeScript Monorepo Starter', to: `# ${folderName}` },
    { file: 'README.md', from: /^ts-monorepo-starter\/$/m, to: `${folderName}/` },
    { file: 'README.md', from: 'cd ts-monorepo-starter', to: `cd ${folderName}` },
    {
      file: 'README.md',
      from: 'yourusername/ts-monorepo-starter.git',
      to: `yourusername/${folderName}.git`,
    },
    {
      file: 'LICENSE',
      from: 'Copyright (c) 2025 prosdevlab',
      to: `Copyright (c) ${year} ${holder}`,
    },
  ];
}

/** Writes the chosen examples of the template at `from` into `to`; touches nothing else. */
export async function generate(input: GenerateInput): Promise<void> {
  const { from, to, scope, keep } = input;
  await cp(from, to, { recursive: true });

  const all = await listFiles(to);
  for (const file of all) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const renamed = DOTFILE_RENAMES[name];
    if (renamed) await rename(join(to, file), join(to, file.slice(0, -name.length) + renamed));
  }

  const removed = EXAMPLES.filter((example) => !keep.includes(example));
  const doomed = [...removed.flatMap((example) => EXAMPLE_DIRS[example]), ...TEMPLATE_ONLY_FILES];
  for (const path of doomed) await rm(join(to, path), { recursive: true, force: true });
  // The template-only files may have been all of scripts/.
  const scripts = join(to, 'scripts');
  const left = await readdir(scripts).catch(() => null);
  if (left?.length === 0) await rmdir(scripts);

  const remove = new Set<string>(removed);
  const identity = identityEdits(input);
  const present = await listFiles(to);
  for (const edit of identity) {
    if (!present.includes(edit.file)) {
      throw new Error(
        `Template changed: "${typeof edit.from === 'string' ? edit.from : 'ts-monorepo-starter/'}" not found in ${edit.file}`
      );
    }
  }
  for (const file of present) {
    if (file === LOCKFILE || !(await isText(join(to, file)))) continue;
    const original = await readFile(join(to, file), 'utf8');
    let text = commentStyle(file) ? applyMarkers(original, file, remove) : original;
    text = text.replaceAll('@monorepo/', `${scope}/`);
    for (const edit of identity.filter((entry) => entry.file === file)) {
      const found = typeof edit.from === 'string' ? text.includes(edit.from) : edit.from.test(text);
      if (!found) {
        const shown = typeof edit.from === 'string' ? edit.from : 'ts-monorepo-starter/';
        throw new Error(`Template changed: "${shown}" not found in ${file}`);
      }
      text = text.replace(edit.from, () => edit.to);
    }
    if (text !== original) await writeFile(join(to, file), text);
  }
}
