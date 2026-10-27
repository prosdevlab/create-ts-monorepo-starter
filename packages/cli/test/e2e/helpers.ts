import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The built command, as npm would install it. Run `pnpm build` first.
export const bin = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Variables the test runner and the outer pnpm set, which a fresh shell wouldn't have. */
const INHERITED =
  /^(npm_|pnpm_script_|vitest|init_cwd$|git_(dir|work_tree|index_file|config_)|force_color$)/i;

export interface Sandbox {
  /** An empty folder outside any git repository, to run the CLI in. */
  work: string;
  env: NodeJS.ProcessEnv;
  /** Deletes everything, unless E2E_KEEP=1 and the test didn't pass: then prints where it is. */
  cleanup(passed: boolean): void;
}

/** A temp folder and an environment with its own git identity, so the developer's config can't leak in. */
export function sandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `ctms-e2e-${prefix}-`));
  const work = join(root, 'work');
  mkdirSync(work);
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = E2E\n\temail = e2e@example.com\n');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED.test(key)) env[key] = value;
  }
  if (env.NODE_ENV === 'test') delete env.NODE_ENV;
  // CI=true everywhere, as in GitHub Actions: pnpm then defaults to a frozen lockfile.
  Object.assign(env, { CI: 'true', GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' });
  env.NO_COLOR = '1';
  return {
    work,
    env,
    cleanup(passed) {
      if (!passed && process.env.E2E_KEEP === '1') {
        process.stderr.write(`E2E_KEEP: kept ${root}\n`);
        return;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Runs a command to completion. Windows runs pnpm through its .cmd shim, so it needs a shell. */
export function exec(
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<Result> {
  const shell = process.platform === 'win32' && cmd !== process.execPath;
  // Shell arguments here are plain words (no spaces or quotes), so joining them is safe.
  const child = shell
    ? spawn([cmd, ...args].join(' '), { ...options, shell: true })
    : spawn(cmd, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The command's last lines, for a failure message. */
export function tail(result: Result, lines = 40): string {
  return `${result.stdout}\n${result.stderr}`.trimEnd().split('\n').slice(-lines).join('\n');
}

/** Every text file under `dir` by its `/` path, leaving out `.git` and `node_modules`. */
export function textFiles(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      for (const [file, text] of textFiles(dir, path)) files.set(file, text);
      continue;
    }
    const buffer = readFileSync(join(dir, path));
    if (!buffer.includes(0)) files.set(path, buffer.toString('utf8'));
  }
  return files;
}
