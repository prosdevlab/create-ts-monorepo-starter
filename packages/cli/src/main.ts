import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { EXAMPLES, type Options, parseArgv } from './args.js';
import { gitIdentity } from './git.js';
import { defaultScope, NameError, normalizeScope, packageNameFromFolder } from './names.js';
import { planFromOptions, RunError, type RunPlan, run } from './run.js';
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

const USAGE = 2;
export const FAILURE = 1;
const INTERRUPTED = 130;

const usage = (message: string) => {
  process.stderr.write(`${message}\n`);
  return USAGE;
};

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

function report(ui: Ui, error: unknown): number {
  if (error instanceof CancelledError) {
    ui.fail(CANCELLED, []);
    return INTERRUPTED;
  }
  if (error instanceof RunError) {
    ui.fail(error.message, error.lines);
    return FAILURE;
  }
  const [title = 'Something went wrong', ...lines] = String(
    error instanceof Error ? error.message : error
  ).split('\n');
  ui.fail(title, lines);
  return FAILURE;
}

/** What a test can swap; each defaults to the real terminal and folder. */
export interface MainIo {
  cwd?: string;
  /** Overrides the terminal check (stdin and stdout are TTYs, and no `-y`). */
  interactive?: boolean;
  ui?: Ui;
  prompts?: Prompts;
}

/** Runs the command and resolves with its exit code. */
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) return usage(parsed.message);
  const { options } = parsed;
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${versionText()}\n`);
    return 0;
  }
  const cwd = io.cwd ?? process.cwd();
  const interactive =
    !options.yes && (io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  // A bad flag fails at once, before any question.
  if (interactive) {
    const problem =
      (options.folder !== undefined ? nameProblem(options.folder, cwd) : undefined) ??
      (options.scope !== undefined ? scopeProblem(options.scope) : undefined);
    if (problem) return usage(problem);
  }
  const now = new Date();
  const holder = (await gitIdentity(cwd)).name;

  let plan: RunPlan | undefined;
  if (!interactive) {
    if (options.folder === undefined) {
      return usage('Pass a folder name, for example: create-ts-monorepo-starter my-tools');
    }
    try {
      plan = planFromOptions(options, cwd, now, holder);
    } catch (error) {
      if (error instanceof NameError) return usage(error.message);
      throw error;
    }
  }

  const ui = io.ui ?? (interactive ? clackUi() : plainUi());
  ui.intro();
  try {
    if (plan && (await targetState(plan.target)) === 'not-empty') {
      if (!options.force) {
        const message = `${options.folder} isn't empty. Use another folder, or pass --force to move it aside.`;
        ui.fail(message, []);
        return FAILURE;
      }
      plan.replace = true;
    }
    plan ??= await askPlan(createAsk(io.prompts), cwd, options, now, holder);
    const result = await run(plan, ui);
    ui.outro(result, plan);
    return 0;
  } catch (error) {
    if (error instanceof NameError) return usage(error.message);
    return report(ui, error);
  }
}
