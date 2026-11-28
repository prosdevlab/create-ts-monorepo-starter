import type { ErrorCode, Outcome, Step } from './outcome.js';
import type { RunPlan } from './run.js';

/** Failures a second run can fix: the person fixed pnpm, the network came back, or they stopped it. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'pnpm-too-old',
  'pnpm-switch-failed',
  'install-failed',
  'interrupted',
]);

/**
 * The command that runs this again, only when that's safe: the failure is one a retry can fix, and
 * the disk shows nothing changed (the target as it was, no backup, no leftover folder, no pnpm
 * still running). The arguments are rebuilt from the resolved plan, never copied from argv, so a
 * prompt's answers become flags and `--force` stays only while the folder still has files.
 */
export function retryStep(
  outcome: Outcome,
  plan: RunPlan | undefined,
  cwd: string,
  json = false
): Step | undefined {
  if (outcome.ok || !plan || !RETRYABLE.has(outcome.error.code)) return undefined;
  const { left } = outcome;
  if (!left || left.backup || left.temp || left.running) return undefined;
  if (left.target !== 'missing' && left.target !== 'empty' && left.target !== 'unchanged') {
    return undefined;
  }
  const argv = [
    '-y',
    '--scope',
    plan.scope,
    '--examples',
    plan.keep.join(','),
    ...(plan.git ? [] : ['--no-git']),
    ...(plan.install ? [] : ['--no-install']),
    ...(json ? ['--json'] : []),
    // `unchanged` is a target that had files: it still needs moving aside.
    ...(plan.replace && left.target === 'unchanged' ? ['--force'] : []),
    '--',
    plan.folder ?? plan.target,
  ];
  return { argv, cwd };
}
