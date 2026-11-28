import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { EXAMPLES, type Options, parseArgv, wantsJson } from './args.js';
import { writeAll } from './emit.js';
import { gitIdentity } from './git.js';
import { toJson, versionJson } from './json.js';
import { defaultScope, NameError, normalizeScope, packageNameFromFolder } from './names.js';
import { exitCode, FAILURE, type Left, type Outcome, type Problem, TOOLCHAIN } from './outcome.js';
import { checkSwitch, defaultExec, detectPnpm, type Exec, ToolchainError, tooOld } from './pnpm.js';
import { failureFrom, renderText, usageFailure } from './report.js';
import { retryStep } from './retry.js';
import { leftOf, leftoverLine, planFromOptions, type RunDeps, type RunPlan, run } from './run.js';
import { pnpmSpec } from './template.js';
import {
  type Ask,
  CANCELLED,
  clackUi,
  createAsk,
  helpText,
  type Prompts,
  plainUi,
  type Ui,
  versionText,
} from './ui.js';
import {
  backupPath,
  type InterruptDeps,
  onInterrupt,
  onSignals,
  targetState,
} from './workspace.js';

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
  /** Runs commands for `--check` and the git identity; `run` takes its own through `runDeps`. */
  exec?: Exec;
  /** Passed to `run`. */
  runDeps?: RunDeps;
  /** Passed to the command-level interrupt handler (stop, remove, on, exit, ...). */
  interruptDeps?: InterruptDeps;
  /** Writes the `--json` line (the object and its newline) to stdout; by default, synchronously. */
  emit?: (line: string) => void;
  /** Overrides whether stdout is a terminal, for the `--json` hint. */
  stdoutIsTTY?: boolean;
}

/** Shows an outcome: the text on the Ui, and under `--json` the object on stdout. */
function print(outcome: Outcome, ui: Ui, json: boolean, emit: MainIo['emit']): void {
  renderText(outcome, ui);
  if (json) (emit ?? writeAll)(`${JSON.stringify(toJson(outcome))}\n`);
}

export const HINT = 'add --json for machine-readable output';

/**
 * The Ui, with the hint as the first line on stderr the first time it shows anything: only a real
 * run shows something there, so `--help`, `--version` and usage errors never print the hint.
 */
function withHint(ui: Ui): Ui {
  let shown = false;
  const first =
    <A extends unknown[]>(show: (...args: A) => void) =>
    (...args: A) => {
      if (!shown) {
        shown = true;
        process.stderr.write(`${HINT}\n`);
      }
      show(...args);
    };
  return {
    intro: first(() => ui.intro()),
    step: first((done: string, detail?: string) => ui.step(done, detail)),
    start: first((label: string) => ui.start(label)),
    stop: () => ui.stop(),
    warn: first((title: string, lines: string[]) => ui.warn(title, lines)),
    fail: first((title: string, lines: string[]) => ui.fail(title, lines)),
    outro: first((result, plan) => ui.outro(result, plan)),
  };
}

/** `--check`: is this machine's pnpm ready for the template's? Creates nothing. */
async function check(ui: Ui, exec: Exec, onDir: (dir: string) => void): Promise<Outcome> {
  const spec = pnpmSpec();
  ui.intro();
  const pnpm = await detectPnpm(exec);
  if (pnpm.kind === 'none') {
    const pin = spec.slice('pnpm@'.length);
    const warning: Problem = {
      code: 'pnpm-missing',
      title: "pnpm isn't installed",
      lines: [
        `Creating works: the install uses a temporary pnpm ${pin} (npm exec).`,
        'Working in the project needs pnpm 10.26 or newer: https://pnpm.io/installation',
      ],
      fixes: [{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }],
    };
    return { ok: true, kind: 'checked', pnpm, warnings: [warning] };
  }
  if (pnpm.kind === 'old') return { ok: false, error: failureFrom(tooOld(pnpm.version, spec)) };
  try {
    await checkSwitch(spec, pnpm.version, exec, undefined, undefined, onDir);
  } catch (error) {
    if (!(error instanceof ToolchainError)) throw error;
    return { ok: false, error: failureFrom(error) };
  }
  return { ok: true, kind: 'checked', pnpm, warnings: [] };
}

/** The outcome with its retry, when retrying is safe. */
function withRetry(
  outcome: Outcome,
  plan: RunPlan | undefined,
  cwd: string,
  json: boolean
): Outcome {
  const retry = retryStep(outcome, plan, cwd, json);
  return retry && !outcome.ok ? { ...outcome, retry } : outcome;
}

/** An error the command didn't expect, as a failure: it prints `✗ <message>` and exits 1. */
const failed = (error: unknown): Outcome => ({ ok: false, error: failureFrom(error) });

/** `--json` implies `-y`: it never asks. */
const isInteractive = (options: Options, io: MainIo) =>
  !options.yes &&
  !options.json &&
  (io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));

/** Under `--json` all text goes to stderr: stdout carries only the object. */
const stderrUi = () => plainUi({ out: process.stderr, err: process.stderr });

/**
 * The Ui a run shows: `--check` and pipes get plain text, a terminal gets the clack screens, and
 * `--json` gets plain text on stderr.
 */
const chooseUi = (options: Options, io: MainIo): Ui =>
  io.ui ??
  (options.json
    ? stderrUi()
    : !options.check && isInteractive(options, io)
      ? clackUi()
      : plainUi());

const never = new Promise<never>(() => undefined);

/** The command-level interrupt: what `execute` checks, and the exec it runs commands with. */
interface Guard {
  /** Runs a command; once a signal arrives it never settles, so the command can't carry on. */
  exec: Exec;
  /** Records `checkSwitch`'s folder, for the handler to remove. */
  onDir: (dir: string) => void;
  interrupted: () => boolean;
  /** Runs `run()`: its own handler owns a signal until it settles. */
  during: <T>(work: () => Promise<T>) => Promise<T>;
  /** The outcome is final: from now on a signal only keeps its exit code. */
  settle: (outcome: Outcome) => void;
}

/**
 * Handles SIGINT, SIGTERM and SIGHUP for the whole command: `--check`, and everything before and
 * after `run()`. A signal stops pnpm and its children, removes `checkSwitch`'s folder, prints
 * `Cancelled. Nothing was written.` and exits 130. While `run()` runs, its own handler does that
 * and this one does nothing. Once the outcome is final, a signal only sets its exit code, so a
 * Ctrl-C while the output drains can't change how the command ended. The handlers stay registered
 * until the process exits: a signal listener doesn't keep the process alive.
 */
function guard(ui: Ui, io: MainIo, report: (outcome: Outcome) => void): Guard {
  let interrupted = false;
  let running = false;
  let code: number | undefined;
  const dirs: string[] = [];
  const base = io.exec ?? defaultExec;
  const deps = io.interruptDeps ?? {};
  const on = deps.on ?? onSignals;
  const exit = deps.exit ?? ((status: number) => process.exit(status));
  onInterrupt(undefined, {
    ...deps,
    on,
    active: () => !running && code === undefined,
    scratch: () => dirs,
    onStart: () => {
      interrupted = true;
    },
    exit: (status, outcome) => {
      try {
        ui.stop();
        report({
          ok: false,
          error: { code: 'interrupted', title: CANCELLED, lines: [], fixes: [] },
        });
      } catch {
      } finally {
        exit(status, outcome);
      }
    },
  });
  on(() => {
    if (code !== undefined) process.exitCode = code;
  });
  return {
    // Not async: a command that throws synchronously still throws, as it would unwrapped.
    exec: (cmd, args, opts) => {
      if (interrupted) return never;
      return base(cmd, args, opts).then(
        (result) => (interrupted ? never : result),
        (error: unknown) => (interrupted ? never : Promise.reject(error))
      );
    },
    onDir: (dir) => {
      dirs.push(dir);
    },
    interrupted: () => interrupted,
    during: async (work) => {
      if (interrupted) return never;
      running = true;
      try {
        return await work();
      } finally {
        running = false;
      }
    },
    settle: (outcome) => {
      code = exitCode(outcome);
    },
  };
}

/**
 * Runs the command and returns how it ended, without printing the result (progress goes to the Ui).
 * `--help` and `--version` are `main`'s: they print text and aren't an outcome. After a signal the
 * interrupt handler prints and exits, and this never resolves.
 */
export async function execute(argv: string[], io: MainIo = {}): Promise<Outcome> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) return usageFailure(parsed.message);
  const { options } = parsed;
  const ui = chooseUi(options, io);
  const g = guard(ui, io, (outcome) => print(outcome, ui, options.json, io.emit));
  // Invariant: no `await` that waits on I/O between `run()` settling and this point, nor between
  // here and `main` printing. A signal is handled only between event-loop turns, so none can be
  // handled after the outcome is decided and before `settle` makes the handler keep its code.
  const outcome = await command(options, { ...io, ui }, g);
  if (g.interrupted()) return never;
  g.settle(outcome);
  return outcome;
}

async function command(options: Options, io: MainIo & { ui: Ui }, g: Guard): Promise<Outcome> {
  if (options.check) return check(io.ui, g.exec, g.onDir).catch(failed);
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
  let holder: string | undefined;
  try {
    holder = (await gitIdentity(cwd, g.exec)).name;
  } catch (error) {
    return failed(error);
  }

  let plan: RunPlan | undefined;
  if (!interactive) {
    if (options.folder === undefined) {
      return usageFailure('Pass a folder name, for example: create-ts-monorepo-starter my-tools');
    }
    try {
      plan = planFromOptions(options, cwd, now, holder);
    } catch (error) {
      if (error instanceof NameError) return usageFailure(error.message);
      return failed(error);
    }
  }

  const { ui } = io;
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
    const resolved = plan;
    // The interrupt handler prints through this, so an interrupt gets the same retry as a failure.
    const report = (outcome: Outcome): Outcome => {
      let reported = outcome;
      try {
        reported = withRetry(outcome, resolved, cwd, options.json);
      } catch {}
      print(reported, ui, options.json, io.emit);
      return reported;
    };
    const result = await g.during(() => run(resolved, ui, { report, ...io.runDeps }));
    const left: Left = { target: 'complete', ...(result.backup && { backup: result.backup }) };
    return { ok: true, kind: 'created', plan, result, warnings: result.warnings, left };
  } catch (error) {
    const left = leftOf(error);
    const failure = failureFrom(error);
    // The interrupt path says this too; a failure would otherwise leave the folder unmentioned.
    if (left?.temp) failure.lines = [...failure.lines, leftoverLine(left.temp)];
    return withRetry({ ok: false, error: failure, ...(left && { left }) }, plan, cwd, options.json);
  }
}

/** Runs the command, prints how it ended, and resolves with its exit code. */
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const json = wantsJson(argv);
  const emit = io.emit ?? writeAll;
  const parsed = parseArgv(argv);
  // `--help` prints its text even with `--json`: rule 1's one exception.
  if (parsed.ok && parsed.options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (parsed.ok && parsed.options.version) {
    if (json) emit(`${JSON.stringify(versionJson())}\n`);
    else process.stdout.write(`${versionText()}\n`);
    return 0;
  }
  let ui = parsed.ok ? chooseUi(parsed.options, io) : (io.ui ?? (json ? stderrUi() : plainUi()));
  if (!json && !(io.stdoutIsTTY ?? process.stdout.isTTY)) ui = withHint(ui);
  const outcome = await execute(argv, { ...io, ui, emit });
  print(outcome, ui, json, emit);
  return exitCode(outcome);
}
