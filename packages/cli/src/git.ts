import { defaultExec, type Exec } from './pnpm.js';

/** True when `dir` is inside a git work tree. */
export async function insideGitRepo(dir: string, exec: Exec = defaultExec): Promise<boolean> {
  const result = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return result.code === 0 && result.stdout.trim() === 'true';
}

/** The `user.name` and `user.email` git resolves for `dir`; unset keys are left out. */
export async function gitIdentity(
  dir: string = process.cwd(),
  exec: Exec = defaultExec
): Promise<{ name?: string; email?: string }> {
  const read = async (key: string) => {
    const result = await exec('git', ['config', key], { cwd: dir });
    const value = result.code === 0 ? result.stdout.trim() : '';
    return value === '' ? undefined : value;
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return { ...(name && { name }), ...(email && { email }) };
}

/** Inits and stages `dir`; commits only with a configured identity, never inventing one. */
export async function initAndCommit(
  dir: string,
  message: string,
  exec: Exec = defaultExec
): Promise<'committed' | 'no-identity' | 'no-git'> {
  const run = async (args: string[]) => {
    const result = await exec('git', args, { cwd: dir });
    if (result.code === 127) return null;
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  };
  if (!(await run(['init', '-q', '-b', 'main']))) return 'no-git';
  await run(['add', '-A']);
  const { name, email } = await gitIdentity(dir, exec);
  if (!name || !email) return 'no-identity';
  await run(['commit', '-q', '--no-verify', '-m', message]);
  return 'committed';
}
