# AGENTS.md

This repository builds `create-ts-monorepo-starter`, a CLI that generates TypeScript monorepos from the [ts-monorepo-starter](https://github.com/prosdevlab/ts-monorepo-starter) template: `pnpm create ts-monorepo-starter my-tools` (also `npm create`, `yarn create`, `bun create`). The design and plans are in `docs/`. The repository itself was created from that template and keeps its toolchain. `CLAUDE.md` imports this file, so these instructions are the single source for every agent.

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

`packages/cli` is the `create-ts-monorepo-starter` package: a bin entry, a Node target and a test that runs the built command. `docs/` holds the design and plans.

Each package has its own `package.json`, `tsconfig.json`, and `src/` directory. Packages aren't marked private, so previews include them.

## Setup Commands

```bash
# Install dependencies (required first step)
pnpm install

# Build all packages (required before typecheck)
pnpm build

# Lint all packages
pnpm lint

# Type check all packages (must run AFTER build)
pnpm typecheck

# Run all tests (runs from root using centralized vitest config)
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

### Working on a specific package

```bash
# Build a specific package
pnpm -F "<package-name>" build

# Watch mode for development
pnpm -F "<package-name>" dev

# Run tests for a specific package (note: tests run from root)
cd packages/<name> && pnpm test:watch
```

### Important: Build Order

**Critical:** Always run `pnpm build` before `pnpm typecheck` because TypeScript needs the built `.d.ts` files from dependencies.

## Testing Instructions

Tests use Vitest with a centralized configuration at the root (`vitest.config.ts`).

- Test files: `**/*.test.ts` or `**/*.spec.ts` in `packages/*/src/`
- Run from root: `pnpm test` (NOT `turbo test`)
- The test script in root package.json runs `vitest run`, not `turbo test`
- Unit tests live next to source (`packages/*/src/*.test.ts`)
- `packages/cli/test/bin.test.ts` runs the *built* command, so `pnpm build` must run before `pnpm test`

**When adding tests:**

1. Place test files next to source files: `src/myModule.test.ts`
2. Import from the source file: `import { MyClass } from './myModule'`
3. Run `pnpm test` from root to verify

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
- Git hooks (Husky): **pre-commit** runs Biome with fixes on staged `.ts`/`.js` files and re-stages them, so a commit can rewrite your files; then `pnpm typecheck` (needs a prior `pnpm build`). **commit-msg** runs commitlint.

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
- `compat` job: build, then the unit tests on Node 22, 24 and 26 × Linux, macOS, Windows. It calls Vitest with `node` directly,
  because pnpm would run it on the pinned Node 26
- Least-privilege `permissions`; every action pinned to a commit SHA with the version in a comment
- `workflows` job: zizmor (version pinned in `ZIZMOR_VERSION`, raised by hand) audits every workflow and fails on
  any finding. Suppress one only with an inline `# zizmor: ignore[rule]` and a comment saying why it doesn't apply
- A new push to a PR cancels that PR's older run; runs on `main` always finish, because they release
- `preview` job: publishes the package as an installable preview (pkg.pr.new) for pushes to main and same-repo PRs,
  and comments the install commands on the PR. Runs only when the repository variable `PKG_PR_NEW` is `true`, never
  for fork PRs, and uses no token: the pkg.pr.new GitHub App authenticates the run
- `e2e` job: generates projects with the built CLI (every combination of examples on Linux, the all-examples project on
  Windows) and runs each project's own CI (`pnpm test:e2e`)
- `fresh-machine` job: runs the built CLI with `-y` on Linux, macOS and Windows with no pnpm, pnpm 9 and pnpm 10
- **Important:** Build runs BEFORE typecheck (required for type definitions)

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
- To enable publishing: see README "Setting Up npm Publishing" (trusted publisher on npmjs.com, `npm` environment)

## Adding a New Package

Copy `packages/cli/` and rename it.

Every package keeps these, or `pnpm check:packages` fails or it publishes broken:

- a `build` script that runs `pnpm run clean` (which deletes `dist` and `build`), `tsc` into `build/`, Rollup into `dist/cli.js`, and the template fetch into `dist/template`. Scripts use `node -e`
  instead of `rm` or `chmod`, so they also run on Windows
- `"engines": { "node": ">=22.13" }` for packages that run on Node, and `@types/node` 22.x if the package needs it
- `"type": "module"` and a `bin` that points into `dist/` (no `exports` map: this is a bin-only package)
- `"files": ["dist"]`: without it, `npm pack` follows `.gitignore` and ships no `dist/`
- the `check:package` script (`scripts/check-package.mjs`: `publint --strict` on package.json and the bundle, minus the bundled template)

Then run `pnpm install` to link it. Vitest picks up `packages/**/*.test.ts` automatically.

## Package Dependencies

Use workspace protocol for internal dependencies:

```json
"dependencies": {
  "<package-name>": "workspace:*"
}
```

Turborepo automatically builds dependencies in the correct order.

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

## Common Patterns

### Running commands in all packages

```bash
pnpm -r <command>  # Run in all packages
turbo <command>    # Run via Turborepo with caching
```

### Filtering specific packages

```bash
pnpm -F "<package-name>" build
pnpm --filter "create-ts-monorepo-starter" test
```

### Checking package locations

```bash
pnpm list --depth 0  # See all workspace packages
```

## Troubleshooting

**TypeScript errors about missing types:**

- Run `pnpm build` first to generate `.d.ts` files
- Check that dependencies are listed in package.json
- Verify workspace links: `pnpm install`

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

- Check dependency order (dependencies build first)
- Clear cache: `pnpm clean` then `pnpm build`
- Remove node_modules: `pnpm clean && pnpm install`

**`ERR_PNPM_NO_MATURE_MATCHING_VERSION`:**

- A version you asked for, or one a dependency needs, was published less than 3 days ago.
- Choose an older version, or wait until it ages. Never add a `minimumReleaseAgeExclude` entry on your own:
  exceptions are for urgent security fixes, approved by a person (README "Dependency Updates").
- If the young version is already in the lockfile, re-resolve (see "Dependencies and the Lockfile").

**CI failures on typecheck:**

- Ensure build step runs before typecheck in workflow
- Local: `pnpm build && pnpm typecheck`

## Security Considerations

- Never commit `.env` files or secrets
- No npm token is stored: publishing uses npm trusted publishing (OIDC), with provenance
- Publishing is off until the repository variable `NPM_PUBLISH` is `true`. Previews (`PKG_PR_NEW`) never run for fork PRs
- CI fails on high or critical advisories (`pnpm audit --audit-level high`); run `pnpm audit` to see every severity.
  GitHub's Dependabot alerts can't read pnpm 12's two-document lockfile, so they miss these dependencies
- Nothing newer than 3 days installs: `minimumReleaseAge` in `pnpm-workspace.yaml` (minutes).
- Agents never add `minimumReleaseAgeExclude` entries. A person may approve one exact version for an urgent security
  fix, with the advisory linked, removed once it is 3 days old (README "Dependency Updates").
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
