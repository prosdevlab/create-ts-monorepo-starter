import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Outcome } from '../src/outcome';
import { tooOld } from '../src/pnpm';
import { failureFrom, renderText, usageFailure } from '../src/report';
import { pnpmSpec } from '../src/template';
import { CancelledError, type Ui } from '../src/ui';

afterEach(() => vi.restoreAllMocks());

const recording = () => {
  const calls: string[] = [];
  const ui: Ui = {
    intro: () => calls.push('intro'),
    step: (done) => calls.push(`step: ${done}`),
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    warn: (title, lines) => calls.push(`warn: ${[title, ...lines].join(' | ')}`),
    fail: (title, lines) => calls.push(`fail: ${[title, ...lines].join(' | ')}`),
    outro: () => calls.push('outro'),
  };
  return { calls, ui };
};

describe('failureFrom', () => {
  it('uses the title and lines of a CLI error, with its code', () => {
    expect(failureFrom(tooOld('9.0.0', 'pnpm@12.15.0'))).toMatchObject({
      code: 'pnpm-too-old',
      title: 'pnpm 9.0.0 is too old for this project',
    });
  });

  it('splits any other message, the first line as the title', () => {
    expect(failureFrom(new Error('a\nb\nc'))).toEqual({
      code: 'unexpected',
      title: 'a',
      lines: ['b', 'c'],
      fixes: [],
    });
    expect(failureFrom('text')).toMatchObject({ title: 'text', lines: [] });
    expect(failureFrom(new Error(''))).toMatchObject({ title: '', lines: [] });
  });

  it('prints a cancelled prompt as the cancelled message', () => {
    expect(failureFrom(new CancelledError('anything'))).toMatchObject({
      code: 'cancelled',
      title: 'Cancelled. Nothing was written.',
    });
  });
});

describe('renderText', () => {
  it('writes a usage error as one stderr line and shows nothing else', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { calls, ui } = recording();
    renderText(usageFailure('bad flag'), ui);
    expect(write).toHaveBeenCalledWith('bad flag\n');
    expect(calls).toEqual([]);
  });

  it('shows any other failure with ui.fail', () => {
    const { calls, ui } = recording();
    renderText({ ok: false, error: failureFrom(new Error('x\ny')) }, ui);
    expect(calls).toEqual(['fail: x | y']);
  });

  it('shows --check results', () => {
    const version = pnpmSpec().slice('pnpm@'.length);
    const ready = recording();
    renderText(
      { ok: true, kind: 'checked', pnpm: { kind: 'ok', version: '10.28.0' }, warnings: [] },
      ready.ui
    );
    expect(ready.calls).toEqual([
      `step: Ready: pnpm 10.28.0 switches to pnpm ${version} for this project`,
    ]);
    const none = recording();
    renderText({ ok: true, kind: 'checked', pnpm: { kind: 'none' }, warnings: [] }, none.ui);
    expect(none.calls[0]).toMatch(/^warn: pnpm isn't installed \| Creating works/);
  });

  it('closes a created project with the outro', () => {
    const { calls, ui } = recording();
    const outcome = {
      ok: true,
      kind: 'created',
      plan: {},
      result: {},
      warnings: [],
      left: { target: 'complete' },
    } as unknown as Outcome;
    renderText(outcome, ui);
    expect(calls).toEqual(['outro']);
  });
});
