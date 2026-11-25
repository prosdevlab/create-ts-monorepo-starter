
# Plan: one outcome for every exit (#21, part 1)

**Goal:** Every way the CLI can end produces one `Outcome` value: what happened, what the run really left behind, and, for a failure, a code. A failed install exits with 4. The text a person sees doesn't change, and tests written before the refactor prove it.

**Why first:** `--json` (part 2) serializes this value, and `--dry-run` (part 3) reports through it. Today the facts are scattered: `ui.fail` calls, free-text `lines`, a `process.exit` in the interrupt handler, and exit codes picked in `main.ts`. A JSON renderer collecting `Ui` events would miss the exits that never reach `Ui` (#21, Build notes).

**Architecture:** A new `outcome.ts` holds the types, the exit codes and `exitCode`. Every error the CLI throws on purpose carries one of the CLI's own codes; anything else is `unexpected`, and an unknown code always exits 1. What a run left behind comes from two facts: the phase `run()` was in, and a synchronous read of the disk at that moment, so it is true even when a rename was still finishing. `run()` records it for a failure; the interrupt handler builds an interrupted `Outcome` from it. `main()` splits into `execute()`, which returns the `Outcome`, and a text renderer that prints what is printed today.

**Spec:** issue #21 ("Done when", "Build notes", "Deliberately not used"), after the systems-design review; revised twice after a risk review and a test-adequacy review of this plan.

**Depends on:** 0.2.1 (#33: a too-old pnpm already stops as a `ToolchainError` before anything is created).


## Global Constraints

- **Text output is unchanged,** byte for byte, on stdout and stderr, for every exit path Task 0 pins. Task 0 lands first, on today's code; Tasks 1–3 must pass it without edits to its expected strings or call sequences.
- **Intended changes, each a bug fix with its own test:**
  1. A failed run whose temporary folder can't be deleted shows the run's own error and exit code, not the deletion's (Task 3, Step 3). For a failed install that is exit 4 where today it is 1.
  2. A Ctrl-C while backing up names the real backup folder when one with the same name already existed (Task 3, Step 2).
  3. A Ctrl-C during an in-place backup removes the backup folder this run created, if it is still empty (`rmdirSync`, which can't remove a folder with files; never before `onPath` has fired, so never an earlier backup) (Task 3, Step 4).
- **Tests edited on purpose:** `run.test.ts`'s `planFromOptions` exact match gains `folder` (Task 3, Step 2). No other existing expected value changes.
- The only other user-visible change is exit code 4.
- The safety rules in AGENTS.md ("Rules that keep users safe") stay as they are.
- Modules take side effects as parameters; tests pass fakes (AGENTS.md, Testing Instructions).
- No new runtime dependency. `report.ts` imports only types from `run.ts`, so the two can't form an import cycle.
- One PR, one commit per task, Conventional Commits.
- Run the full "Before Calling Work Done" sequence and `pnpm test:e2e` (this touches the CLI's install steps and interrupt path).


## The Outcome

Fields marked *part 2* are in the type so the shape is settled, but nothing fills them until part 2 (see "Carried to part 2").

```ts
type ErrorCode =
  | 'usage'               // a flag, the folder name or the scope (exit 2)
  | 'target-not-empty'    // -y without --force on a non-empty folder (exit 1)
  | 'cancelled'           // a prompt was cancelled (exit 130)
  | 'pnpm-too-old'        // exit 3
  | 'pnpm-switch-failed'  // exit 3
  | 'install-failed'      // pnpm install, --lockfile-only, or the npm exec fallback exited non-zero (exit 4)
  | 'lockfile-changed'    // the install added entries the template didn't test (exit 1)
  | 'backup-failed'       // moving the person's folder aside (exit 1)
  | 'move-failed'         // moving the project into place (exit 1)
  | 'interrupted'         // SIGINT, SIGTERM or SIGHUP during a run (exit 130)
  | 'unexpected';         // anything else (exit 1)

interface Left {
  target: 'missing' | 'empty' | 'unchanged' | 'partial' | 'complete' | 'split' | 'unknown';
  backup?: string;    // where the person's files are, all or some of them
  temp?: string;      // a temporary folder that couldn't be deleted
  running?: true;     // pnpm may still be running
}

type Outcome =
  | { ok: true; kind: 'created'; plan: RunPlan; result: RunResult; warnings: Problem[]; left: Left }
  | { ok: true; kind: 'checked'; pnpm: PnpmStatus; warnings: Problem[] }   // --check
  | { ok: false; error: Failure; left?: Left; retry?: string[] };          // warnings, retry: part 2

interface Failure {
  code: ErrorCode;
  title: string;
  lines: string[];
  fixes: Fix[];                        // part 2; empty until then
  required?: Record<string, string>;   // part 2
  found?: Record<string, string>;      // part 2
}
// Problem and Fix: see "Carried to part 2".
```

**`left` is absent** when the run never reached the disk: a usage error, `--check`, the refused folder, a cancelled prompt (every prompt comes before `run()`). Nothing on disk is read to build it, so a strange path can't turn exit 2 into a crash.

`--help` and `--version` stay outside the `Outcome`: they print text and exit 0 (Decisions 3).

**Exit codes**, decided by `exitCode(outcome)` only: 0 ok · 2 `usage` · 3 `pnpm-too-old`, `pnpm-switch-failed` · 4 `install-failed` · 130 `cancelled`, `interrupted` · 1 everything else, **including any code `exitCode` doesn't know**.

**How a failure gets its code:** `codeOf(error)` returns the error's `code` only when it is one of the CLI's own (`ERROR_CODES.has(code)`), else `unexpected`. Node's errors carry codes like `ENOSPC` or `EACCES`; without the membership check, a full disk would be classified as `'ENOSPC'`, map to no exit code, and the CLI would exit 0. `CliError` sets a code; `LockfileError`, `NameError` and `CancelledError` keep their classes, names and messages and gain a `code` property. A plain `Error` from spawning the install (for example cmd.exe refusing an argument) stays `unexpected`: exit 4 is for an install that ran and failed.

**How a failure gets its text:** exactly as today's `report()` (`main.ts`). A `CliError` (`ToolchainError`, `RunError`) renders `title` and `lines`; any other error renders its message split on newlines, first line as the title, the rest as lines. An empty message renders an empty title: `report()`'s `'Something went wrong'` default never applies, because `''.split('\n')` is `['']`. Task 0 pins that, and this plan keeps it. A `LockfileError` keeps that split rendering.


## What the run left behind

`leftBehind(phase, before, read)` is synchronous: the interrupt handler calls it just before `process.exit`, and `run()`'s `catch` calls it for a failure. It combines:

- **The phase**, which `run()` already tracks: `working`, `backing-up`, `backed-up`, `moving`, `moved`. It says which step was running.
- **`before`:** the target's state when `run()` started (`missing`, `empty` or `not-empty`), read once with `targetState` inside `run()`'s `try`.
- **`read(path)`:** a synchronous read of one path: `missing`, `empty`, `not-empty` or `unreadable`. It `lstatSync`s first: anything that exists and isn't a directory (a target that is a file, which `--force` allows) is `not-empty`; a directory is `empty` or `not-empty` by `readdirSync`; any other error is `unreadable`. It is `RunDeps.probe` and never throws.
- **The backup path.** `backUp` reports the path it actually chose (with its `-N` suffix) through `deps.onPath?(backup)`: after the free name is found and, for an in-place backup, after `mkdir(candidate)`, before anything moves. Until then the phase has **no** backup path for `leftBehind`: the base name may be an earlier backup holding none of this run's files. `cancelMessage`'s text still uses `backupPath(target, now)` until `onPath` fires, as today.

The disk is the truth; the phase only says which question to ask it. A rename the handler couldn't stop has either landed or not, and the read sees which. (Between the read and the process ending there is a window of microseconds in which a rename can still land. That is accepted and noted in the Risk register.)

| Phase | `read(target)` | `read(backup)` | `target` | `backup` |
| --- | --- | --- | --- | --- |
| `working` | not read | not read | from `before` (`not-empty` → `unchanged`) | none |
| `backing-up`, before `onPath` | not read | not read | `unchanged` | none |
| `backing-up` or `backed-up` | `not-empty` | `missing` or `empty` | `unchanged` | none |
| `backing-up` or `backed-up` | `not-empty` | `not-empty` | `split` | the path |
| `backing-up` or `backed-up` | `missing` or `empty` | `not-empty` | `missing` or `empty` | the path |
| `moving` | `missing` or `empty` | — | `missing` or `empty` | the path if `read(backup)` is `not-empty` |
| `moving`, `before` was `missing` or `empty`, or there is a backup | `not-empty` | — | `partial` (today's text: "may be incomplete") | the path if `read(backup)` is `not-empty` |
| `moving`, `before` was `not-empty` and no backup | `not-empty` | — | `unchanged` (`moveIntoPlace` refuses a folder with files before moving anything) | none |
| `moved` | not read | — | `complete` | the path if there is one |
| any | `unreadable`, or a combination not listed | | `unknown` | the path if `read(backup)` is `not-empty` |

For a failure, `temp` is set when `read(temp)` isn't `missing` after the guarded cleanup; for an interrupt, from the handler's `{ removed, stopped }` (`temp` unless removed, `running` unless stopped).

`cancelMessage` keeps today's text, taking the backup's basename from the phase.

"Backed up" and "Moved" can't be reached by a signal (no `await` between setting those phases and the next step), nor by a failure (`moving` is set before `moveIntoPlace` runs, and nothing after `moved` can throw). Their rows are tested as mappings with a fake `read`.


## File structure (in `packages/cli/`)

| File | Change |
| --- | --- |
| `src/outcome.ts` | **New.** The types above, `ERROR_CODES`, the exit-code constants (moved from `main.ts`), `exitCode`, `codeOf`, `CliError` |
| `src/report.ts` | **New.** `renderText(outcome, ui)`: today's `report()` and `usage()` output, moved from `main.ts` |
| `src/main.ts` | `MainIo.runDeps` (Task 0); `execute(argv, io): Promise<Outcome>`; `main` = `execute`, render, `exitCode` |
| `src/run.ts` | `RunDeps.backUp`, `.rm` (Task 0), `.probe`, `.onOutcome`; `RunPlan.folder` (optional: as given); `leftBehind`; `leftOf(error)`; guarded cleanup; the interrupt handler builds and renders an interrupted `Outcome`; `RunError` codes |
| `src/workspace.ts` | `backUp`'s `onPath` callback; both of `backUp`'s throw sites carry `code: 'backup-failed'` |
| `src/pnpm.ts` | `ToolchainError` extends `CliError`; `tooOld` and `switchFailure` set their codes |
| `src/lockfile.ts`, `src/names.ts`, `src/ui.ts` | `LockfileError`, `NameError`, `CancelledError` gain a `code` property |
| `test/outcome.test.ts`, `test/report.test.ts` | **New.** |
| `README.md`, `AGENTS.md` | Exit code 4; the code 1 row; the two new modules in AGENTS.md's module map |


## Review Focus

1. **Text drift.** Any edit to an expected string or call sequence from Task 0 is a regression, not an update. The intended changes have their own tests (Global Constraints).
2. **Interrupts.** Every phase still prints its message and exits 130, including when reading the disk or `onOutcome` throws. The handler deletes nothing but an empty backup folder this run created. A bug here leaves a person's files somewhere the message doesn't say, or exits 0 after a Ctrl-C.
3. **`left` against the disk.** Each reachable row is tested by stopping a real `run()` (the real `backUp` and `moveIntoPlace`, with a failing `rename`) and comparing `left` with `readdirSync` of the target and the backup.
4. **No failure exits 0.** A Node error with its own `code` is `unexpected` and exits 1.
5. **Exit 4 is narrow.** Through `main`: a lockfile change exits 1, a failed `git init` warns and exits 0, a failed move after a backup exits 1.


## Task 0: pin today's output, and the seams the tests need

Lands first, on today's code, with no behavior change.

**Files:** Modify `src/main.ts`, `src/run.ts`, `test/main.test.ts`, `test/cli.test.ts`, `test/run.test.ts`.

- [ ] **Step 1: Seams,** each a no-op when absent:
  - `MainIo.runDeps?: RunDeps`, passed to `run(plan, ui, io.runDeps)`;
  - `RunDeps.backUp?: typeof backUp`;
  - `RunDeps.rm?: typeof rm`, used by `run()`'s cleanup.
- [ ] **Step 2: Failure fixtures use the real functions.** A failing backup is the real `backUp` with a `rename` that fails on its Nth call with `EIO` (not retried, unlike `EPERM`/`EBUSY`/`EACCES`), with `cwd` set to the target for the in-place cases; the same for `moveIntoPlace`. So the pinned text is `backUp`'s and `moveIntoPlace`'s own, and the disk is real.
- [ ] **Step 3: Exact text through the built CLI** (`cli.test.ts`, `plainUi`, `NO_COLOR`), asserting exact stderr and stdout (regexes only for versions and seconds):
  - an unknown flag, with stdout empty;
  - a bad folder name and a bad scope with `-y` (`!!!`, `--scope '@a b'`);
  - the refused non-empty folder: exact stderr, and the intro line on stdout;
  - a successful `--no-install` run: the full stdout, in order.
- [ ] **Step 4: Exact `Ui` call sequences through `main`** (`main.test.ts`, recording `Ui` capturing titles and lines):
  - bad scope and bad folder when interactive (exact stderr);
  - a cancelled prompt: `['intro', 'fail: Cancelled. Nothing was written.']`, exit 130;
  - each `--check` result with its full `[title, ...lines]`: ready, pnpm missing, too old, switch failed;
  - a success: `intro`, the steps, then `outro` exactly once;
  - through `runDeps`: a failed install, a lockfile change (title `Lockfile changed during install:` with the `+ …` lines), a failed move with and without a backup, a failed backup on the first entry, on a later entry and on a whole-folder rename, an error with an empty message (an empty title, see "How a failure gets its text"), and a `generate` that throws a string (rendered with `String(error)`);
  - `interactive: true` without `io.ui` selects `clackUi`: a fake prompt that cancels, and a spy on `process.stdout.write` seeing clack's `┌` intro.
- [ ] **Step 5: The interrupt messages not pinned today** (`run.test.ts`, "on Ctrl-C"): backing up in place and not in place, moving without a backup, and the mixed `removed`/`stopped` cases. The `rename` fake fires the interrupt and returns a promise that never settles, as a real `process.exit` would; the test asserts the `Ui` calls without awaiting `run` (the pattern of the existing "on Ctrl-C" tests). So Task 3's handler, which may remove an empty backup folder, can't make a later step fail and force an edit.
- [ ] **Step 6: `--check` errors outside `main`'s `try` reject today.** An `exec` that throws **synchronously** (a rejecting `async` one is caught by `detectPnpm` as "pnpm missing") makes `main` reject. Pin that. (`check()`'s rethrow at `main.ts` needs `mkdtemp` to fail and has no seam; it isn't pinned.)
- [ ] **Step 7:** Full CI sequence. Expected: all new tests pass on today's code.
- [ ] **Commit:** `test: pin the CLI's output on every exit path`


## Task 1: error codes and exit codes

**Files:** Create `src/outcome.ts`, `test/outcome.test.ts`. Modify `src/pnpm.ts`, `src/run.ts`, `src/workspace.ts`, `src/lockfile.ts`, `src/names.ts`, `src/ui.ts`, `src/main.ts`.

- [ ] **Step 1:** `CliError(code, message, lines)`, `ERROR_CODES` and `codeOf` in `outcome.ts`. `ToolchainError` and `RunError` extend `CliError`. `LockfileError`, `NameError` and `CancelledError` gain a `code` property, keeping their classes, `name` and message. Both of `backUp`'s throw sites (the in-place loop's wrapped error, and the whole-folder rename's raw error) get `code: 'backup-failed'` without changing their messages. An `lstat` error in the free-name lookup stays `unexpected`.
- [ ] **Step 2:** `exitCode(outcome)`, falling back to 1. Move `USAGE`, `FAILURE`, `TOOLCHAIN`, `INTERRUPTED` from `main.ts`; `main.ts` re-exports `FAILURE` and `TOOLCHAIN` (imported by `cli.ts` and `main.test.ts`). If knip flags the re-export, import from `outcome.ts` in those two files instead.
- [ ] **Step 3: Tests.**
  - `exitCode` against a `Record<ErrorCode, number>` literal of numbers (2, 3, 4, 130, 1), not the constants, so a new code without an entry fails typecheck; and an unknown code gives 1.
  - `codeOf` of `Object.assign(new Error('disk full'), { code: 'ENOSPC' })` is `unexpected`.
  - Each source sets its own code: `tooOld(...)` → `pnpm-too-old`, `switchFailure(...)` → `pnpm-switch-failed`, a `LockfileError`, a `NameError`, a `CancelledError`, and the real `backUp` failing in place and on a whole-folder rename → `backup-failed`.
- [ ] **Step 4:** Full CI sequence. Expected: Task 0's tests unchanged and passing.
- [ ] **Commit:** `refactor: give every failure a code`


## Task 2: exit 4 for a failed install

**Files:** Modify `src/run.ts`, `src/main.ts`, `test/run.test.ts`, `test/main.test.ts`, `README.md` (Exit codes), `AGENTS.md` (Exit codes line); add a minor changeset (Decisions 2).

- [ ] **Step 1: Failing tests.**
  - `run()` with a fake exec whose `pnpm install` exits 1 rejects with code `install-failed`; the same for `--no-install` (`--lockfile-only`) and for `kind: 'none'` (`npm exec`).
  - Through `main` with `runDeps`: a failed install returns 4; a lockfile change returns 1; a failed `git init` warns and returns 0; a failed move after a backup returns 1; a fake `generate` throwing an `ENOSPC` error returns 1.
- [ ] **Step 2:** The install's `RunError` takes `install-failed`; the move failure after a backup takes `move-failed`. A move failure without a backup is rethrown as today, with `code: 'move-failed'` set on it and its message and rendering unchanged. `report()` maps an error through `codeOf` and `exitCode`.
- [ ] **Step 3: README.**
  - Add `| 4 | The install failed; retrying may work. Nothing was created |`.
  - Change code 1's text: "Something failed; the message says what, and where any of your files are".
- [ ] **Step 4:** Full CI sequence. Expected: Task 0's text unchanged; only the exit code differs for a failed install.
- [ ] **Commit:** `feat: exit 4 when the install fails`


## Task 3: what the run left behind, and one Outcome for every exit

**Files:** Create `src/report.ts`, `test/report.test.ts`. Modify `src/main.ts`, `src/run.ts`, `src/workspace.ts`, `test/main.test.ts`, `test/run.test.ts`, `test/workspace.test.ts`.

- [ ] **Step 1: `backUp` reports its path.** `deps.onPath?(backup)`, called once the free name is found (and, in place, after `mkdir`), before anything moves. Tests (`workspace.test.ts`): with the base name taken, it reports the `-1` path; in place, the folder exists when `onPath` is called.
- [ ] **Step 2: Phases and `leftBehind`.** `run()` reads `before` inside its `try`. The `backing-up` phase is set before `backUp` with `backupPath(target, now)` and updated by `onPath`. `leftBehind` implements the table, with `RunDeps.probe` as `read`. `leftOf(error)` returns the `left` `run()` recorded for that error (a `WeakMap`, so the thrown value itself is untouched; recorded only when the error is an object, since a primitive can't be a key and `WeakMap.set` would throw over the run's own error). `RunPlan.folder` is set by `planFromOptions` and optional; `run.test.ts`'s `planFromOptions` exact match gains `folder` (Global Constraints). Test: a Ctrl-C while backing up, with `<name>.backup-<stamp>` already taken, names the `-1` folder.
- [ ] **Step 3: Guarded cleanup.** In `run()`'s `catch`, `rm(temp)` (through `RunDeps.rm`) gets `maxRetries` like the interrupt path, and a failure to remove is caught: `left.temp` is set and the run's own error is rethrown. Test: a `rm` that fails after a failed install gives the install's title, exit 4, and `left.temp`.
- [ ] **Step 4: The interrupt handler.** Inside today's `try`, in this order:
  1. `ui.stop()`;
  2. `left = leftBehind(...)`, in its own `try`: if it throws, `left` is `{ target: 'unknown' }` and the run goes on, so the message still prints;
  3. build the interrupted `Outcome` from `cancelMessage` and `left`, and `renderText` it: the person sees today's message whatever step 2 did;
  4. `RunDeps.onOutcome?(outcome)`, in its own `try`;
  5. change 3: only for an in-place backup whose `onPath` has fired, `rmdirSync` the backup folder if `read` finds it empty, in its own `try` (a rename landing in between makes it throw `ENOTEMPTY`, which deletes nothing).
  
  `process.exit(130)` stays in the `finally`. (The synchronous write for pipes is part 2.)
- [ ] **Step 5: `execute(argv, io)`** returns an `Outcome` from every path `main` handles today: usage errors (`code: 'usage'`, no `left`), the refused folder (`target-not-empty`, no `left`), a cancelled prompt, `--check` (`kind: 'checked'`), success (`kind: 'created'`), and any error thrown inside the `try`, with `left` from `leftOf`. Errors thrown outside it, from `check()`, `gitIdentity` and `planFromOptions`, still reject, as Task 0 Step 6 pins (Carried to part 2). `main` renders with `renderText` and returns `exitCode`.
- [ ] **Step 6: `renderText(outcome, ui)`:** usage errors as one stderr line (today's `usage()`), failures as today's `report()`, success as `ui.outro`.
- [ ] **Step 7: Tests against the disk,** with the failure fixtures from Task 0 Step 2. For each reachable row, stop a real `run()` in a temp folder and compare `left` with `readdirSync` of the target and the backup:
  - a toolchain failure with `replace: true` on a non-empty target: `unchanged`, no `backup`, `notes.txt` intact;
  - a failed install: `before`'s state, no `temp`;
  - a non-empty target without `replace` ("never touches a non-empty target"): `unchanged`;
  - backup failing on the first entry, in place: `unchanged`, no `backup`, no backup folder on disk;
  - backup failing on a later entry: `split`, `backup` holding exactly the moved entries;
  - backup failing on a whole-folder rename: `unchanged`, no `backup`;
  - move failing after a backup, before any entry moved: `missing` or `empty`, with `backup`;
  - move failing partway into an empty target: `partial`;
  - an interrupt in each reachable phase, through `onOutcome`: `left` as the table says, including one fired from the `rename` fake after the rename has landed (so progress would have been one behind), which reports the backup.
  
  Plus `leftBehind` with a fake `read` for every table row, `unreadable` giving `unknown`, and a target that is a file (`--force` on a file): after the rename, `missing` with `backup`.

  Change 3, both directions: interrupted in place before the first entry moves, the backup folder is gone; interrupted after one entry moved, the backup folder and its entry are still there; interrupted before `onPath` with an empty earlier `<name>.backup-<stamp>` present, that folder is still there.
- [ ] **Step 8: Codes on every exit that shares exit 1.** `execute` Outcomes: `target-not-empty`, `backup-failed`, `move-failed` with and without a backup, `lockfile-changed`, `install-failed`, `unexpected` from a plain `Error` in `generate` and from an `ENOSPC` error, `cancelled`, and `usage` from a `NameError`.
- [ ] **Step 9: The interrupt can't exit 0, and still prints.** Fired from the `rename` fake while backing up and while moving (so `leftBehind` does read the disk), with a `probe` that throws: the test asserts `probe` was called, the `fail:` call with today's message, and exit 130. An `onOutcome` that throws: the same.
- [ ] **Step 10:** Full CI sequence and `pnpm test:e2e`. Expected: Task 0's tests unchanged.
- [ ] **Commit:** `refactor: build one outcome for every exit, with what the run left behind`


## Risk register

| Risk | Where | Guard |
| --- | --- | --- |
| Text drifts on a path no test pins | every exit | Task 0 pins every path first |
| A person is told their files are somewhere they aren't | `left`, `cancelMessage` | the disk is read, not inferred; Task 3 Step 7 tests against the disk |
| A rename lands between the disk read and the process ending | the interrupt handler | accepted: a window of microseconds. The read happens as late as possible, right before `process.exit` |
| A failure exits 0 | `codeOf`, `exitCode` | membership check and fallback to 1; Task 1 Step 3, Task 2 Step 1 |
| A Ctrl-C exits 0 | the interrupt handler | `process.exit` stays in `finally`; Task 3 Step 9 |
| The cleanup's error hides the run's error (Windows file locks) | `run()`'s `catch` | Task 3 Step 3 |
| Exit 4 is released and can't be pulled back | the release | npm publishing is on (`NPM_PUBLISH` is `true`): merging the version PR publishes. Undoing it means another release that changes exit codes again, so decide before merging that PR |
| Windows signal paths | interrupts | the e2e interrupt tests skip win32; Windows relies on the unit tests |

**Rollback:** revert the PR. Before the version PR merges, nothing is released. After, revert and release a patch, knowing scripts see exit codes change twice.


## Decisions

1. **The refused non-empty folder keeps exit 1.** The first version of #21 said "2 (usage, including a refused folder)", but the CLI exits 1 and `cli.test.ts` pins it. It gets the code `target-not-empty`; changing the exit code is a separate decision.
2. **The changeset for exit 4 is minor.** It adds a documented exit code: a script that tests for exactly 1 after a failed install sees 4. (#33 was a patch because it fixed behavior that contradicted the docs.)
3. **`--help` and `--version` stay outside the `Outcome`.** #21 lists `--help --json` as not needed; whether `--version --json` prints an object is part 2's call.
4. **The disk, not progress counts, says what was left behind.** Progress callbacks lag a rename the interrupt handler couldn't stop; a synchronous read at the end doesn't. Only the chosen backup path is reported ahead of time, because the read needs to know where to look.


## Carried to part 2

These are visible only through `--json`, so they are designed and tested with the serialization and `schemaVersion` that expose them, not ahead of it.

- **Errors outside `main`'s `try`** (`check()`'s rethrow, `gitIdentity`, `planFromOptions`) still print a stack trace from `cli.ts`. Under `--json` they need an object too.
- **Fixes on the pnpm failures.**
  - `tooOld`: `required { pnpm: '>=10.26' }`, `found`, fix `{ argv: ['npm', 'install', '-g', 'pnpm'], scope: 'user' }`.
  - `switchFailure` with an installer: `{ argv: ['node', installer], scope: 'user' }`; without one: `{ see: PNPM_HELP, scope: 'user' }`; `required { pnpm: '<pin>' }`, `found`.
  - Text renders from the fixes from then on, so the two can't drift.
- **Warnings** from `RunResult`: `pnpm-missing` (fix `npm install -g pnpm`, scope `user`), `git-missing`, `git-failed`, `git-no-identity`.
- **Safe retries.**
  - A retry is offered only when the error is one a retry can fix (`pnpm-too-old`, `pnpm-switch-failed` after the fix, `install-failed`, `interrupted`) and `left` shows nothing changed: `target` is `missing`, `empty` or `unchanged`, no `backup`, no `temp`, not `running`. `unknown` never gets a retry.
  - The retry is the CLI's arguments rebuilt from the resolved plan, never the original argv: the folder as given, `-y`, `--scope`, `--examples`, `--no-git` / `--no-install` when off, and `--force` only while the target is still non-empty and the person had chosen to replace it.
  - Tests: no retry for every unsafe `left` and for codes a retry can't fix; `--force` kept only while the target is non-empty and `plan.replace` is set; `--no-git`, `--no-install` and `--examples` written from the plan.
  - Windows: the retry is an argv, so nothing is quoted in `outcome.ts`; part 2 decides how text shows it.
- **The interrupted object reaching a pipe:** write it synchronously before `process.exit`.
- **A `ctms-pnpm-*` folder left in the OS temp folder** when an interrupt lands during `checkSwitch` (its `finally` never runs). Already true today; report it in `left` or clean it in the handler.
