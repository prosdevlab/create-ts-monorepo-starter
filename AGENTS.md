# AGENTS.md

This repository builds `create-ts-monorepo-starter`, a CLI that generates TypeScript monorepos from the [ts-monorepo-starter](https://github.com/prosdevlab/ts-monorepo-starter) template: `pnpm create ts-monorepo-starter my-tools` (also `npm create`, `yarn create`, `bun create`). The design and plans are in `docs/`. `README.md` is for people using the CLI; `CONTRIBUTING.md` covers developing it. The repository itself was created from that template and keeps its toolchain. `CLAUDE.md` imports this file, so these instructions are the single source for every agent.

## Project Overview

A modern TypeScript monorepo using pnpm workspaces, Turborepo for build orchestration, Biome for linting/formatting, Vitest for testing, and Changesets for versioning. Nothing publishes until a repository opts in with a repository variable: `NPM_PUBLISH` for npm, `PKG_PR_NEW` for PR previews. Nothing publishes by accident.

**Tech Stack:**

- Package manager: pnpm 12.15.0 (pinned via `packageManager`)
- Language: TypeScript 7.0.2, with a Node 22 preset in `packages/cli` (`@tsconfig/node22`)
- Build: `tsc`, then Rollup
- Build system: Turborepo
- Linter/Formatter: Biome
- Testing: Vitest 5 (run from root)
- CI/CD: GitHub Actions (separate CI and Release workflows)
- Versioning: Changesets
- Node.js for development: >= 26 (LTS; `devEngines.runtime` pins 26.12.1: pnpm downloads it locally, and CI reads the same version from package.json)
- Node.js for the published package: >= 22.13 (`engines.node`); CI runs the unit tests on Node 22, 24 and 26, on Linux, macOS and Windows

## Repository Structure

```
packages/cli/
├── src/                   # the CLI, one module per concern (map below)
├── test/                  # unit tests, one file per module (args.test.ts tests args.ts, ...)
│   └── e2e/               # generates real projects and runs their CI (pnpm test:e2e)
├── scripts/               # fetch-template.mjs (bundles the template at build time), check-package.mjs,
│                          # check-template-release.mjs (the weekly release check)
├── template-version.json  # the template release the build bundles: tag and commit
└── rollup.config.js       # bundles build/cli.js and @clack/prompts into dist/cli.js; no runtime dependencies
```

`docs/demo/` holds the README's recorded demo (`vhs docs/demo/demo.tape`, CONTRIBUTING.md "The README Demo").

### How a run works, module by module

In the order a run touches them:

- `cli.ts`: the bin entry. Calls `main` and sets `process.exitCode`; it never calls `process.exit()`, so output flushes.
- `main.ts`: parses the arguments, asks the questions when interactive, builds the plan, calls `run` and prints the
  result. Exit codes: 0 done, 1 failure, 2 usage error, 130 interrupted.
- `args.ts`: `parseArgv` (`node:util` `parseArgs`) into `Options`; the `lib`, `cli`, `web` example list.
- `names.ts`: folder to package name, and scope normalization.
- `ui.ts`: the prompts (`createAsk`, @clack/prompts), two outputs (clack for terminals; plain for pipes, CI and
  `NO_COLOR`), the help and version text.
- `run.ts`: the orchestration: generate into a temporary folder, `git init`, install, lockfile check, first commit,
  then move into place.
- `template.ts`: where the bundled template is (`dist/template`), its version, the pnpm version from its
  `packageManager`, and the dotfile renames (`_gitignore`).
- `generate.ts`: copies the template; removes unpicked examples and template-only files; applies markers; renames
  `@monorepo/` to the scope; rewrites the identity lines (README, LICENSE). Throws `Template changed: ...` when an
  expected line is missing.
- `markers.ts`: removes `example:NAME` and `template-only` blocks, with the same patterns as the template's
  `scripts/check-examples.mjs`.
- `pnpm.ts`: detects pnpm and picks the install command (pnpm, or `npm exec` with the template's pnpm when none is
  installed; pnpm older than 10.26 is refused). Runs child processes, and stops them and their children on interrupt.
- `lockfile.ts`: `assertLockfileSubset`. The install may remove lockfile entries but never add one.
- `git.ts`: whether the folder is inside a repository, the git identity, init and the first commit.
- `workspace.ts`: temporary and backup paths, the move into place, and the interrupt handler.

### Rules that keep users safe

Each of these is tested. Don't change one without a test that shows the new behavior:

- **Nothing touches the user's folder until the end.** Everything happens in a temporary sibling folder
  (`.<name>.tmp-<hex>`, same volume so the final rename is atomic). An existing folder is moved aside only at the final
  step, and only with `--force` or a Yes; it's never deleted. On failure the temporary folder is removed.
- **Interrupts leave nothing half-done.** SIGINT, SIGTERM and SIGHUP stop pnpm and everything it started (its process
  group; `taskkill /T` on Windows), remove the temporary folder, and report what's left. Child processes run detached
  for this reason.
- **The installed lockfile is a subset of the template's.** Installs run with `--no-frozen-lockfile` (a `CI` variable
  would otherwise make every install fail), so `assertLockfileSubset` is the guard: a version the template didn't test
  never lands.
- **Windows command lines are built by hand.** A bare command name stays unquoted (a quoted one breaks `%~dp0` in npm's
  `.cmd` shims); arguments containing `%`, `"` or a trailing `\` are rejected, because cmd.exe can't quote them
  safely; cmd's 9009 maps to 127, "command not found".
- **A failed first commit only warns.** The files are generated and correct, so the project still moves into place.
- **The first commit uses `--no-verify`.** The generated pre-commit hook runs typecheck, which in a generated project
  needs a build first; this repository's e2e tests already run that project's full CI on the same output.

## Setup Commands

```bash
# Install dependencies (required first step)
pnpm install

# Build: tsc, Rollup and the template bundle (required before pnpm test)
pnpm build

# Lint all packages
pnpm lint

# Type check (no build needed)
pnpm typecheck

# Run the unit tests from the root (needs pnpm build: some tests run dist/cli.js)
pnpm test

# Watch mode for tests
pnpm test:watch
```

```bash
# Pack each package as it would publish and check its layout (publint)
pnpm check:packages

# Unused files, exports and dependencies, and undeclared dependencies (knip; no build needed)
pnpm check:unused

# Clean all build outputs
pnpm clean
```

## Development Workflow

```bash
pnpm -F create-ts-monorepo-starter build   # the same as pnpm build: there is one package
pnpm -F create-ts-monorepo-starter dev     # tsc --watch into build/ (no bundle; run pnpm build before testing)
pnpm test markers                          # only the test files whose path matches "markers"
pnpm test:watch
```

## Testing Instructions

Tests use Vitest with a centralized configuration at the root (`vitest.config.ts`); `pnpm test` runs from the root.

- Unit tests live in `packages/cli/test/`, one file per module: `test/markers.test.ts` tests `src/markers.ts`. Import
  from `../src/<module>`.
- `bin.test.ts`, `cli.test.ts` and `pack.test.ts` run the built `dist/cli.js` or pack the package, so `pnpm build`
  must run before `pnpm test`.
- Modules take their side effects as parameters (`exec`, `prompts`, `cwd`, `generate`, ...), and tests pass fakes.
  Follow that pattern instead of mocking modules.
- `packages/cli/test/e2e/` is separate (`vitest.e2e.config.ts`, `pnpm test:e2e`): it needs the network and takes
  minutes.

## Before Calling Work Done

Run the same sequence CI runs, in this order, and report any failure with its output:

```bash
pnpm install --frozen-lockfile
pnpm audit --audit-level high
pnpm lint
pnpm check:unused
pnpm build
pnpm typecheck
pnpm test
pnpm check:packages
```

`pnpm test:e2e` is also part of CI (it needs the network and takes minutes), so run it, after `pnpm build`, when you
touch generation, markers, the template bundle or the CLI's install steps. `E2E_SUBSETS=lib,cli` runs fewer combinations.

A partial run is not done. If you changed a workflow, also lint it with [actionlint](https://github.com/rhysd/actionlint)
and audit it with [zizmor](https://docs.zizmor.sh/) (`zizmor .github/workflows`); CI fails on any zizmor finding.

## Code Style

- TypeScript strict mode enabled
- Biome handles linting and formatting (config in `biome.json`)
- Run `pnpm lint` to check, `pnpm format` to auto-fix
- Conventional Commits enforced via Commitlint
- Git hooks (Husky): **pre-commit** runs Biome with fixes on staged `.ts`/`.js` files and re-stages them, so a commit can rewrite your files; then `pnpm typecheck`. **commit-msg** runs commitlint.

**Commit message format:**

```
type(scope): description

# Examples:
feat(api): add new authentication method
fix(core): resolve import path issue
chore: update dependencies
```

## CI/CD Workflows

### CI Workflow (`.github/workflows/ci.yml`)

- Triggers: Push to main OR Pull Request to main
- Node version: read from `package.json` (`devEngines.runtime` pins 26.12.1)
- Steps: Install → Audit → Lint → Unused code → Build → Typecheck → Test → Package checks
- `compat` job: build, then the unit tests on Node 22, 24 and 26 × Linux, macOS, Windows, plus Node 22.13.0 (the `engines.node` floor) on Linux. It calls Vitest with `node` directly,
  because pnpm would run it on the pinned Node 26
- Least-privilege `permissions`; every action pinned to a commit SHA with the version in a comment
- `workflows` job: zizmor (version pinned in `ZIZMOR_VERSION`, raised by hand) audits every workflow and fails on
  any finding. Suppress one only with an inline `# zizmor: ignore[rule]` and a comment saying why it doesn't apply
- A new push to a PR cancels that PR's older run; runs on `main` always finish, because they release
- `preview` job: publishes the package as an installable preview (pkg.pr.new) for pushes to main and same-repo PRs,
  and comments the install commands on the PR. Runs only when the repository variable `PKG_PR_NEW` is `true`, never
  for fork PRs, and uses no token: the pkg.pr.new GitHub App authenticates the run
- `e2e` job: generates projects (`pnpm test:e2e`) with the built CLI (every combination of examples on Linux, the
  all-examples project on Windows) and runs each project's own CI
- `fresh-machine` job: runs the built CLI with `-y` on Linux, macOS and Windows with no pnpm, pnpm 9 and pnpm 10

### Template Main Workflow (`.github/workflows/template-main.yml`)

- Triggers: weekly (Monday 06:00 UTC) and by hand; `contents: read` only
- Fails when the template's latest release differs from `packages/cli/template-version.json`
  (`packages/cli/scripts/check-template-release.mjs`), then still builds with `TEMPLATE_REF=main` and runs `pnpm test:e2e`

### Release Workflow (`.github/workflows/release.yml`)

- Triggers: called by CI's `release` job (`workflow_call`) on pushes to main, after every other CI job passes; or a
  manual run on main. Never `workflow_run`: it also fires for fork PRs from a branch named main, running their code
  with write access
- Four jobs: select-mode → version (opens the version PR) or pack → publish
- Publishes with npm trusted publishing (OIDC): no npm token exists; only the `publish` job has `id-token: write`
- **Never publishes by default:** `pack` and `publish` run only when the repository variable `NPM_PUBLISH` is `true`
- To enable publishing: see CONTRIBUTING.md "Setting Up npm Publishing" (trusted publisher on npmjs.com, `npm` environment)

## Taking a New Template Release

The weekly `template-main.yml` fails with `Template vX.Y.Z is out; update packages/cli/template-version.json` when the
template has a newer release. To take it:

1. Set `tag` and `commit` in `packages/cli/template-version.json` (the commit the tag points to:
   `gh api repos/prosdevlab/ts-monorepo-starter/commits/<tag> --jq .sha`). The build refuses a tag and commit that
   don't match.
2. Run `pnpm build`, `pnpm test` and `pnpm test:e2e`. A `Template changed: ...` error means the template changed a line
   `generate.ts` rewrites; a marker error means the template added a marker or file type `markers.ts` doesn't know
   (it mirrors the template's `scripts/check-examples.mjs`). A new or renamed example also needs `EXAMPLES` in
   `args.ts`, `EXAMPLE_DIRS` in `generate.ts` and `PACKAGES` in `run.ts`.
3. Add a changeset (`patch` for a template patch release, otherwise `minor`): users get the new template only through a
   new CLI release.

## Dependencies and the Lockfile

- Pin exact versions (no `^` or `~`), and pick releases at least 3 days old; pnpm enforces the age.
- Read the `pnpm-lock.yaml` diff before committing. Adding or pinning one dependency should not change unrelated
  versions; if it does, restore the lockfile and make the narrower change.
- To deliberately re-resolve everything, delete `node_modules` (root and packages) as well as the lockfile.
  Otherwise pnpm rebuilds from its hidden copy in `node_modules/.pnpm` and nothing is re-resolved.

## Versioning and Changesets

1. Make changes to packages
2. Run `pnpm changeset` to document changes
3. Select packages that changed and semantic version bump
4. Commit the changeset file
5. On merge to main, Changesets creates a version PR
6. Merge version PR to publish (only if the repository variable `NPM_PUBLISH` is `true`)

The package starts at `0.1.0`; follow [Semantic Versioning](https://semver.org/). Add a changeset for every change that
affects users of the CLI.

## Publishing to npm

**Nothing publishes until `NPM_PUBLISH` is set.**

To publish:

1. Each published package needs a free npm name and a `repository` field
   (`{"type": "git", "url": "git+https://github.com/prosdevlab/create-ts-monorepo-starter.git", "directory": "packages/<name>"}`),
   because npm provenance checks it against the publishing repository
2. Set the repository variable `NPM_PUBLISH` to `true` (Settings → Secrets and variables → Actions → Variables)
3. Add a trusted publisher for the package on npmjs.com (repository, workflow `ci.yml`, environment `npm`): npm checks
   the calling workflow, and `ci.yml` calls `release.yml`
4. Release workflow will publish on next version bump; never add an `NPM_TOKEN` secret

## Troubleshooting

**Tests not found:**

- Tests must match `packages/**/*.{test,spec}.ts` pattern
- Run from root: `pnpm test` (NOT from package directory with turbo)

**`ENOEXEC` or "Failed to switch pnpm to v12":**

- A Volta-managed pnpm 10 can't switch itself to pnpm 12 (pnpm 12 is a native binary placed by an install script). Run `volta install pnpm@12.15.0`, or install pnpm with npm: `npm install -g pnpm@12.15.0`.

**`ERR_PNPM_UNSUPPORTED_ENGINE`:**

- The root `engines.pnpm` (`>=12`) refuses a pnpm older than 12 that doesn't switch itself, such as pnpm 9. Install pnpm 12 with `npm install -g pnpm@12.15.0`.
- If the message names Node.js instead, the system Node is older than 26 (`engines.node`) and pnpm ran on it. Use Node 26 or newer, or a pnpm that switches itself to 12.

**`EBADDEVENGINES` from `npm` or `npx`:**

- npm refuses to run in this repository unless Node.js matches `devEngines.runtime` exactly. Run tools through pnpm
  (`pnpm exec`, `pnpm dlx`), which uses the pinned Node.js.

**A package builds but `dist/` is empty or stale:**

- The build script deletes `dist` and `build` and runs `tsc` without `composite`. Don't re-add `composite` or `incremental`: with them, `tsc` can skip writing output after `build` is deleted.

**`ERR_PNPM_IGNORED_BUILDS`:**

- A new dependency has an install script. Decide in `allowBuilds` (`pnpm-workspace.yaml`): `false` unless the package truly needs its script, and a person approves `true`.

**Build failures:**

- `pnpm build` downloads the pinned template from GitHub, so it needs the network. A tag and commit that don't match
  in `template-version.json` fail the build on purpose.
- Start clean: `pnpm clean && pnpm install && pnpm build`

**`ERR_PNPM_NO_MATURE_MATCHING_VERSION`:**

- A version you asked for, or one a dependency needs, was published less than 3 days ago.
- Choose an older version, or wait until it ages. Never add a `minimumReleaseAgeExclude` entry on your own:
  exceptions are for urgent security fixes, approved by a person (CONTRIBUTING.md "Dependency Updates").
- If the young version is already in the lockfile, re-resolve (see "Dependencies and the Lockfile").

## Security Considerations

- Never commit `.env` files or secrets
- No npm token is stored: publishing uses npm trusted publishing (OIDC), with provenance
- Publishing is off until the repository variable `NPM_PUBLISH` is `true`. Previews (`PKG_PR_NEW`) never run for fork PRs
- CI fails on high or critical advisories (`pnpm audit --audit-level high`); run `pnpm audit` to see every severity.
  GitHub's Dependabot alerts can't read pnpm 12's two-document lockfile, so they miss these dependencies
- Nothing newer than 3 days installs: `minimumReleaseAge` in `pnpm-workspace.yaml` (minutes).
- Agents never add `minimumReleaseAgeExclude` entries. A person may approve one exact version for an urgent security
  fix, with the advisory linked, removed once it is 3 days old (CONTRIBUTING.md "Dependency Updates").
- Dependabot (`.github/dependabot.yml`) proposes updates once they're 3 days old and keeps GitHub Actions pinned to commit
  SHAs. Its `cooldown` must equal pnpm's `minimumReleaseAge`, and so must `days` in `.github/zizmor.yml`. It doesn't update `devEngines.runtime`, `ZIZMOR_VERSION` or
  `@types/node` majors: those are raised by hand.
- `@types/node` matches the Node major the code runs on (Dependabot skips its majors): 26.x in the root `package.json`, for the
  tooling on the pinned runtime; 22.x in `packages/cli`, for the oldest `engines.node`. Types for a newer Node let code typecheck
  against APIs its users' Node doesn't have; raise them together.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
