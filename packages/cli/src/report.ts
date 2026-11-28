import { CliError, codeOf, type Failure, type Outcome } from './outcome.js';
import { pnpmSpec } from './template.js';
import { CANCELLED, CancelledError, type Ui } from './ui.js';

/** The failure for an error: the text `report()` printed before, and the code. */
export function failureFrom(error: unknown): Failure {
  const code = codeOf(error);
  if (error instanceof CancelledError) return { code, title: CANCELLED, lines: [], fixes: [] };
  if (error instanceof CliError) {
    const { fixes = [], required, found, output } = error.details;
    return {
      code,
      title: error.message,
      lines: error.lines,
      fixes,
      ...(required && { required }),
      ...(found && { found }),
      ...(output && { output }),
    };
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
  for (const warning of outcome.warnings) ui.warn(warning.title, warning.lines);
  if (outcome.pnpm.kind === 'ok') {
    ui.step(`Ready: pnpm ${outcome.pnpm.version} switches to pnpm ${version} for this project`);
  }
}
