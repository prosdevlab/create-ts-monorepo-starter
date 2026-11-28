import { rmdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { EXAMPLES, type Example, type Options } from './args.js';
import { generate } from './generate.js';
import { initAndCommit, insideGitRepo } from './git.js';
import { assertLockfileSubset } from './lockfile.js';
import { defaultScope, NameError, normalizeScope, packageNameFromFolder } from './names.js';
import {
  CliError,
  coded,
  type Details,
  type ErrorCode,
  type Fix,
  type Left,
  type Outcome,
  type Problem,
} from './outcome.js';
import {
  checkSwitch,
  defaultExec,
  detectPnpm,
  type Exec,
  installCommand,
  tooOld,
  type UsablePnpm,
} from './pnpm.js';
import { redact } from './redact.js';
import { renderText } from './report.js';
import { cliVersion, pnpmSpec, templateDir, templateLabel } from './template.js';
import { CANCELLED, type Ui } from './ui.js';
import {
  backUp,
  backupPath,
  holdsCwd,
  type InterruptOutcome,
  moveIntoPlace,
  onInterrupt,
  type Probe,
  probePath,
  targetState,
  tempPath,
} from './workspace.js';

export interface RunPlan {
  target: string;
  /** The folder as given. */
  folder?: string;
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

/** `failed`: git init or the first commit failed and was reported with `ui.warn`. */
type GitOutcome = 'committed' | 'no-identity' | 'no-git' | 'inside-repo' | 'off' | 'failed';

export interface RunResult {
  pnpm: UsablePnpm;
  installed: boolean;
  git: GitOutcome;
  packages: string[];
  /** How long the install took; 0 with `--no-install` (the lockfile update isn't counted). */
  seconds: number;
  /** What `run()` warned about, in order; each was also shown with `ui.warn`. */
  warnings: Problem[];
  /** Where a replaced target was moved. */
  backup?: string;
}

export interface RunDeps {
  exec?: Exec;
  generate?: typeof generate;
  templateDir?: string;
  moveIntoPlace?: typeof moveIntoPlace;
  backUp?: typeof backUp;
  rm?: typeof rm;
  onInterrupt?: typeof onInterrupt;
  /** The folder the user's shell stands in; a backup never renames it. */
  cwd?: string;
  /** A synchronous read of one path; `leftBehind` reads the disk through it. */
  probe?: (path: string) => Probe;
  /** Called with the interrupted outcome, after its message is printed and before the process exits. */
  onOutcome?: (outcome: Outcome) => void;
}

/** A failure with the output lines that explain it. */
class RunError extends CliError {
  constructor(code: ErrorCode, message: string, lines: string[] = [], details: Details = {}) {
    super(code, message, lines, details);
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
    folder: o.folder,
    folderName: packageNameFromFolder(o.folder, cwd),
    scope,
    keep: o.examples ?? [...EXAMPLES],
    git: o.git,
    install: o.install,
    now,
    holder: holder ?? '[YOUR NAME]',
  };
}

/** The last lines of a command's output, credentials removed. */
function lastLines(output: { stdout: string; stderr: string }): string[] {
  const lines = `${output.stdout}\n${output.stderr}`.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-TAIL_LINES).map(redact);
}

type Phase =
  | { at: 'working' }
  | { at: 'moved'; backup?: string }
  | { at: 'backing-up'; inPlace: boolean; backup?: string }
  | { at: 'backed-up'; backup: string }
  | { at: 'moving'; backup?: string };

/** What a failure or a Ctrl-C says about a temporary folder it couldn't delete. */
export const leftoverLine = (temp: string) =>
  `Couldn't delete the temporary folder ${temp}: delete it yourself.`;

/** The line a Ctrl-C prints: "nothing was written" holds only until the backup starts. */
function cancelMessage(
  phase: Phase,
  plan: RunPlan,
  temp: string,
  outcome: InterruptOutcome
): [string, string[]] {
  const { target } = plan;
  const leftover = [
    ...(outcome.removed ? [] : [leftoverLine(temp)]),
    ...(outcome.stopped ? [] : ['pnpm may still be running in it.']),
  ];
  switch (phase.at) {
    case 'working':
      return outcome.removed ? [CANCELLED, leftover] : ['Cancelled.', leftover];
    case 'backing-up': {
      const backup = basename(phase.backup ?? backupPath(target, plan.now));
      const where = phase.inPlace
        ? `Your files are in ${target}, in ${backup} beside it, or split between the two.`
        : `Your files are in ${target}, or in ${backup} beside it.`;
      return [`Cancelled. ${where}`, leftover];
    }
    case 'backed-up':
      return [`Cancelled. Your files are in ${phase.backup}.`, leftover];
    case 'moving': {
      const partial = `The new project in ${target} may be incomplete.`;
      if (phase.backup)
        return [`Cancelled. Your files are in ${phase.backup}.`, [partial, ...leftover]];
      return ['Cancelled while moving the project into place.', [partial, ...leftover]];
    }
    case 'moved':
      return [`Cancelled after the project was created in ${target}.`, leftover];
  }
}

type State = 'missing' | 'empty' | 'not-empty';

/**
 * What the run left behind, from the phase it was in and a synchronous read of the disk. Before
 * `onPath` has fired the phase has no backup path, so no backup is claimed.
 */
export function leftBehind(
  phase: Phase,
  before: State | undefined,
  read: (path: string) => Probe,
  target: string
): Left {
  const unknown = (backup?: string): Left => {
    const found = backup && read(backup) === 'not-empty' ? backup : undefined;
    return { target: 'unknown', ...(found && { backup: found }) };
  };
  if (phase.at === 'working') {
    if (before === undefined) return { target: 'unknown' };
    return { target: before === 'not-empty' ? 'unchanged' : before };
  }
  if (phase.at === 'moved')
    return { target: 'complete', ...(phase.backup && { backup: phase.backup }) };
  const backup = phase.backup;
  if (phase.at === 'backing-up' && !backup) return { target: 'unchanged' };
  const now = read(target);
  if (now === 'unreadable') return unknown(backup);
  if (phase.at === 'moving') {
    // backUp has returned, so the files are there unless the disk says the folder is gone or empty.
    const kept = backup ? read(backup) : 'missing';
    const where = backup && kept !== 'missing' && kept !== 'empty' ? { backup } : {};
    if (now === 'missing' || now === 'empty') return { target: now, ...where };
    if (before === undefined) return { target: 'unknown', ...where };
    if (before === 'missing' || before === 'empty' || backup)
      return { target: 'partial', ...where };
    return { target: 'unchanged' };
  }
  const moved = read(backup as string);
  if (moved === 'unreadable') return unknown(backup);
  if (now === 'not-empty') {
    return moved === 'not-empty' ? { target: 'split', backup } : { target: 'unchanged' };
  }
  return moved === 'not-empty' ? { target: now, backup } : unknown();
}

const recorded = new WeakMap<object, Left>();

/** The `left` that `run()` recorded for an error it threw, if any. */
export function leftOf(error: unknown): Left | undefined {
  return typeof error === 'object' && error !== null ? recorded.get(error) : undefined;
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** Generates, installs and commits in a temporary folder, then moves it to `plan.target`. */
export async function run(plan: RunPlan, ui: Ui, deps: RunDeps = {}): Promise<RunResult> {
  const baseExec = deps.exec ?? defaultExec;
  // Once a signal arrives, the interrupt handler owns the exit: commands it stops never return.
  let interrupted = false;
  const never = new Promise<never>(() => undefined);
  const exec: Exec = async (cmd, args, opts) => {
    if (interrupted) return never;
    const result = await baseExec(cmd, args, opts);
    return interrupted ? never : result;
  };
  const from = deps.templateDir ?? templateDir();
  const parent = dirname(plan.target);
  const name = basename(plan.target);
  const temp = tempPath(plan.target);
  // What a Ctrl-C has to report changes once the user's folder is moved aside or ours moves in.
  let phase: Phase = { at: 'working' };
  let before: State | undefined;
  const probe = deps.probe ?? probePath;
  const warnings: Problem[] = [];
  /** Shows a warning and records it for the result. Lines can quote git or pnpm, so they're redacted. */
  const warn = (code: string, title: string, lines: string[], fixes: Fix[] = []) => {
    const shown = lines.map(redact);
    warnings.push({ code, title, lines: shown, fixes });
    ui.warn(title, shown);
  };
  const unregister = (deps.onInterrupt ?? onInterrupt)(temp, {
    onStart: () => {
      interrupted = true;
    },
    exit: (code, outcome) => {
      try {
        ui.stop();
        const facts = {
          ...(outcome.removed ? {} : { temp }),
          ...(outcome.stopped ? {} : { running: true as const }),
        };
        let left: Left;
        try {
          left = { ...leftBehind(phase, before, probe, plan.target), ...facts };
        } catch {
          left = { target: 'unknown', ...facts };
        }
        const [title, lines] = cancelMessage(phase, plan, temp, outcome);
        const interrupted: Outcome = {
          ok: false,
          error: { code: 'interrupted', title, lines, fixes: [] },
          left,
        };
        renderText(interrupted, ui);
        try {
          deps.onOutcome?.(interrupted);
        } catch {}
        // Only an empty folder this run created: rmdir can't remove one with files in it.
        try {
          if (phase.at === 'backing-up' && phase.inPlace && phase.backup) {
            if (probe(phase.backup) === 'empty') rmdirSync(phase.backup);
          }
        } catch {}
      } finally {
        process.exit(code);
      }
    },
  });
  try {
    before = await targetState(plan.target).catch(() => undefined);
    // pnpm first: a pnpm that can't switch to the template's version stops the run before any file.
    const spec = pnpmSpec(await readFile(join(from, 'package.json'), 'utf8'));
    const pin = spec.slice('pnpm@'.length);
    const pnpm = await detectPnpm(exec);
    if (pnpm.kind === 'old') throw tooOld(pnpm.version, spec);
    if (pnpm.kind === 'ok') await checkSwitch(spec, pnpm.version, exec);

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
          warn('git-missing', "git isn't installed", ['The project has no git repository.']);
        } else {
          git = 'failed';
          warn('git-failed', "Couldn't initialize git", [(init.stderr || init.stdout).trim()]);
        }
      }
    }

    const command = installCommand(pnpm, temp, !plan.install);
    const what = plan.install ? 'install dependencies' : 'update the lockfile';
    if (pnpm.kind === 'none') {
      const doing = plan.install ? 'Installing' : 'Updating the lockfile';
      warn(
        'pnpm-missing',
        "pnpm isn't installed",
        [`${doing} with a temporary pnpm ${pin} instead (npm exec).`],
        [{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }]
      );
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
    const seconds = Math.round((performance.now() - started) / 1000);
    if (output.code !== 0) {
      const tail = lastLines(output);
      throw new RunError(
        'install-failed',
        `Couldn't ${what} (pnpm exited with ${output.code})`,
        tail,
        { output: tail }
      );
    }
    const installed = plan.install;
    ui.step(plan.install ? `Installed dependencies${using} (${seconds}s)` : 'Updated the lockfile');

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
        // The files are generated and correct, so a failed commit only warns.
        outcome = 'failed';
        warn('commit-failed', "Couldn't make the first commit", [
          firstLine(error),
          'The repository is initialized: commit the files yourself.',
        ]);
      }
      if (outcome === 'committed') ui.step('Initialized git with a first commit');
      if (outcome === 'no-identity') {
        warn('git-no-identity', 'Initialized git without a commit', [
          'git has no user.name or user.email, so the files are staged but not committed.',
        ]);
      }
    }

    let backup: string | undefined;
    if (plan.replace && (await targetState(plan.target)) === 'not-empty') {
      const cwd = deps.cwd ?? process.cwd();
      const inPlace = await holdsCwd(plan.target, cwd);
      phase = { at: 'backing-up', inPlace, backup: undefined };
      const onPath = (path: string) => {
        phase = { at: 'backing-up', inPlace, backup: path };
      };
      try {
        backup = await (deps.backUp ?? backUp)(plan.target, plan.now, { cwd, onPath });
      } catch (error) {
        throw coded('backup-failed', error);
      }
      phase = { at: 'backed-up', backup };
      ui.step(`Moved the old ${name} to ${basename(backup)}`);
    }
    try {
      phase = { at: 'moving', ...(backup && { backup }) };
      await (deps.moveIntoPlace ?? moveIntoPlace)(temp, plan.target);
      phase = { at: 'moved', ...(backup && { backup }) };
    } catch (error) {
      if (!backup) throw coded('move-failed', error);
      throw new RunError(
        'move-failed',
        `Couldn't move the project into place: ${firstLine(error)}`,
        [`The old files are in ${backup}.`]
      );
    }
    return {
      pnpm,
      installed,
      git: outcome,
      packages,
      seconds: plan.install ? seconds : 0,
      warnings,
      ...(backup && { backup }),
    };
  } catch (error) {
    let left: Left;
    try {
      left = leftBehind(phase, before, probe, plan.target);
    } catch {
      left = { target: 'unknown' };
    }
    try {
      await (deps.rm ?? rm)(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // The run's own error is the one to show; `left.temp` says what stayed behind.
    }
    try {
      if (probe(temp) !== 'missing') left = { ...left, temp };
    } catch {
      left = { ...left, temp };
    }
    if (typeof error === 'object' && error !== null) recorded.set(error, left);
    throw error;
  } finally {
    unregister();
  }
}
