import type { PnpmStatus } from './pnpm.js';
import type { RunPlan, RunResult } from './run.js';

export type ErrorCode =
  | 'usage'
  | 'target-not-empty'
  | 'cancelled'
  | 'pnpm-too-old'
  | 'pnpm-switch-failed'
  | 'install-failed'
  | 'lockfile-changed'
  | 'backup-failed'
  | 'move-failed'
  | 'interrupted'
  | 'unexpected';

export const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'usage',
  'target-not-empty',
  'cancelled',
  'pnpm-too-old',
  'pnpm-switch-failed',
  'install-failed',
  'lockfile-changed',
  'backup-failed',
  'move-failed',
  'interrupted',
  'unexpected',
]);

const USAGE = 2;
export const FAILURE = 1;
/** The machine needs fixing first (pnpm can't switch versions, or is too old); nothing was created. */
export const TOOLCHAIN = 3;
const INSTALL_FAILED = 4;
const INTERRUPTED = 130;

/** The part of an outcome that decides the exit code. */
export type Exiting = { ok: true } | { ok: false; error: { code: ErrorCode } };

/** The exit code for an outcome; a code this function doesn't know exits 1, never 0. */
export function exitCode(outcome: Exiting): number {
  if (outcome.ok) return 0;
  switch (outcome.error.code) {
    case 'usage':
      return USAGE;
    case 'pnpm-too-old':
    case 'pnpm-switch-failed':
      return TOOLCHAIN;
    case 'install-failed':
      return INSTALL_FAILED;
    case 'cancelled':
    case 'interrupted':
      return INTERRUPTED;
    default:
      return FAILURE;
  }
}

/** The error's own code if it is one of the CLI's; a Node code such as `ENOSPC` is `unexpected`. */
export function codeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERROR_CODES.has(code) ? (code as ErrorCode) : 'unexpected';
}

/** A failure the CLI throws on purpose: a code, and the output lines that explain it. */
export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly lines: string[] = []
  ) {
    super(message);
  }
}

/**
 * Classifies an error from a step without changing it: a new error with the same message, the
 * CLI's code, and the original as `cause`. The original keeps its own `code` (retry logic reads it).
 */
export function coded(code: ErrorCode, error: unknown): Error {
  return Object.assign(
    new Error(error instanceof Error ? error.message : String(error), { cause: error }),
    {
      code,
    }
  );
}

/** What the run left on disk, read from the disk itself. */
export interface Left {
  target: 'missing' | 'empty' | 'unchanged' | 'partial' | 'complete' | 'split' | 'unknown';
  /** Where the person's files are, all or some of them. */
  backup?: string;
  /** A temporary folder that couldn't be deleted. */
  temp?: string;
  /** pnpm may still be running. */
  running?: true;
}

interface Fix {
  argv?: string[];
  see?: string;
  scope: 'user' | 'project';
}

interface Problem {
  code: string;
  title: string;
  lines: string[];
  fixes: Fix[];
}

export interface Failure {
  code: ErrorCode;
  title: string;
  lines: string[];
  fixes: Fix[];
  required?: Record<string, string>;
  found?: Record<string, string>;
}

/** How a run ended: what happened, what it left behind, and for a failure, a code. */
export type Outcome =
  | { ok: true; kind: 'created'; plan: RunPlan; result: RunResult; warnings: Problem[]; left: Left }
  | { ok: true; kind: 'checked'; pnpm: PnpmStatus; warnings: Problem[] }
  | { ok: false; error: Failure; left?: Left; retry?: string[] };
