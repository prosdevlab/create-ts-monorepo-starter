import { EXAMPLES, type Example } from './args.js';
import type { ErrorCode, Failure, Fix, Left, Outcome, Problem, Step } from './outcome.js';
import type { PnpmStatus } from './pnpm.js';
import { cliVersion, pnpmSpec, templateVersion } from './template.js';
import { CHECKLIST, nextSteps } from './ui.js';

/**
 * The `--json` contract. Raised only for a breaking change: a field removed or renamed, a type
 * changed, or a value's meaning changed. A new field or a new value doesn't raise it.
 */
export const SCHEMA_VERSION = 1;

type Base = {
  schemaVersion: number;
  cli: { version: string; template: { tag: string | null; commit: string } };
};

/** The pnpm on this machine (`null` when there is none), and the one the template pins. */
type PnpmJson = { found: string | null; pinned: string };

type Project = {
  /** Absolute. */
  path: string;
  /** The folder argument as given. */
  folder: string;
  name: string;
  scope: string;
  examples: { kept: Example[]; removed: Example[] };
};

type GitJson = 'committed' | 'no-identity' | 'no-git' | 'inside-repo' | 'off' | 'failed';

type JsonError = Problem & {
  code: ErrorCode;
  output?: string[];
  required?: Record<string, string>;
  found?: Record<string, string>;
};

/**
 * What `--json` prints, mapped field by field from an `Outcome`, so a change to the internal types
 * can't change the contract by accident.
 */
export type JsonResult =
  | (Base & {
      ok: true;
      kind: 'created';
      project: Project;
      git: GitJson;
      install: { ran: boolean; seconds: number };
      pnpm: PnpmJson;
      left: Left;
      warnings: Problem[];
      next: Step[];
      checklist: { item: string; readme: string }[];
    })
  | (Base & { ok: true; kind: 'checked'; pnpm: PnpmJson; warnings: Problem[] })
  | (Base & { ok: true; kind: 'version' })
  | (Base & { ok: false; kind: 'failed'; error: JsonError; left?: Left; retry?: Step });

function base(): Base {
  const { tag, commit } = templateVersion();
  return {
    schemaVersion: SCHEMA_VERSION,
    cli: { version: cliVersion(), template: { tag, commit } },
  };
}

const fix = (f: Fix): Fix =>
  'argv' in f ? { argv: [...f.argv], scope: f.scope } : { see: f.see, scope: f.scope };

const problem = (p: Problem): Problem => ({
  code: p.code,
  title: p.title,
  lines: [...p.lines],
  fixes: p.fixes.map(fix),
});

const step = (s: Step): Step => ({ argv: [...s.argv], cwd: s.cwd });

const left = (l: Left): Left => ({
  target: l.target,
  ...(l.backup !== undefined && { backup: l.backup }),
  ...(l.temp !== undefined && { temp: l.temp }),
  ...(l.running && { running: true as const }),
});

const pnpm = (status: PnpmStatus): PnpmJson => ({
  found: status.kind === 'none' ? null : status.version,
  pinned: pnpmSpec().slice('pnpm@'.length),
});

function error(failure: Failure): JsonError {
  return {
    ...problem(failure),
    code: failure.code,
    ...(failure.output && { output: [...failure.output] }),
    ...(failure.required && { required: { ...failure.required } }),
    ...(failure.found && { found: { ...failure.found } }),
  };
}

/** The object for `--version --json`. */
export function versionJson(): JsonResult {
  return { ...base(), ok: true, kind: 'version' };
}

/** The object for an `Outcome`. */
export function toJson(outcome: Outcome): JsonResult {
  if (!outcome.ok) {
    return {
      ...base(),
      ok: false,
      kind: 'failed',
      error: error(outcome.error),
      ...(outcome.left && { left: left(outcome.left) }),
      ...(outcome.retry && { retry: step(outcome.retry) }),
    };
  }
  if (outcome.kind === 'checked') {
    return {
      ...base(),
      ok: true,
      kind: 'checked',
      pnpm: pnpm(outcome.pnpm),
      warnings: outcome.warnings.map(problem),
    };
  }
  const { plan, result } = outcome;
  const { setup, next } = nextSteps(result, plan);
  return {
    ...base(),
    ok: true,
    kind: 'created',
    project: {
      path: plan.target,
      folder: plan.folder ?? plan.target,
      name: plan.folderName,
      scope: plan.scope,
      examples: {
        kept: EXAMPLES.filter((example) => plan.keep.includes(example)),
        removed: EXAMPLES.filter((example) => !plan.keep.includes(example)),
      },
    },
    git: result.git,
    install: { ran: result.installed, seconds: result.installed ? result.seconds : 0 },
    pnpm: pnpm(result.pnpm),
    left: left(outcome.left),
    warnings: outcome.warnings.map(problem),
    next: [...setup, ...next].map(step),
    checklist: CHECKLIST.map(([item, readme]) => ({ item, readme })),
  };
}

/**
 * The last-resort object for an error nothing caught. Built from the error alone: reading the
 * CLI's version may be what failed, so a version it can't read is `unknown`.
 */
export function crashJson(thrown: unknown): JsonResult {
  let head: Base;
  try {
    head = base();
  } catch {
    head = {
      schemaVersion: SCHEMA_VERSION,
      cli: { version: 'unknown', template: { tag: null, commit: 'unknown' } },
    };
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const [title = 'Something went wrong', ...lines] = message.split('\n');
  return {
    ...head,
    ok: false,
    kind: 'failed',
    error: { code: 'unexpected', title, lines, fixes: [] },
  };
}
