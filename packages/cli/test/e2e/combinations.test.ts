import { join } from 'node:path';
import { describe, it } from 'vitest';
import { bin, exec, sandbox, tail, textFiles } from './helpers';

const EXAMPLES = ['lib', 'cli', 'web'] as const;
type Example = (typeof EXAMPLES)[number];

// What each example names, as the template's own check (scripts/check-examples.mjs) lists them.
const IDENTIFIERS: Record<Example, string[]> = {
  lib: ['packages/shared', 'packages/lib', '@acme/shared', '@acme/lib'],
  cli: ['packages/cli', '@acme/cli'],
  web: ['packages/web', '@acme/web', 'playwright', 'size-limit', 'axe-core'],
};

// Vitest's optional peer, listed in every lockfile; nothing Playwright is installed.
const LOCKFILE_ALLOWED = '@vitest/browser-playwright';

const LEFTOVERS = ['@monorepo', 'example:', 'template-only'];

// Every non-empty subset of the examples, smallest first.
const ALL = [1, 2, 4, 3, 5, 6, 7].map((mask) =>
  EXAMPLES.filter((_, i) => mask & (1 << i)).join(',')
);

// E2E_SUBSETS="lib,cli,web" (space-separated) runs only those subsets; unset or empty runs all.
const listed = process.env.E2E_SUBSETS?.split(/\s+/).filter(Boolean) ?? [];
const chosen = listed.length > 0 ? listed : ALL;
for (const subset of chosen) {
  if (!ALL.includes(subset)) throw new Error(`E2E_SUBSETS: unknown subset ${subset}`);
}

const TIMEOUT = 20 * 60_000;

/** The problems found in the generated files: template leftovers and an unchosen example's names. */
function strayMentions(project: string, kept: Example[]): string[] {
  const unchosen = EXAMPLES.filter((example) => !kept.includes(example));
  const problems: string[] = [];
  for (let [file, text] of textFiles(project)) {
    for (const leftover of LEFTOVERS) {
      if (text.includes(leftover)) problems.push(`${file}: ${leftover}`);
    }
    if (file === 'pnpm-lock.yaml') text = text.replaceAll(LOCKFILE_ALLOWED, '');
    const lower = text.toLowerCase();
    for (const example of unchosen) {
      for (const id of IDENTIFIERS[example]) {
        if (lower.includes(id.toLowerCase())) problems.push(`${file}: ${id} (${example})`);
      }
    }
  }
  return problems;
}

describe.concurrent('a generated project passes its own CI', () => {
  for (const subset of chosen) {
    it(
      `--examples ${subset}`,
      async ({ expect }) => {
        const kept = subset.split(',') as Example[];
        const box = sandbox(subset.replaceAll(',', '-'));
        let passed = false;
        try {
          const folder = `p-${subset.replaceAll(',', '-')}`;
          const project = join(box.work, folder);
          const created = await exec(
            process.execPath,
            [bin, folder, '--scope', '@acme', '--examples', subset, '-y'],
            { cwd: box.work, env: box.env }
          );
          expect(created.code, tail(created)).toBe(0);

          expect(strayMentions(project, kept)).toEqual([]);

          const git = (args: string[]) => exec('git', args, { cwd: project, env: box.env });
          const log = await git(['log', '--format=%s']);
          expect(log.stdout.trimEnd().split('\n')).toEqual([
            expect.stringMatching(/^chore: initial commit from create-ts-monorepo-starter /),
          ]);

          const pnpm = async (...args: string[]) => {
            const result = await exec('pnpm', args, { cwd: project, env: box.env });
            expect(result.code, `pnpm ${args.join(' ')}\n${tail(result)}`).toBe(0);
          };
          await pnpm('install', '--frozen-lockfile');
          expect((await git(['status', '--porcelain'])).stdout).toBe('');

          for (const script of ['lint', 'check:unused', 'build', 'typecheck', 'test']) {
            await pnpm(script);
          }
          await pnpm('check:packages');
          if (kept.includes('web')) await pnpm('size');
          if (kept.length === EXAMPLES.length) {
            // Playwright is a dependency of packages/web, not of the root.
            await pnpm(
              '--filter',
              '@acme/web',
              'exec',
              'playwright',
              'install',
              '--only-shell',
              'chromium'
            );
            await pnpm('test:browser');
          }
          passed = true;
        } finally {
          box.cleanup(passed);
        }
      },
      TIMEOUT
    );
  }
});
