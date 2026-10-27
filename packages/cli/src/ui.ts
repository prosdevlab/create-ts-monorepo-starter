import { isAbsolute, relative, sep } from 'node:path';
import { styleText } from 'node:util';
import * as p from '@clack/prompts';
import { EXAMPLES, type Example } from './args.js';
import type { RunPlan, RunResult } from './run.js';
import { cliVersion, pnpmSpec, templateLabel } from './template.js';

export interface Ui {
  intro(): void;
  step(done: string, detail?: string): void;
  /** Shows a step that is still running (the install) until `stop`. */
  start(label: string): void;
  stop(): void;
  warn(title: string, lines: string[]): void;
  fail(title: string, lines: string[]): void;
  outro(result: RunResult, plan: RunPlan): void;
}

export const CANCELLED = 'Cancelled. Nothing was written.';

const NAME = 'create-ts-monorepo-starter';

const CHECKLIST: [item: string, section: string][] = [
  ['Previews on every PR: install the pkg.pr.new app, set PKG_PR_NEW', 'Preview Packages'],
  [
    'Private vulnerability reporting: Settings → Advanced Security',
    'Issues, Pull Requests and Security Reports',
  ],
  [
    'Publish to npm: add a repository field to each package, a trusted publisher for ci.yml, set NPM_PUBLISH',
    'Setting Up npm Publishing',
  ],
];

export function versionText(): string {
  return `${NAME} ${cliVersion()} · template ${templateLabel()}`;
}

export function helpText(): string {
  return `${versionText()}
Create a TypeScript monorepo for CLIs, libraries and browser libraries.

Usage
  pnpm create ts-monorepo-starter [folder] [options]

Options
  --scope <@name>     npm scope for the packages   default: @<folder>
  --examples <list>   lib, cli, web, comma-separated default: all three
  --no-git            don't initialize git
  --no-install        don't install dependencies
  --force             move a non-empty folder aside first
  -y, --yes           accept every default, ask nothing
  -h, --help          show this help
  -v, --version       show the CLI and template versions

Examples
  pnpm create ts-monorepo-starter my-tools
  pnpm create ts-monorepo-starter my-tools -y
  npm create ts-monorepo-starter@latest my-tools -- --examples lib,cli

npm needs -- before the options. Docs: README of the generated project.`;
}

/**
 * The folder as `cd` wants it from here, or null when it is the current folder. After a backup it
 * is never null, and outside the current folder it is absolute: the shell's view may be stale.
 */
function cdPath(target: string, backedUp: boolean): string | null {
  const rel = relative(process.cwd(), target);
  if (rel === '' && !backedUp) return null;
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return shellQuote(target);
  // `cd -x` would read the folder as an option.
  return shellQuote(rel.startsWith('-') ? `.${sep}${rel}` : rel);
}

/** Quotes a path for the user's shell unless it is only safe characters. */
export function shellQuote(path: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === 'win32';
  if ((windows ? /^[\w./\\:-]+$/ : /^[\w./-]+$/).test(path)) return path;
  return windows ? `"${path}"` : `'${path.replaceAll("'", "'\\''")}'`;
}

/** What the final message says, shared by both looks. */
function closing(result: RunResult, plan: RunPlan) {
  const pin = pnpmSpec().slice('pnpm@'.length);
  let title = 'Ready.';
  let commands: string[] = [];
  let notes: string[] = [];
  if (result.pnpm.kind === 'old') {
    title = 'Upgrade pnpm, then install:';
    commands = ['npm install -g pnpm'];
    notes = [`Any pnpm from 10.26 on switches itself to ${pin} for this project.`];
  } else if (result.pnpm.kind === 'none') {
    title = 'One step left before your first commit:';
    commands = ['npm install -g pnpm'];
    notes = [
      `The git hooks run pnpm. Any pnpm from 10.26 on switches itself to ${pin.split('.')[0]}.`,
    ];
  }
  const extra =
    !result.installed && result.pnpm.kind !== 'old'
      ? ["Dependencies aren't installed: the first pnpm install installs them and the git hooks."]
      : [];
  const dir = cdPath(plan.target, result.backup !== undefined);
  const next = [
    ...(dir ? [`cd ${dir}`] : []),
    ...(result.installed ? [] : ['pnpm install']),
    'pnpm build && pnpm test',
  ];
  return { title, commands, notes, extra, next };
}

type Stream = NodeJS.WritableStream;

function painter(stream: Stream) {
  return (format: Parameters<typeof styleText>[0], text: string) =>
    styleText(format, text, { stream });
}

/** One line per step, no prompts: for `-y`, CI, scripts and agents. */
export function plainUi(
  io: { out: Stream; err: Stream } = { out: process.stdout, err: process.stderr }
): Ui {
  const out = (line: string) => io.out.write(`${line}\n`);
  const err = (line: string) => io.err.write(`${line}\n`);
  const o = painter(io.out);
  const e = painter(io.err);
  return {
    intro() {
      out(`${o('bold', NAME)} ${o('dim', `${cliVersion()} · template ${templateLabel()}`)}`);
    },
    step(done, detail) {
      out(`${o('green', '✓')} ${done}${detail ? ` ${o('dim', `(${detail})`)}` : ''}`);
    },
    start(label) {
      out(`${label}…`);
    },
    stop() {},
    warn(title, lines) {
      err(`${e('yellow', '!')} ${title}`);
      for (const line of lines) err(`  ${line}`);
    },
    fail(title, lines) {
      err(`${e('red', '✗')} ${title}`);
      for (const line of lines) err(`  ${line}`);
    },
    outro(result, plan) {
      const { title, commands, notes, extra, next } = closing(result, plan);
      out('');
      if (title !== 'Ready.') {
        out(o('bold', title));
        for (const command of commands) out(`  ${o('cyan', command)}`);
        for (const note of notes) out(`  ${note}`);
        out('');
      }
      for (const line of extra) out(line);
      if (extra.length > 0) out('');
      out(`Next: ${o('cyan', next.join(' && '))}`);
      out('');
      out('When you want them (README section in brackets):');
      for (const [item, section] of CHECKLIST) out(`  • ${item} ${o('dim', `[${section}]`)}`);
    },
  };
}

const FRAMES = ['◒', '◐', '◓', '◑'];

/** The screens' look. The spinner is our own: clack's puts stdin in raw mode, turning Ctrl-C into exit 0. */
export function clackUi(): Ui {
  const o = painter(process.stdout);
  let timer: NodeJS.Timeout | undefined;
  return {
    intro() {
      p.intro(`${o('bold', NAME)} ${o('dim', `${cliVersion()} · template ${templateLabel()}`)}`);
    },
    step(done, detail) {
      p.log.step(detail ? `${done}\n${o('dim', detail)}` : done);
    },
    start(label) {
      let frame = 0;
      const draw = () => {
        const symbol = o('magenta', FRAMES[frame++ % FRAMES.length] ?? '');
        process.stdout.write(`\r\x1b[2K${symbol}  ${label}…`);
      };
      process.stdout.write(`${o('gray', '│')}\n`);
      draw();
      timer = setInterval(draw, 120);
      timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      // Clear the spinner line and the guide line above it.
      process.stdout.write('\r\x1b[2K\x1b[1A\x1b[2K');
    },
    warn(title, lines) {
      p.log.warn([title, ...lines.map((line) => o('dim', line))].join('\n'));
    },
    fail(title, lines) {
      const e = painter(process.stderr);
      const text = [e('bold', title), ...lines.map((line) => e('dim', line))].join('\n');
      p.log.error(text, { output: process.stderr });
    },
    outro(result, plan) {
      const { title, commands, notes, extra, next } = closing(result, plan);
      const ready = title === 'Ready.';
      p.outro(o(ready ? ['green', 'bold'] : ['yellow', 'bold'], title));
      const lines: string[] = [];
      if (!ready) {
        lines.push(...commands.map((command) => `     ${o('cyan', command)}`), '');
        lines.push(...notes.map((note) => `   ${o('dim', note)}`), '');
      }
      if (extra.length > 0) lines.push(...extra.map((line) => `   ${line}`), '');
      lines.push(`   ${o('bold', 'Next')}`, ...next.map((line) => `     ${o('cyan', line)}`), '');
      lines.push(
        `   ${o('bold', 'When you want them')} ${o('dim', '(README section in brackets)')}`
      );
      for (const [item, section] of CHECKLIST) {
        lines.push(`     ${o('gray', '•')} ${item}`, `       ${o('dim', `[${section}]`)}`);
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    },
  };
}

/** Thrown when someone cancels a prompt (Ctrl-C or Escape). */
export class CancelledError extends Error {
  override name = 'CancelledError';
}

function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new CancelledError(CANCELLED);
  return value as Exclude<T, symbol>;
}

const EXAMPLE_HINTS = (scope: string): Record<Example, string> => ({
  lib: `a library other tools import: MCP servers, scripts, SDKs · ${scope}/lib, built on ${scope}/shared`,
  cli: 'a command people run',
  web: 'a library loaded in web pages by a script tag · browser tests, accessibility checks, a size budget',
});

/** The clack prompts the questions use; tests pass fakes. */
export type Prompts = Pick<typeof p, 'text' | 'confirm' | 'multiselect'>;

/** The questions, asked only when stdin and stdout are terminals and `-y` isn't set. */
export function createAsk(prompts: Prompts = p) {
  return {
    folder: async (validate: (value: string) => string | undefined) =>
      answer(
        await prompts.text({
          message: 'Project folder',
          placeholder: 'my-ts-monorepo',
          defaultValue: 'my-ts-monorepo',
          validate: (value) => validate(value || 'my-ts-monorepo'),
        })
      ),
    recommended: async (summary: string) =>
      answer(
        await prompts.confirm({
          message: 'Use the recommended setup?',
          active: `Yes · ${summary}`,
          inactive: 'No',
          initialValue: true,
        })
      ),
    scope: async (initial: string, validate: (value: string) => string | undefined) =>
      answer(
        await prompts.text({
          message: 'npm scope for your packages',
          initialValue: initial,
          validate: (value) => validate(value ?? ''),
        })
      ),
    examples: async (scope: string, initial: Example[]) => {
      const hints = EXAMPLE_HINTS(scope);
      return answer(
        await prompts.multiselect<Example>({
          message: 'Which examples do you want?',
          options: EXAMPLES.map((value) => ({
            value,
            label: value,
            hint: hints[value],
          })),
          initialValues: initial,
          required: true,
        })
      );
    },
    git: async (initial: boolean) =>
      answer(await prompts.confirm({ message: 'Initialize git?', initialValue: initial })),
    install: async (initial: boolean) =>
      answer(await prompts.confirm({ message: 'Install dependencies?', initialValue: initial })),
    replace: async (folder: string, count: number, backupName: string) =>
      answer(
        await prompts.confirm({
          message: `${folder} already has ${count} ${count === 1 ? 'file' : 'files'}. Move them to ${backupName} and continue?`,
          initialValue: false,
        })
      ),
  };
}

export type Ask = ReturnType<typeof createAsk>;
