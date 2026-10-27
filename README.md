# create-ts-monorepo-starter

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-12.15.0-orange.svg)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A command-line tool that creates a TypeScript monorepo from the
[ts-monorepo-starter](https://github.com/prosdevlab/ts-monorepo-starter) template.

```bash
pnpm create ts-monorepo-starter my-tools
```

`npm create`, `yarn create` and `bun create` work the same way. **The command is coming:** the CLI is still being
built, and nothing is published to npm yet. The design is in [docs/design.md](docs/design.md) and the plans are in
[docs/plans](docs/plans).

This repository was itself created from the template, so it uses the same toolchain.

## Tooling

- [PNPM](https://pnpm.io/) 12 for package management, and to pin the Node.js version
- [Turborepo](https://turbo.build/repo) for the build system
- The TypeScript compiler (`tsc`) builds the package; [TypeScript](https://www.typescriptlang.org/) 7
- [Biome](https://biomejs.dev/) for linting and formatting
- [knip](https://knip.dev/) finds unused files, exports and dependencies
- [Vitest](https://vitest.dev/) for unit testing
- [Commitlint](https://commitlint.js.org/) with Conventional Commits, and [Husky](https://typicode.github.io/husky/) hooks
- [Changesets](https://github.com/changesets/changesets) for versioning and changelogs
- GitHub Actions for CI and npm publishing, installable previews for every PR ([pkg.pr.new](https://pkg.pr.new))
- [zizmor](https://docs.zizmor.sh/) audits the workflows on every PR
- Dependabot updates 3 days after release, and `pnpm audit` in CI

The published package supports Node.js 22.13 and later, tested on Node 22, 24 and 26 on Linux, macOS and Windows. The
repository itself is developed on Node 26.

## Project Structure

```
create-ts-monorepo-starter/
├── .changeset/          # Changesets configuration
├── .github/             # Workflows, Dependabot and zizmor config, issue forms, PR template
├── .husky/              # Git hooks
├── docs/                # Design and plans for the CLI
├── packages/cli/        # The create-ts-monorepo-starter package
├── .editorconfig        # Editor defaults matching Biome's formatter
├── AGENTS.md            # Instructions for coding agents (CLAUDE.md imports it)
├── biome.json           # Biome configuration
├── commitlint.config.js # Commitlint configuration
├── package.json         # Root package.json
├── pnpm-workspace.yaml  # PNPM workspace config (3-day minimum release age)
├── SECURITY.md          # How to report a vulnerability privately
├── tsconfig.json        # Base TypeScript config
├── turbo.json           # Turborepo config
└── vitest.config.ts     # Vitest config
```

## Getting Started

### Prerequisites

- [pnpm](https://pnpm.io/) 12. It downloads the pinned Node.js version itself.
- Any Node.js with npm, to install pnpm. After that, commands run through pnpm use the pinned Node.js 26
  (`devEngines.runtime` in `package.json`).

### Installation

1. Clone this repository
   ```bash
   git clone https://github.com/prosdevlab/create-ts-monorepo-starter.git
   cd create-ts-monorepo-starter
   ```

2. Install pnpm 12, once per machine
   ```bash
   npm install -g pnpm@12.15.0
   ```
   If Volta manages your pnpm, run `volta install pnpm@12.15.0` instead. Otherwise, pnpm 10.26 or newer switches itself to pnpm 12 when you run it here, so you can skip this step. A pnpm that doesn't switch itself to 12 refuses to install here (`ERR_PNPM_UNSUPPORTED_ENGINE`).

   Inside the repository, run one-off tools with `pnpm dlx` or `pnpm exec`. `npm` and `npx` refuse to run unless your system Node.js matches the pinned version exactly.

3. Install dependencies (this also downloads the pinned Node.js)
   ```bash
   pnpm install
   ```

4. Build, then test (the tests run the built command)
   ```bash
   pnpm build
   pnpm test
   ```

### Development Workflow

```bash
pnpm lint            # Biome
pnpm format          # Biome, with fixes
pnpm typecheck       # run after pnpm build
pnpm check:unused    # knip
pnpm check:packages  # publint on the package
```

`pnpm build` runs `tsc` into `build/`, bundles `build/cli.js` into `dist/cli.js` with Rollup, fetches the pinned template
into `dist/template`, then marks `dist/cli.js` executable. `clean` deletes `dist` and `build` first, so files from removed
sources never ship. The package doesn't use `composite`: with it, `tsc` can skip writing anything after `build` is deleted.
`TEMPLATE_REF=<branch> pnpm build` bundles that branch instead of the pinned release.

### Making Changes

1. Create a branch, make your changes, and commit with Conventional Commits (`feat: add new feature`)
2. Add a changeset with `pnpm changeset`
3. Push your branch and open a pull request

### Release Process

Releasing is handled by GitHub Actions when changes are merged to `main`:

1. The workflow runs the checks, tests and build
2. Changesets opens a PR that bumps versions and updates changelogs
3. When that PR is merged, the package is published to npm (only when `NPM_PUBLISH` is `true`)

### Preview Packages

With previews on, every push to `main` and every PR from a branch in this repository publishes the package to [pkg.pr.new](https://pkg.pr.new). A bot comments the install commands on the PR, so anyone can try a change before it's released:

```bash
npm i https://pkg.pr.new/<owner>/<repo>/create-ts-monorepo-starter@<pr-number>
```

Previews aren't npm releases. They aren't versioned and they don't need an npm account. PRs from forks never run the preview job, so a stranger's code is never built and published.

To turn previews on:

1. Install the [pkg.pr.new GitHub App](https://github.com/apps/pkg-pr-new) on the repository or organization.
2. Set the repository variable `PKG_PR_NEW` to `true`: **Settings → Secrets and variables → Actions → Variables**.

The repository is public, so its code is public on pkg.pr.new.

### Setting Up npm Publishing

The package publishes with **npm trusted publishing**: GitHub Actions proves its identity to npm for each release, so no npm token is stored anywhere, and each version gets a **provenance** statement linking it to the commit and workflow that built it (for public packages from public repositories).

The release workflow never publishes until the repository variable `NPM_PUBLISH` is `true`, so nothing publishes by accident. To publish:

1. The package is named `create-ts-monorepo-starter` and its `repository` field points at this repository, because npm provenance checks it against the publishing repository.
2. On npmjs.com, open the package's **Settings → Trusted publishing** and add a GitHub Actions publisher: `prosdevlab`, `create-ts-monorepo-starter`, workflow file `ci.yml`, environment `npm`. (Publishing runs in `release.yml`, which `ci.yml` calls, and npm checks the calling workflow.) A new trusted publisher must complete its first publish within 2 days. If npm won't let you configure a package that doesn't exist yet, publish the first version by hand (`npm publish --access public`, with two-factor authentication), then add the publisher.
3. In the same settings, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working; a leaked token can't publish.
4. In GitHub, under **Settings → Actions → General**, enable **Allow GitHub Actions to create and approve pull requests**, so the workflow can open the version PR. Then set the repository variable `NPM_PUBLISH` to `true` (**Settings → Secrets and variables → Actions → Variables**). Optionally, add required reviewers to the `npm` environment (**Settings → Environments**) to approve each publish.

How a release runs: CI's `release` job calls `.github/workflows/release.yml` on pushes to `main`, after every other CI job passes, against the same commit. Pull requests never reach it, so code from a fork never runs with write access.

```
  push to main ──▶ CI jobs pass ──▶ select-mode                  contents: read
                                       │
                 ┌─────────────────────┴──────────────────────┐
         changesets present                          version PR merged
                 ▼                                             ▼
              version                                        pack       contents: read
     opens "version packages" PR                build, package checks, tarballs
     contents, pull-requests: write                            ▼
     (no npm access)                                        publish     environment: npm
                                                  publishes the tarballs; never builds
                                                  contents: write, id-token: write
```

1. **select-mode** reads the changesets: version, publish, or nothing.
2. **version** (changesets present) opens or updates the "version packages" PR. It can write to the repository but cannot reach npm.
3. **pack** (version PR merged, and `NPM_PUBLISH` is `true`) builds, runs the package checks, and packs tarballs, with read-only access.
4. **publish** publishes those tarballs. It is the only job that can get npm credentials, and it never builds.

### Package Checks

`pnpm check:packages` runs [publint](https://publint.dev) on the package and its bundle (`bin` points at a file that ships); this package has no `exports` or types, so there is nothing for Are The Types Wrong to check. The package lists `"files": ["dist"]`: without it, what ships depends on the tool.

### Unused Code

`pnpm check:unused` runs [knip](https://knip.dev/), and CI runs it on every push. It fails on files nothing imports, exports nothing uses, dependencies nothing imports, and imports of packages a `package.json` doesn't declare. If knip reports something that is used, add a `knip.json` entry for it rather than deleting the code.

### Issues, Pull Requests and Security Reports

Issue forms (`.github/ISSUE_TEMPLATE/`) ask for the version, steps to reproduce and the environment; the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) lists the checks and the changeset. `SECURITY.md` sends vulnerability reports to GitHub's private reporting.

### Dependency Updates

Every dependency is pinned to an exact version, and nothing newer than **3 days** is installed. Freshly published releases are where compromised packages tend to land, and most are caught and pulled within hours to days; waiting means you never install them.

```
  new release on npm
          │
          ▼
  younger than 3 days? ── yes ──▶ pnpm refuses it (ERR_PNPM_NO_MATURE_MATCHING_VERSION)
          │ no
          ▼
  Dependabot PR, Monday, grouped ──▶ CI runs every check ──▶ a person reviews and merges

  urgent security fix, released today
  advisory ──▶ a person approves ──▶ minimumReleaseAgeExclude: pkg@x.y.z ──▶ CI ──▶ merge
                                       └── removed once x.y.z is 3 days old
```

- **pnpm enforces it on every install** (`minimumReleaseAge` in `pnpm-workspace.yaml`, in minutes), including transitive dependencies. `minimumReleaseAgeStrict: true` makes a version that is too new fail the install, with a message naming the setting, instead of falling back to it. pnpm 12 also rejects a misspelled setting, so a typo can't silently turn the rule off.
- **Install scripts are opt-in** (`allowBuilds` in `pnpm-workspace.yaml`). pnpm fails the install when a dependency has a script nobody approved or denied.
- **Dependabot proposes the updates** (`.github/dependabot.yml`): weekly, only once a release is 3 days old (`cooldown`), with minor and patch dev-tool updates grouped into one PR and GitHub Actions into another. It keeps the GitHub Actions pinned to exact commits. Keep its `cooldown` equal to pnpm's `minimumReleaseAge`, or it opens PRs that pnpm refuses, and keep `days` in `.github/zizmor.yml` equal to both: zizmor fails CI on a shorter cooldown. It is built into GitHub: no app to install.
- **Some versions are raised by hand**, because Dependabot doesn't read them: the Node version in `devEngines.runtime`, the zizmor version in `ci.yml` (`ZIZMOR_VERSION`), and `@types/node` majors. Keep `@types/node` on the matching Node major: 26.x in the root `package.json` (the pinned `devEngines.runtime`) and 22.x in `packages/cli` (the oldest `engines.node`). Raise each with its Node version.
- **CI audits every install** (`pnpm audit --audit-level high`) against the npm registry's advisories, and fails on high or critical ones.

**An urgent security fix released today.** The rule allows one exact version through, never a whole package:

1. Confirm the fix is real: a published advisory (GitHub advisory or CVE), a matching changelog entry, and the usual maintainer as publisher.
2. Add that exact version to `pnpm-workspace.yaml`, with the advisory linked, then install and run the full checks:
   ```yaml
   minimumReleaseAgeExclude:
     - somepkg@1.2.4 # https://github.com/advisories/GHSA-...
   ```
3. Remove the entry once the version is 3 days old.

GitHub's Dependabot alerts and security-fix PRs don't cover these dependencies yet: GitHub's dependency graph reads only the first of the two documents in pnpm 12's `pnpm-lock.yaml`, which lists pnpm itself ([dependabot-core#15904](https://github.com/dependabot/dependabot-core/issues/15904)). The `pnpm audit` step in CI is what catches a known vulnerability; run `pnpm audit` to see every advisory, at any severity.

## License

[MIT](LICENSE)
