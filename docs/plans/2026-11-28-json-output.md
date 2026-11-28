# Plan: `--json` (#21, part 2)

> Snapshot of the plan for #21 part 2, written 2026-11-28 before the code. The code and the README are the current truth; line numbers and unticked boxes here are not.

**Goal:** `--json` prints one JSON object on stdout for every exit the process can catch: success, `--check`, `--version`, a usage error, a failure, an interrupt at any point, and an unexpected crash. The object says what the run left behind and, for a failure, how to fix it and whether a retry is safe. The text output renders the same facts, so an agent that forgets `--json` still gets the fix.

**Why now:** part 1 (0.3.0) made every exit produce one `Outcome`. This part settles the contract scripts will depend on, fills the fields part 1 left empty (fixes, warnings, retries), and serializes them.

**Architecture:**
- A new `json.ts` owns the contract: a `JsonResult` type and `toJson(outcome)`, an explicit mapping from `Outcome`. Internal types (`RunPlan`, `RunResult`) never reach stdout directly, so a refactor can't change the contract by accident.
- Under `--json`, all text (progress, warnings, the final message) goes to stderr through `plainUi({ out: stderr, err: stderr })`. Stdout carries only the object.
- One function prints a finished `Outcome`: `report(outcome)`, built in `execute` where the plan is known. It adds the retry, renders the text, and, under `--json`, emits the object. `main` calls it at the end; the interrupt handlers call it before `process.exit`. So an interrupt gets the same retry and the same object as any other exit.
- The object is written by `emit`, a seam (`MainIo.emit`). Its default writes to fd 1 synchronously and loops until every byte is written, so an interrupt's `process.exit` can't cut it short.
- A command-level interrupt handler covers the whole command: `--check`, and the awaits before `run()`. Like `run()`'s, it freezes the command the moment a signal arrives: every exec `execute` makes returns a promise that never settles, so the interrupted command can't carry on, print, or start `run()`. While `run()` runs, its own handler owns the interrupt and the command-level one does nothing. After `report`, a last handler only keeps the outcome's exit code.

**Spec:** issue #21 ("Done when", "Build notes", "Deliberately not used"); `docs/plans/2026-11-25-run-outcome.md`, "Carried to part 2"; the contract draft agreed on 2026-11-28; revisions 2–4 after a risk review and a test-adequacy review of this plan, each run three times.

**Depends on:** 0.3.0 (#36: `Outcome`, `exitCode`, `leftBehind`).

**Not in this part:** `--dry-run` (part 3), the launcher check in CI (part 4), a JSON Schema file (#21, Open).


## The contract

These rules go into the README's "For agents" section word for word.

1. With `--json`, stdout carries exactly one JSON object followed by a newline, except with `--help`, which prints its text. Everything else goes to stderr.
2. The exit code is the same as without `--json`. `ok` is `true` exactly when the exit code is 0.
3. `schemaVersion` is an integer, starting at `1`. It goes up only for a breaking change: a field removed or renamed, a type changed, or a value's meaning changed. A new field, or a new `code`, `kind`, `scope` or `git` value, does not raise it.
4. Consumers ignore fields they don't know and accept values they don't know.
5. Paths are absolute. `project.folder` is the argument as given.
6. Commands are argument arrays (`argv`), never shell strings, each with the folder to run it in.
7. `--json` implies `-y`: it never prompts.

Every object has `schemaVersion`, `ok`, `kind` and `cli: { version, template: { tag, commit } }`.

```ts
type JsonResult =
  | Base & { ok: true; kind: 'created'; project: Project; git: GitOutcome; install: { ran: boolean; seconds: number };
      pnpm: PnpmJson; left: Left; warnings: Problem[]; next: Step[]; checklist: { item: string; readme: string }[] }
  | Base & { ok: true; kind: 'checked'; pnpm: PnpmJson; warnings: Problem[] }
  | Base & { ok: true; kind: 'version' }
  | Base & { ok: false; kind: 'failed'; error: JsonError; left?: Left; retry?: Step };

type Project = { path: string; folder: string; name: string; scope: string; examples: { kept: Example[]; removed: Example[] } };
type Step = { argv: string[]; cwd: string };
type Fix = { argv: string[]; scope: Scope } | { see: string; scope: Scope };
type Scope = 'project' | 'user' | 'system';
type Problem = { code: string; title: string; lines: string[]; fixes: Fix[] };
type JsonError = Problem & { code: ErrorCode; output?: string[]; required?: Record<string, string>; found?: Record<string, string> };
```

- `git` is `committed`, `no-identity`, `no-git`, `inside-repo`, `off` or `failed`. `no-identity`, `no-git` and `failed` also add a warning.
- `install.seconds` is the time `pnpm install` took, and 0 when `ran` is `false`. Today `RunResult.seconds` also times the lockfile-only update under `--no-install` (`run.ts:341`), against its own comment (`run.ts:58`). Task 2 makes it match the comment; the text never prints it for `--no-install`.
- `left` is absent when the run never reached the disk: a usage error, the refused folder, `--check`, a cancelled prompt, an interrupt before `run()`.
- `error.output` is the last 20 lines of pnpm's output, with credentials removed. It appears only for `install-failed`.
- `retry` is a `Step`: `argv` is the CLI's arguments without the launcher, and `cwd` is the folder they were resolved against. The CLI can't tell whether it ran under `npm exec`, `pnpm dlx` or `npx`; the consumer prepends its own launcher and runs it in `cwd`. Under `--json`, `argv` includes `--json`. The folder always comes last, after `--`. Options like `-y` and `--scope` are also npm's, so the launcher prefix must end in its own `--`: the README gives `npm exec --yes create-ts-monorepo-starter@latest --` exactly.


## Global Constraints

- **Text output without `--json` is unchanged,** byte for byte, except the intended changes below. Part 1's pinned tests pass, except the edits listed here, each made in the task that causes it.
- **Intended text changes, each with its own test:**
  1. An error thrown before the run starts (detecting pnpm, the git identity, building the plan) prints `✗ <message>` and exits 1. Today it rejects `main`, and `cli.ts` prints a stack trace (Task 1).
  2. Credentials in pnpm's output are removed in the text too: the install tail, the two lines `switchFailure` quotes, and git's warning lines (Task 2).
  3. A failed install or an interrupt that can be retried safely ends with one line: `Retry: create-ts-monorepo-starter <args>`. Toolchain failures keep their own "Then run this command again." and gain no line (Task 3).
  4. A Ctrl-C before `run()` or during `--check` prints `Cancelled. Nothing was written.`, stops pnpm and its children, removes the `ctms-pnpm-*` folder, and exits 130. Today the process dies by the signal and leaves the folder. A Ctrl-C during `run()`'s own pnpm switch check also removes that folder; today it stays (Task 4).
  5. When stdout isn't a terminal, a real run (created, `--check`, failed, the refused folder, interrupted) prints `add --json for machine-readable output` as the first stderr line. `--help`, `--version`, usage errors and `--json` runs never print it (Task 5).
- **Pinned tests edited on purpose:**
  - `main.test.ts:263` and `:272` (`rejects when the exec … throws synchronously`): resolve with 1 and print `fail: spawn exploded` (Task 1).
  - `main.test.ts:380` (`reports a failed install`): the `fail:` line gains `| Retry: create-ts-monorepo-starter -y --scope @my-tools --examples lib,cli,web -- my-tools` (Task 3; the exact options are whatever that test's plan resolves to).
  - `cli.test.ts:116` and `:192` (`stderr` is `''` on a successful piped run), and `:183` (the refused folder): the hint line (Task 5).
  - No other expected string changes. `bin.test.ts:25` (`--help`) and the usage-error tests at `cli.test.ts:81, 90, 158, 165, 172` stay as they are.
- The exit codes stay as part 1 left them. `exitCode` is still the only place they are decided.
- The safety rules in AGENTS.md ("Rules that keep users safe") stay as they are. `--json` changes what is printed, never what is touched (tested, Task 5).
- Modules take side effects as parameters; tests pass fakes. No new runtime dependency.
- One PR, one commit per task, Conventional Commits. A minor changeset.


## Tasks

### Task 1: every error before the run is an `Outcome`

**Files:** `src/main.ts`, `test/main.test.ts`.

- [ ] **Step 1:** `gitIdentity` takes `io.exec` (today it gets the default exec, so no test can make it fail). `gitIdentity`, `planFromOptions` and `check()`'s rethrow move inside `execute`'s `try`. A thrown error becomes a failure through `failureFrom`: `unexpected` unless it carries one of the CLI's codes.
- [ ] **Tests:**
  - The two pinned `--check` tests at `main.test.ts:263` and `:272` resolve 1 with `fail: spawn exploded` (edited on purpose).
  - A `gitIdentity` exec that throws: exit 1, `fail:` with its message, nothing created in `cwd`.
  - `planFromOptions` throws only `NameError` (`run.ts:98-104`, and `packageNameFromFolder`), which `execute` already turns into a usage error. Moving it inside the `try` is defensive; no test can reach a different error, and none is written.
- [ ] **Commit:** `fix: report an error before the run as a failure, not a stack trace`

### Task 2: structured failures, warnings and redaction

**Files:** `src/pnpm.ts`, `src/run.ts`, `src/main.ts`, `src/report.ts`, `src/outcome.ts`, new `src/redact.ts`; tests in `test/pnpm.test.ts`, `run.test.ts`, `main.test.ts`, new `test/redact.test.ts`.

- [ ] **Step 1: Fixes on the pnpm failures.** `ToolchainError` carries `fixes`, `required` and `found`. `tooOld`: `required { pnpm: '>=10.26' }`, `found { pnpm }`, fix `{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }`. `switchFailure` with an installer: `{ argv: ['node', installer], scope: 'user' }`; without: `{ see: PNPM_HELP, scope: 'user' }`. The `Upgrade pnpm:` and `Fix:` text lines are rendered from the fixes. Test: the pinned text is unchanged, including an installer path with a space (text as today; the `argv` keeps the path as one element).
- [ ] **Step 2: Warnings.** `RunResult` gains `warnings: Problem[]`, filled where `run()` calls `ui.warn` (`run.ts:317, 320, 329, 366, 373`): `git-missing`, `git-failed`, `pnpm-missing` (fix `npm install -g pnpm`, scope `user`), `commit-failed`, `git-no-identity`. `execute` copies them into the `created` outcome. `check()` builds `pnpm-missing` when pnpm is absent, and `renderText` prints the `--check` warning from it.
- [ ] **Step 3: `install.seconds`** is 0 under `--no-install` (`run.ts:341`). The text doesn't print it in that case, so no text changes.
- [ ] **Step 4: Redaction.** `redact(line)` replaces the password in `scheme://user:pass@` with `***`, and the value of `_authToken=`, `_auth=`, `_password=`, `Authorization: Bearer `, and whole tokens shaped `npm_` + 36 alphanumerics, `ghp_` + 36, `github_pat_` + 82. Applied to the install tail (kept separately as `output`), the lines `switchFailure` quotes, and git's warning lines.
- [ ] **Tests:**
  - `redact`: each pattern; two credentials on one line; untouched lines, including `npm_config_registry=https://r.example`, `ghp_x`, and a URL with a user but no password.
  - Wired: an install-failed run whose fake `exec` stderr holds `//r.example/:_authToken=abc123`. The `fail:` line and `error.output` show `***`, never `abc123`. The same for a `switchFailure` and a git warning.
  - `error.output` only for `install-failed`: absent for `lockfile-changed`.
  - Warnings at the `execute` level: a failing `git init` gives `warnings[0].code === 'git-failed'` in the outcome; a clean run gives `warnings: []`; `--check` without pnpm gives `pnpm-missing`, and its text is unchanged.
- [ ] **Commit:** `feat: give failures fixes and warnings codes, and remove credentials from pnpm's output`

### Task 3: safe retries, and one `report` for every exit

**Files:** new `src/retry.ts`, `src/main.ts`, `src/run.ts`, `src/report.ts`; new `test/retry.test.ts`, `run.test.ts`, `main.test.ts`, `report.test.ts`.

- [ ] **Step 1: `retryStep(outcome, plan, cwd, json)`** returns a `Step` only when all hold: there is a plan; the code is one a retry can fix (`pnpm-too-old`, `pnpm-switch-failed`, `install-failed`, `interrupted`); and `left` is present and shows nothing changed (`target` `missing`, `empty` or `unchanged`; no `backup`, no `temp`, not `running`). A missing `left`, a missing plan, and `unknown` never get a retry.
- [ ] **Step 2: The args** are rebuilt from the resolved plan, never the original argv: `-y`, `--scope`, `--examples`, `--no-git` and `--no-install` when off, `--json` when asked for, `--force` only while the target is still non-empty and the plan had `replace`, then `--` and the folder as given, always last. `cwd` is the folder the plan was resolved against. A plan the person built by answering prompts gets the same args: a Yes to "replace?" becomes `--force`, which the README notes (Task 6).
- [ ] **Step 3: `report`.** `execute` builds `report(outcome): Outcome`: attach `retryStep`, render text, emit the object under `--json`, and return the outcome it printed. Each of the three runs in its own `try`, so a failing text render can't stop the object. A new `RunDeps.report` replaces the interrupt handler's direct `renderText` call (`run.ts:267`), inside its own `try`, before removing an empty backup and before `process.exit`. Its default is `(outcome) => (renderText(outcome, ui), outcome)`, so `run()` alone behaves as today. `RunDeps.onOutcome` (part 1) stays as the tests' observer and receives what `report` returned, retry included: the part 1 interrupt tests assert both the `fail:` line and the outcome through it (`run.test.ts:959-995`), and merging the two would rewrite those tests. `main` calls the same `report` for every other exit.
- [ ] **Step 4: The text line.** `renderText` appends `Retry: create-ts-monorepo-starter <args>` to a failure with a `retry` whose code is `install-failed` or `interrupted` (intended change 3).
- [ ] **Tests:**
  - `retryStep`: no retry for every unsafe `left` (each field), for a missing `left`, for a missing plan, and for each code outside the four; a retry for each of the four with `left.target` `missing`.
  - Args: `--force` only while the target is non-empty and `replace` was set (both directions); `--no-git`, `--no-install`, `--examples` and `--json` from the plan; a folder starting with `-` comes after `--`; `cwd` absolute.
  - Interrupt, through `main` in `main.test.ts` (the `report` under test is the one `execute` builds, so forgetting to pass it fails the test): `runDeps.onInterrupt` captures `exit` (today a no-op, `main.test.ts:343`), `process.exit` is spied, and a fake `generate` fires the interrupt. In the `working` phase the reported outcome carries `retry` and the text has the retry line; with `temp` left or `running`, neither.
  - In `run.test.ts` through `catching`: a `report` that throws still exits 130 and still removes an empty in-place backup; `onOutcome` receives what `report` returned.
  - `renderText`: the line with `retry` and an allowed code; no line without `retry`; no line for `pnpm-too-old` even with `retry`.
  - The pinned `main.test.ts:380` gains the retry line (edited on purpose).
- [ ] **Commit:** `feat: offer a retry only when nothing changed`

### Task 4: the command-level interrupt

**Files:** `src/main.ts`, `src/run.ts`, `src/pnpm.ts`, `src/workspace.ts`; `test/main.test.ts`, `test/run.test.ts`, `test/workspace.test.ts`.

- [ ] **Step 1: The seam.** `onInterrupt` takes the folders to remove as a getter, `() => string[]`, read when the signal is handled, so a folder created later (by `checkSwitch`) is still removed. `MainIo.interruptDeps` passes `InterruptDeps` (`exit`, `stop`, `remove`, `live`, `onStart`) through, so tests fake the stop and the removal while the handler's own logic runs for real. Two new fields: `on` registers the handler (default `process.on` for the three signals; tests capture the handler through it and fire it themselves), and `active: () => boolean`, checked first in the handler, before `handling` is set (`workspace.ts:232`): when it returns false the handler does nothing at all. `removed` keeps meaning the run's own temporary folder only. A `ctms-pnpm-*` folder that can't be deleted is ignored: it sits in the system temp folder, and reporting it as `left.temp` would name the wrong folder and block the retry.
- [ ] **Step 2: Freeze on the signal.** `execute` registers the command-level handler for SIGINT, SIGTERM and SIGHUP. Its `onStart` sets `interrupted`. Every exec `execute` makes (to `detectPnpm`, `checkSwitch` and `gitIdentity`) goes through a wrapper like `run.ts:231-235`: once `interrupted` is set it returns a promise that never settles, and a result that arrives after the signal is dropped the same way. So a pnpm the handler kills can't make `check()` return, and `execute` can't go on into `run()`. `execute` also checks `interrupted` before calling `run()` and before calling `report`.
- [ ] **Step 3: The handler.** On a signal outside `run()`: stop pnpm and its children, remove the folder `checkSwitch` reported through its new `onDir` callback, `report` an `interrupted` failure titled `Cancelled. Nothing was written.` with no `left`, and exit 130 in a `finally`.
- [ ] **Step 4: Handing over to `run()`.** While `run()` runs, the command-level handler's `active` returns false, so it doesn't stop, remove, report or exit: `run()` registers its own handler synchronously before its first `await` (`run.ts:244`), `execute` sets the flag immediately before calling `run()`, and clears it when `run()` settles. `run()` passes `onDir` to its own `checkSwitch` (`run.ts:289`) and its handler removes that folder too.
- [ ] **Step 5: After `report`.** **Invariant:** `execute` has no `await` between `run()` settling and `report`, so no signal can be handled between them. A comment at the call says so. After `report`, `main` replaces the command-level handler with one that only sets `process.exitCode` to the outcome's code, so a Ctrl-C while stderr drains can't turn an emitted `ok: true` into a death by signal. It stays registered until the process exits: a SIGINT listener doesn't keep the process alive, and removing it would reopen the window while stderr drains. Tests restore `process.exitCode` in an `afterEach`.
- [ ] **Tests:** fake signals through the captured handler, a fake `stop` that resolves on a later tick, a fake `remove`, a fake `exit`, and a recording `report`:
  - an interrupt during `--check`'s `checkSwitch`: `stop` called, the `ctms-pnpm-*` folder the fake reported removed, exactly one `report` (interrupted) and one `emit`, exit 130, even though the fake pnpm exits non-zero once stopped;
  - an interrupt during `gitIdentity`: the same, `run` never called, nothing created in `cwd`;
  - an interrupt while `run()` runs: the test fires the captured command-level handler from inside a fake `generate`; the command-level `stop`, `remove`, `onStart`, `report` and `exit` are all never called (dropping the `active` check fails this test);
  - in `run.test.ts`, with the real `onInterrupt` and fake `stop`, `remove` and `on` (the `catching` seam bypasses removal, so it can't show this): an interrupt during `run()`'s `checkSwitch` removes the folder it reported; a `remove` that fails only for that folder leaves no `left.temp`, and the retry is still offered;
  - after `report`, a signal sets `process.exitCode` to the outcome's code and prints nothing;
  - after `main` resolves, only the exit-code handler is registered.
- [ ] **Commit:** `fix: a Ctrl-C before the run or during --check stops pnpm and cleans up`

### Task 5: `--json`

**Files:** `src/args.ts`, new `src/json.ts`, new `src/emit.ts`, `src/main.ts`, `src/cli.ts`, `src/ui.ts`; new `test/json.test.ts`, `test/emit.test.ts`, `args.test.ts`, `main.test.ts`, `cli.test.ts`, `bin.test.ts`, `test/e2e/interrupt.test.ts`.

- [ ] **Step 1: The flag.** `--json` in `parseArgv`; it implies `-y`, so `isInteractive` is false. `wantsJson(argv)` scans the raw args before `--` and takes the last of `--json` and `--no-json` (`allowNegative`, `args.ts:90`), so an argv that fails to parse still gets an object and exit 2. Both `chooseUi` (`main.ts:123`) and the unparseable fallback (`main.ts:193`) use stderr under `--json`.
- [ ] **Step 2: `toJson(outcome)`** maps every `Outcome` to `JsonResult`. `closing()` (`ui.ts`) returns structured steps (`argv` and `cwd`, with no `cd` and no `&&`). Text formats them exactly as today, including the relative `cd` and the in-place-backup case. `checklist` comes from `CHECKLIST`.
- [ ] **Step 3: `emit`.** The default writes to fd 1 with `writeSync`, looping on the returned byte count. On `EAGAIN` it waits (`Atomics.wait` on a scratch buffer, 10 ms, doubling to 200 ms) and retries for at most 5 s in all, then gives up as on `EPIPE`, so a reader that never reads can't hang the process. On `EPIPE` it stops writing and returns: the reader is gone, and the exit code stays the outcome's. `cli.ts`'s last-resort catch moves into an exported `crashed(error, json, emit)`. Under `--json`, and only if nothing has been emitted yet, it emits a minimal `unexpected` object; otherwise it prints the stack as today. It never writes a second object.
- [ ] **Step 4: `--version --json`** emits `{ schemaVersion, ok: true, kind: 'version', cli }`. `--help --json` prints the help text and exits 0 (rule 1's exception).
- [ ] **Step 5: The hint** (intended change 5). A `MainIo.stdoutIsTTY` seam, separate from `interactive`, defaulting to `process.stdout.isTTY`. Unit tests that assert stderr pass it explicitly.
- [ ] **Tests:**
  - `toJson`: every `Outcome` kind compared with a literal object using `toStrictEqual`, and a `JSON.stringify` round trip, so an extra key fails. Never `plan.now` or `plan.holder`. Paths absolute for `project.path`, `left.backup`, `left.temp`, `retry.cwd`. `next` with the in-place-backup case and with a `cwd` that isn't the target's parent.
  - Through `main` with a recording `emit`, for every exit path part 1 pinned: exactly one `emit` call, which parses; the exit code equals the same path's exit code without `--json`; `ok === (code === 0)`; the text went to the stderr Ui.
  - `--json` never prompts: `main(['--json'], { interactive: true, prompts: <throwing fakes> })` exits 2 with `error.code === 'usage'`; `main(['x', '--json'], { interactive: true, … })` prompts nothing.
  - `wantsJson`: `--json` after `--` is a folder; `--json --no-json` is text; `--json=1` and `--scope --json` both fail to parse and give a JSON usage object with exit 2.
  - Same disk, either way: one `runDeps` run with and without `--json` makes the same exec calls (temporary folder names normalized, as `main.test.ts`'s `folder()` does) and leaves the same directory listing.
  - `emit`: a fake `writeSync` that writes 1000 bytes at a time writes the whole object; `EAGAIN` once then success; `EAGAIN` forever gives up after the deadline (a fake clock) without throwing; `EPIPE` stops without throwing. `crashed`: one minimal object under `--json`; none after an emit; the stack without `--json`.
  - The interrupt writes before exiting: through `main` (as in Task 3's interrupt test), with a recording `emit` and a spied `process.exit`, the one `emit` call carries `retry` and comes before `exit(130)`.
  - `--help --json` prints the help text on stdout and exits 0.
  - The hint: not a TTY gives one first stderr line; a TTY, `--json`, `--help`, `--version` and a usage error give none. `cli.test.ts:116`, `:183` and `:192` gain it (edited on purpose).
  - Spawned (`cli.test.ts`, real stdout): one test per exit kind (created, checked, version, usage, failed, refused folder), each stdout parsing as exactly one object. `fakePnpm` gains a failing mode for install-failed.
  - e2e (`interrupt.test.ts`): `--json` with stdout a pipe, SIGINT when `Installing` appears on **stderr**; the object parses, `left` matches the disk, `retry` present.
- [ ] **Commit:** `feat: --json prints one object for every exit`

### Task 6: docs

- [ ] README: a "For agents" section with the contract rules word for word, `npm exec --yes create-ts-monorepo-starter@latest -- --json -- <folder>` (the first `--` is npm's, and a `retry.argv` goes after it as is) and `pnpm dlx create-ts-monorepo-starter <folder> --json`, the exit code table, "show a person any fix whose scope isn't `project` before running it", and "a retry may carry `--force` when the folder was to be replaced; nothing is deleted, the folder is moved aside". `--json` in the options list.
- [ ] AGENTS.md: `json.ts`, `emit.ts`, `retry.ts`, `redact.ts` in the module map.
- [ ] **Commit:** `docs: --json for agents`

### Before the version PR merges

Not a commit. Run the README's `npm exec` and `pnpm dlx` commands against the PR's pkg.pr.new preview on macOS and Linux: one success, `--check`, one usage error, one failed install (an unreachable registry), and one Ctrl-C during the install; then a failed run's `retry.argv` appended to each launcher prefix as is. Check that stdout parses, the exit codes match, and that both launchers run the CLI in the caller's folder (`project.path` is under it), which `retry.cwd` depends on. Nothing enforces this gate: the version PR can be merged without it, so the PR description lists it as a checkbox and it is reported before asking to merge. The launcher check that automates it is part 4.


## Decisions

1. **`schemaVersion` changes only on a breaking change.** Additions don't raise it; consumers accept the unknown.
2. **`retry` is a `Step` without the launcher.** The launcher is the caller's; guessing it would be wrong for one of npm, pnpm and npx. `cwd` is included because a relative folder resolved elsewhere would name another folder, and with `--force` that folder would be moved aside.
3. **Errors before the run become failures in text too.** `--json` needs them caught; printing a message where text printed a stack trace is the same fix.
4. **`--version --json` prints an object; `--help --json` prints text,** and rule 1 says so.
5. **Progress goes to stderr under `--json`.** A two-minute install with nothing on screen looks hung, and stdout stays one object.
6. **`--json` is found in the raw args first,** so a usage error still answers in JSON.
7. **Redaction applies to text too,** and to every place pnpm's or git's output is quoted.
8. **The contract is its own type,** mapped explicitly, with exact-key tests.
9. **`--json` is stable from its first release.** An "experimental" label would invite agents to ignore the rules. The preview gate above stands in for the launcher check until part 4.
10. **The hint is for real runs only.** `--help`, `--version` and usage errors stay as they are, so the people and scripts that call them see no change.
11. **The text retry line is for `install-failed` and `interrupted` only.** The toolchain failures already end with "Then run this command again", which is the same command.


## Risk register

| Risk | Where | Guard |
| --- | --- | --- |
| Something other than the object reaches stdout under `--json` | `process.stdout.write`, clack, the `plainUi` fallbacks | the Ui is `plainUi` on stderr in both places it's chosen; spawned tests parse stdout for each exit kind |
| The object is cut short | `emit` | a byte-count loop and `EAGAIN` retry; tested with partial-write fakes |
| A reader that never reads hangs the process | `emit` | the `EAGAIN` retries stop after 5 s |
| The reader closed the pipe | `emit`, `crashed` | `EPIPE` stops the write; no second object; the exit code stays the outcome's |
| An interrupt outside `run()` prints nothing and leaks a folder | `--check`, `gitIdentity`, `targetState` | the command-level handler (Task 4) |
| The interrupted command carries on and prints a second object, or starts `run()` | `execute` after a signal | every exec freezes once the signal arrives; `report` and `run()` check the flag; tested with a `stop` that resolves later |
| Two handlers both act on one signal | `execute` and `run()` | `active`, checked before the handler does anything; tested by firing the command-level handler while `run()` runs and asserting none of its steps ran |
| A Ctrl-C after the object is emitted kills the process by the signal | after `report` | a last handler keeps the outcome's exit code |
| An `await` added later between `run()` and `report` opens a window | `execute` | the invariant, stated in a comment at the call |
| SIGTERM or SIGHUP while a prompt is open now prints and exits 130 with the cursor hidden | interactive runs | accepted: cosmetic; Node restores the terminal mode, not the cursor |
| An interrupt gets no retry | the interrupt handler | `report` is built in `execute` and passed to `run()`; tested through `main`, so a missing hand-over fails |
| A launcher drops the caller's folder | `retry.cwd` | the preview gate checks `npm exec` and `pnpm dlx` |
| A retry moves aside a folder the person never named | `retry` | `cwd` in the step; `--force` only while still needed; tested both ways |
| The contract changes by accident | `toJson` | its own type, `toStrictEqual`, literal expected objects |
| A wrong field name is published | the release | the preview gate before the version PR; after release, only `schemaVersion: 2` can change it |
| A credential reaches a log | pnpm and git output | `redact` on every quoted line, text and JSON, tested where it is wired. A credential in a shape the patterns don't know still leaks: accepted, documented |
| npm prints its own lines on stdout | `npm create` | documented: agents use `npm exec` or `pnpm dlx` (#21) |
| Text drifts | every exit | part 1's pinned tests stay, except the listed edits |
| Windows pipes behave differently | `emit` | unit tests with fakes run on Windows in CI; the interrupt e2e is POSIX-only, as in part 1 |

**Rollback:** before the version PR merges, revert the PR. After release, a published version can't be withdrawn for reuse: a mistake in text is fixed by a patch; a mistake in the contract by an additive fix, or by `schemaVersion: 2` when it can't be additive. The text changes (intended changes 1–5) reach people who never pass `--json`, so they are in the changeset.
