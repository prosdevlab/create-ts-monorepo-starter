import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { EXAMPLES, type Options, parseArgv } from './args.js';
import { gitIdentity } from './git.js';
import { defaultScope, NameError, normalizeScope, packageNameFromFolder } from './names.js';
import { exitCode, FAILURE, type Left, type Outcome, TOOLCHAIN } from './outcome.js';
import { checkSwitch, detectPnpm, type Exec, ToolchainError, tooOld } from './pnpm.js';
import { failureFrom, renderText, usageFailure } from './report.js';
import { leftOf, planFromOptions, type RunDeps, type RunPlan, run } from './run.js';
import { pnpmSpec } from './template.js';
import {
  type Ask,
  CANCELLED,
  CancelledError,
  clackUi,
  createAsk,
  helpText,
  type Prompts,
  plainUi,
  type Ui,
  versionText,
} from './ui.js';
import { backupPath, targetState } from './workspace.js';

export { FAILURE, TOOLCHAIN };

const nameProblem = (folder: string, cwd?: string) => {
  try {
    packageNameFromFolder(folder, cwd);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

const scopeProblem = (scope: string) => {
  const normalized = normalizeScope(scope);
  return normalized.ok ? undefined : normalized.message;
};

async function fileCount(target: string): Promise<number> {
  return (await readdir(target).catch(() => [''])).length;
}

function summary(options: Options): string {
  const examples = options.examples ?? [...EXAMPLES];
  const named =
    examples.length === 1
      ? examples[0]
      : `${examples.slice(0, -1).join(', ')} and ${examples.at(-1)}`;
  const steps = [options.git && 'git', options.install && 'install'].filter(Boolean);
  return [`${named} ${examples.length === 1 ? 'example' : 'examples'}`, ...steps].join(', ');
}

/** Asks for the folder (again, if a non-empty one isn't to be replaced), then the setup. */
async function askPlan(
  ask: Ask,
  cwd: string,
  options: Options,
  now: Date,
  holder: string | undefined
): Promise<RunPlan> {
  let folder = options.folder;
  let replace = false;
  for (;;) {
    folder ??= await ask.folder(nameProblem);
    const target = planFromOptions({ ...options, folder }, cwd, now, holder).target;
    if ((await targetState(target)) !== 'not-empty') break;
    const backupName = basename(backupPath(target, now));
    if (options.force || (await ask.replace(folder, await fileCount(target), backupName))) {
      replace = true;
      break;
    }
    folder = undefined;
  }
  const answers: Options = { ...options, folder };
  if (!(await ask.recommended(summary(options)))) {
    const scope = await ask.scope(options.scope ?? defaultScope(folder, cwd), scopeProblem);
    answers.scope = scope;
    const normalized = normalizeScope(scope);
    const shown = normalized.ok ? normalized.scope : scope;
    answers.examples = await ask.examples(shown, options.examples ?? [...EXAMPLES]);
    answers.git = await ask.git(options.git);
    answers.install = await ask.install(options.install);
  }
  return { ...planFromOptions(answers, cwd, now, holder), replace };
}

/** What a test can swap; each defaults to the real terminal and folder. */
export interface MainIo {
  cwd?: string;
  /** Overrides the terminal check (stdin and stdout are TTYs, and no `-y`). */
  interactive?: boolean;
  ui?: Ui;
  prompts?: Prompts;
  /** Runs commands for `--check`. */
  exec?: Exec;
  /** Passed to `run`. */
  runDeps?: RunDeps;
}

/** `--check`: is this machine's pnpm ready for the template's? Creates nothing. */
async function check(ui: Ui, exec: Exec | undefined): Promise<Outcome> {
  const spec = pnpmSpec();
  ui.intro();
  const pnpm = await detectPnpm(exec);
  if (pnpm.kind === 'none') return { ok: true, kind: 'checked', pnpm, warnings: [] };
  if (pnpm.kind === 'old') return { ok: false, error: failureFrom(tooOld(pnpm.version, spec)) };
  try {
    await checkSwitch(spec, pnpm.version, exec);
  } catch (error) {
    if (!(error instanceof ToolchainError)) throw error;
    return { ok: false, error: failureFrom(error) };
  }
  return { ok: true, kind: 'checked', pnpm, warnings: [] };
}

const isInteractive = (options: Options, io: MainIo) =>
  !options.yes && (io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));

/** The Ui a run shows: `--check` and pipes get plain text, a terminal gets the clack screens. */
const chooseUi = (options: Options, io: MainIo): Ui =>
  io.ui ?? (!options.check && isInteractive(options, io) ? clackUi() : plainUi());

/**
 * Runs the command and returns how it ended, without printing the result (progress goes to the Ui).
 * `--help` and `--version` are `main`'s: they print text and aren't an outcome.
 */
export async function execute(argv: string[], io: MainIo = {}): Promise<Outcome> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) return usageFailure(parsed.message);
  const { options } = parsed;
  if (options.check) return check(chooseUi(options, io), io.exec);
  const cwd = io.cwd ?? process.cwd();
  const interactive = isInteractive(options, io);
  // A bad flag fails at once, before any question.
  if (interactive) {
    const problem =
      (options.folder !== undefined ? nameProblem(options.folder, cwd) : undefined) ??
      (options.scope !== undefined ? scopeProblem(options.scope) : undefined);
    if (problem) return usageFailure(problem);
  }
  const now = new Date();
  const holder = (await gitIdentity(cwd)).name;

  let plan: RunPlan | undefined;
  if (!interactive) {
    if (options.folder === undefined) {
      return usageFailure('Pass a folder name, for example: create-ts-monorepo-starter my-tools');
    }
    try {
      plan = planFromOptions(options, cwd, now, holder);
    } catch (error) {
      if (error instanceof NameError) return usageFailure(error.message);
      throw error;
    }
  }

  const ui = chooseUi(options, io);
  ui.intro();
  try {
    if (plan && (await targetState(plan.target)) === 'not-empty') {
      if (!options.force) {
        const title = `${options.folder} isn't empty. Use another folder, or pass --force to move it aside.`;
        return { ok: false, error: { code: 'target-not-empty', title, lines: [], fixes: [] } };
      }
      plan.replace = true;
    }
    plan ??= await askPlan(createAsk(io.prompts), cwd, options, now, holder);
    const result = await run(plan, ui, io.runDeps);
    const left: Left = { target: 'complete', ...(result.backup && { backup: result.backup }) };
    return { ok: true, kind: 'created', plan, result, warnings: [], left };
  } catch (error) {
    const left = leftOf(error);
    return { ok: false, error: failureFrom(error), ...(left && { left }) };
  }
}

/** Runs the command, prints how it ended, and resolves with its exit code. */
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.ok && parsed.options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (parsed.ok && parsed.options.version) {
    process.stdout.write(`${versionText()}\n`);
    return 0;
  }
  const ui = parsed.ok ? chooseUi(parsed.options, io) : (io.ui ?? plainUi());
  const outcome = await execute(argv, { ...io, ui });
  renderText(outcome, ui);
  return exitCode(outcome);
}
