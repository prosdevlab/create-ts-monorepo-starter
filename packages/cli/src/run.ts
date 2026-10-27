import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { EXAMPLES, type Example, type Options } from './args.js';
import { generate } from './generate.js';
import { initAndCommit, insideGitRepo } from './git.js';
import { assertLockfileSubset } from './lockfile.js';
import { defaultScope, NameError, normalizeScope, packageNameFromFolder } from './names.js';
import { defaultExec, detectPnpm, type Exec, installCommand, type PnpmStatus } from './pnpm.js';
import { cliVersion, pnpmSpec, templateDir, templateLabel } from './template.js';
import { CANCELLED, type Ui } from './ui.js';
import { backUp, moveIntoPlace, onInterrupt, targetState, tempPath } from './workspace.js';

export interface RunPlan {
  target: string;
  folderName: string;
  scope: string;
  keep: Example[];
  git: boolean;
  install: boolean;
  now: Date;
  holder: string;
  /** Move a non-empty target aside (`--force`, or Yes to the prompt) just before the final move. */
  replace?: boolean;
}

/** `failed`: git init or the first commit failed and was reported with `ui.warn` (Ruling 11). */
type GitOutcome = 'committed' | 'no-identity' | 'no-git' | 'inside-repo' | 'off' | 'failed';

export interface RunResult {
  pnpm: PnpmStatus;
  installed: boolean;
  git: GitOutcome;
  packages: string[];
  /** How long the install (or lockfile update) took; 0 when it was skipped. */
  seconds: number;
  /** Where a replaced target was moved. */
  backup?: string;
}

export interface RunDeps {
  exec?: Exec;
  generate?: typeof generate;
  templateDir?: string;
  moveIntoPlace?: typeof moveIntoPlace;
  onInterrupt?: typeof onInterrupt;
}

/** A failure with the output lines that explain it. */
export class RunError extends Error {
  constructor(
    message: string,
    readonly lines: string[] = []
  ) {
    super(message);
    this.name = 'RunError';
  }
}

const PACKAGES: Record<Example, string[]> = { lib: ['lib', 'shared'], cli: ['cli'], web: ['web'] };

const TAIL_LINES = 20;

export function planFromOptions(
  o: Options,
  cwd: string,
  now: Date,
  holder: string | undefined
): RunPlan {
  if (o.folder === undefined) {
    throw new NameError('Pass a folder name, for example: create-ts-monorepo-starter my-tools');
  }
  let scope = defaultScope(o.folder, cwd);
  if (o.scope !== undefined) {
    const normalized = normalizeScope(o.scope);
    if (!normalized.ok) throw new NameError(normalized.message);
    scope = normalized.scope;
  }
  return {
    target: resolve(cwd, o.folder),
    folderName: packageNameFromFolder(o.folder, cwd),
    scope,
    keep: o.examples ?? [...EXAMPLES],
    git: o.git,
    install: o.install,
    now,
    holder: holder ?? '[YOUR NAME]',
  };
}

function lastLines(output: { stdout: string; stderr: string }): string[] {
  const lines = `${output.stdout}\n${output.stderr}`.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-TAIL_LINES);
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** Generates, installs and commits in a temporary folder, then moves it to `plan.target`. */
export async function run(plan: RunPlan, ui: Ui, deps: RunDeps = {}): Promise<RunResult> {
  const exec = deps.exec ?? defaultExec;
  const from = deps.templateDir ?? templateDir();
  const parent = dirname(plan.target);
  const name = basename(plan.target);
  const temp = tempPath(plan.target);
  const unregister = (deps.onInterrupt ?? onInterrupt)(temp, {
    exit: (code) => {
      ui.stop();
      ui.fail(CANCELLED, []);
      process.exit(code);
    },
  });
  try {
    await (deps.generate ?? generate)({
      from,
      to: temp,
      folderName: plan.folderName,
      scope: plan.scope,
      holder: plan.holder,
      year: plan.now.getFullYear(),
      keep: plan.keep,
    });
    const kept = EXAMPLES.filter((example) => plan.keep.includes(example));
    const removed = EXAMPLES.filter((example) => !plan.keep.includes(example));
    const packages = kept.flatMap((example) => PACKAGES[example].map((p) => `${plan.scope}/${p}`));
    const gone = removed.length > 0 ? `; ${removed.join(', ')} removed` : '';
    ui.step(`Created ${name}`, `${packages.join(', ')}${gone}`);

    // git init comes before the install, whose `prepare` script installs the git hooks.
    let git: GitOutcome | 'ready' = 'off';
    if (plan.git) {
      if (await insideGitRepo(parent, exec)) {
        git = 'inside-repo';
        ui.step('Skipped git: the folder is inside a git repository');
      } else {
        const init = await exec('git', ['init', '-q', '-b', 'main'], { cwd: temp });
        if (init.code === 0) git = 'ready';
        else if (init.code === 127) {
          git = 'no-git';
          ui.warn("git isn't installed", ['The project has no git repository.']);
        } else {
          git = 'failed';
          ui.warn("Couldn't initialize git", [(init.stderr || init.stdout).trim()]);
        }
      }
    }

    const pin = pnpmSpec(await readFile(join(from, 'package.json'), 'utf8')).slice('pnpm@'.length);
    const pnpm = await detectPnpm(parent, exec);
    const command = installCommand(pnpm, temp, !plan.install);
    let installed = false;
    let seconds = 0;
    // installCommand is null only for a pnpm too old to use.
    if (!command) {
      ui.fail(`pnpm ${'version' in pnpm ? pnpm.version : ''} is too old for this project`, [
        'It would install with the wrong pnpm and Node, and skip the',
        '3-day release rule. Install skipped.',
      ]);
    } else {
      const what = plan.install ? 'install dependencies' : 'update the lockfile';
      if (pnpm.kind === 'none') {
        const doing = plan.install ? 'Installing' : 'Updating the lockfile';
        ui.warn("pnpm isn't installed", [
          `${doing} with a temporary pnpm ${pin} instead (npm exec).`,
        ]);
      }
      const using = pnpm.kind === 'ok' ? ` with pnpm ${pin}` : '';
      const started = performance.now();
      ui.start(plan.install ? `Installing dependencies${using}` : 'Updating the lockfile');
      let output: Awaited<ReturnType<Exec>>;
      try {
        output = await exec(command.cmd, command.args, { cwd: command.cwd });
      } finally {
        ui.stop();
      }
      seconds = Math.round((performance.now() - started) / 1000);
      if (output.code !== 0) {
        throw new RunError(`Couldn't ${what} (pnpm exited with ${output.code})`, lastLines(output));
      }
      installed = plan.install;
      ui.step(
        plan.install ? `Installed dependencies${using} (${seconds}s)` : 'Updated the lockfile'
      );
    }

    assertLockfileSubset(
      await readFile(join(from, 'pnpm-lock.yaml'), 'utf8'),
      await readFile(join(temp, 'pnpm-lock.yaml'), 'utf8')
    );

    let outcome: GitOutcome = git === 'ready' ? 'failed' : git;
    if (git === 'ready') {
      const message = `chore: initial commit from create-ts-monorepo-starter ${cliVersion()} (template ${templateLabel()})`;
      try {
        outcome = await initAndCommit(temp, message, exec);
      } catch (error) {
        // Ruling 11: the files are generated and correct, so a failed commit only warns.
        outcome = 'failed';
        ui.warn("Couldn't make the first commit", [
          firstLine(error),
          'The repository is initialized: commit the files yourself.',
        ]);
      }
      if (outcome === 'committed') ui.step('Initialized git with a first commit');
      if (outcome === 'no-identity') {
        ui.warn('Initialized git without a commit', [
          'git has no user.name or user.email, so the files are staged but not committed.',
        ]);
      }
    }

    let backup: string | undefined;
    if (plan.replace && (await targetState(plan.target)) === 'not-empty') {
      backup = await backUp(plan.target, plan.now);
      ui.step(`Moved the old ${name} to ${basename(backup)}`);
    }
    try {
      await (deps.moveIntoPlace ?? moveIntoPlace)(temp, plan.target);
    } catch (error) {
      if (!backup) throw error;
      throw new RunError(`Couldn't move the project into place: ${firstLine(error)}`, [
        `The old files are in ${backup}.`,
      ]);
    }
    return {
      pnpm,
      installed,
      git: outcome,
      packages,
      seconds,
      ...(backup && { backup }),
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  } finally {
    unregister();
  }
}
