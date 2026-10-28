# create-ts-monorepo-starter

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/create-ts-monorepo-starter.svg)](https://www.npmjs.com/package/create-ts-monorepo-starter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A command-line tool that creates a TypeScript monorepo from the
[ts-monorepo-starter](https://github.com/prosdevlab/ts-monorepo-starter) template: pnpm workspaces, Turborepo, Biome,
Vitest, Changesets, and a CI that publishes to npm with provenance and no stored token. You pick which examples to
keep, and get a project that passes its own CI on the first commit.

![Running npm create ts-monorepo-starter@latest: choosing a folder, the @acme scope and the lib and cli examples, then installing and committing](docs/demo/demo.gif)

## Requirements

- **Node.js 22.13 or later** runs the CLI, with any package manager.
- **pnpm 12** is needed to work in the generated project: building, testing and the git hooks. If pnpm isn't installed, the
  CLI fetches it for the first install. Details are under [pnpm](#pnpm).

## Usage

```bash
npm create ts-monorepo-starter@latest my-tools
pnpm create ts-monorepo-starter my-tools
yarn create ts-monorepo-starter my-tools
bun create ts-monorepo-starter my-tools
```

For scripts, CI and coding agents, pass everything up front and skip the questions:

```bash
npm create ts-monorepo-starter@latest my-tools -- -y --scope @acme --examples lib,cli
cd my-tools
pnpm build && pnpm test
```

With npm, put `--` before the options. pnpm and yarn pass them through without it.

- **What it asks:** the folder, then "Use the recommended setup?". Only if you answer No does it ask for the npm scope, the
  examples, git and the install.
- **What it does:** copies the template, renames the scope, removes the examples you didn't pick, runs `git init`,
  installs, and makes the first commit. If git has no `user.name` or `user.email`, it stages the files and tells you
  instead.
- **Without prompts:** `-y` accepts every default and asks nothing. So does a run where stdin or stdout isn't a terminal.
  Both need the folder argument, or the CLI stops with a usage error.
- **Existing folders:** a folder that already exists and isn't empty is refused. `--force` moves it aside to
  `<folder>.backup-<date>` first. Nothing you own is deleted.
- **Stopping it:** Ctrl-C before the final move leaves nothing behind. If you stop it later, the CLI says what's left.

### Options

| Flag | What it does | Default |
| --- | --- | --- |
| `[folder]` (first argument) | The project folder, which also names the package | required with `-y` or without a terminal |
| `--scope <@name>` | npm scope; lowercased, `@` added if missing; letters, digits, `-`, `.` and `_` only | `@` + the folder's package name |
| `--examples <list>` | `lib`, `cli`, `web`, comma-separated; at least one | all three |
| `--no-git` | Don't initialize git (skipped anyway inside a git repository) | git init and a first commit |
| `--no-install` | Don't install dependencies; the lockfile is still updated | install |
| `--force` | Move a non-empty folder aside first | refuse (asks when interactive) |
| `-y`, `--yes` | Accept every default, ask nothing | ask |
| `-h`, `--help` | Show the help | |
| `-v`, `--version` | Show the CLI and template versions | |

The package name comes from the folder's name, with unsafe characters turned into `-`: `My Tools` becomes `my-tools`. A
name with nothing valid left is rejected. At the prompt, pressing Enter uses `my-ts-monorepo`.

## What you get

A pnpm 12 monorepo with the template's toolchain, CI, release workflow and docs, plus up to three example packages:

- **`lib`** (`packages/shared` and `packages/lib`): a library that depends on a core package, with a service and a logger.
  `shared` always comes with it.
- **`cli`** (`packages/cli`): a command-line package with a `bin`, built for Node.
- **`web`** (`packages/web`): a browser library, usable from a script tag and as an ES module, with browser tests, a size
  limit and accessibility checks.

Nothing publishes until you opt in; the generated README says how, and the CLI's closing checklist lists each step.

### pnpm

The generated project needs pnpm 12, which brings its own pinned Node.js. The CLI itself runs on Node 22.13 or later,
with any package manager:

- pnpm 10.26 or newer switches itself to pnpm 12 for the project, so the install just works.
- No pnpm: the CLI installs with `npm exec` and says that commits need pnpm, with the command to install it.
- pnpm older than 10.26: the CLI stops before installing and prints the upgrade command, because such a pnpm can't
  switch itself to pnpm 12 (pnpm 9 would also ignore the pinned pnpm and rewrite the lockfile).

## Template version

Each release bundles one release of the template, so you get exactly what that release was tested with, offline.
`create-ts-monorepo-starter --version` prints both versions, and the first commit's message names them. A weekly check
tells the maintainers when a new template release is out.

## Problems and security

Report a bug or ask a question in [this repository's issues](https://github.com/prosdevlab/create-ts-monorepo-starter/issues).
Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes. A problem in the generated project's own code
belongs to the [template](https://github.com/prosdevlab/ts-monorepo-starter), which is where its files come from.

## Contributing

Working on the CLI itself? [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, tests, releases and dependency rules. The
design is in [docs/design.md](docs/design.md) and the plans are in [docs/plans](docs/plans).

## License

[MIT](LICENSE)
