import { CliError, codeOf, type Failure, type Outcome } from './outcome.js';
import { pnpmSpec } from './template.js';
import { CANCELLED, CancelledError, type Ui } from './ui.js';

/** The failure for an error: the text `report()` printed before, and the code. */
export function failureFrom(error: unknown): Failure {
  const code = codeOf(error);
  if (error instanceof CancelledError) return { code, title: CANCELLED, lines: [], fixes: [] };
  if (error instanceof CliError) {
    return { code, title: error.message, lines: error.lines, fixes: [] };
  }
  const [title = 'Something went wrong', ...lines] = String(
    error instanceof Error ? error.message : error
  ).split('\n');
  return { code, title, lines, fixes: [] };
}

/** A usage error: one line on stderr, before anything else is shown. */
export function usageFailure(message: string): Outcome {
  const [title = '', ...lines] = message.split('\n');
  return { ok: false, error: { code: 'usage', title, lines, fixes: [] } };
}

/** Prints an outcome as text. */
export function renderText(outcome: Outcome, ui: Ui): void {
  if (!outcome.ok) {
    const { code, title, lines } = outcome.error;
    if (code === 'usage') process.stderr.write(`${[title, ...lines].join('\n')}\n`);
    else ui.fail(title, lines);
    return;
  }
  if (outcome.kind === 'created') {
    ui.outro(outcome.result, outcome.plan);
    return;
  }
  const version = pnpmSpec().slice('pnpm@'.length);
  if (outcome.pnpm.kind === 'none') {
    ui.warn("pnpm isn't installed", [
      `Creating works: the install uses a temporary pnpm ${version} (npm exec).`,
      `Working in the project needs pnpm 10.26 or newer: https://pnpm.io/installation`,
    ]);
  } else if (outcome.pnpm.kind === 'ok') {
    ui.step(`Ready: pnpm ${outcome.pnpm.version} switches to pnpm ${version} for this project`);
  }
}
