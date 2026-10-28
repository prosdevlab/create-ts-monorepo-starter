# create-ts-monorepo-starter — Design

Approved 2026-10-27. Implementation plans: [the template changes](plans/2026-10-27-template.md) and [the CLI](plans/2026-10-27-cli.md).

`pnpm create ts-monorepo-starter` gives anyone a working TypeScript monorepo for building CLIs, libraries and browser libraries in under a minute. Pressing Enter accepts sane defaults; flags skip every question. It is a thin layer over the template: it renames, removes what wasn't chosen, and installs. It never adds tools of its own.

## Who it's for

The first user is the maintainer, who knows the stack and wants a new repo in seconds. The second is a developer new to the stack who should still get all of it, set up correctly. Both are often experimenting with building tools, frequently with an AI coding agent doing much of the typing.

They build three kinds of thing, and the template already has an example of each:

| They build | Example package | What it shows |
| --- | --- | --- |
| A command-line tool | `cli` | A bin entry, Node 24+, a test that runs the built command |
| A library other tools use (MCP servers, scripts, SDKs) | `lib` built on `shared` | Typed ES modules, one package depending on another inside the repo |
| A library loaded in web pages by a script tag | `web` | An ES module plus a script-tag build, browser and accessibility tests, a size budget |

**Goals**

- One command with any package manager: `npm create`, `pnpm create`, `yarn create` or `bun create`.
- A working repo in under a minute; Enter-only and flag-only paths give the same result.
- What gets generated is correct for an agent as well as a person: no docs describing removed parts.

**Non-goals for v1**

- Choosing between tool variants (another linter, another bundler).
- Package managers other than pnpm for the generated project; the template requires pnpm 12.
- Updating a project created earlier. That is a later, larger feature.
- Telemetry of any kind.

**Anti-goals** (failure even if it works): a half-written folder after Ctrl-C; a generated repo whose AGENTS.md mentions a package that isn't there; a newcomer's install silently running on the wrong pnpm.

## The experience

The first question is "Use the recommended setup?". Enter accepts every default and leaves only the folder name; No walks through each choice with a one-line hint. Visual designs of each screen are linked at the end of this doc.

**Recommended path**

1. Ask the project folder, unless it was passed as an argument.
2. Ask "Use the recommended setup?" (default Yes).
3. Generate, install and commit, all in a temporary folder (order under "Generating a project"), then move it into place.
4. Print what was created, the next two commands, and the publishing checklist.

**Custom path** (answered No at step 2)

1. npm scope, prefilled from the folder name.
2. Which examples to keep: a multi-select of `lib`, `cli` and `web`, all checked.
3. Initialize git? (Yes)
4. Install dependencies? (Yes)

**Without prompts**

```bash
pnpm create ts-monorepo-starter my-tools -y
pnpm create ts-monorepo-starter my-tools --scope @acme --examples lib,cli --no-install
```

Prompts never appear when stdin isn't a terminal, so CI and agents get the defaults or an error naming the missing flag.

**Rules every path follows**

- Never delete the user's files. A folder that exists and isn't empty is refused; with `--force`, or a Yes to the prompt, it is moved aside to `<folder>.backup-<YYYYMMDD-HHMMSS>` first.
- Work in a temporary folder created next to the target, so the final move is a rename on the same disk. Ctrl-C or an error at any step, the install included, leaves nothing behind.
- Detect the package manager that launched it, and use it in the printed commands only where it matters.
- Respect `NO_COLOR`, and keep every line readable without colour.

**The final checklist** names what the CLI can't do, each pointing to its README section, in this order: run `pnpm build && pnpm test`; turn on previews (install the pkg.pr.new app, set `PKG_PR_NEW`); turn on private vulnerability reporting; when ready to publish, add a repository field to each package (npm provenance checks it), then the npm trusted publisher (`ci.yml`) and set `NPM_PUBLISH`. Publishing comes last, so experimenters don't read it as a required step.

## Defaults and options

Every choice has a default good enough that the maintainer would accept it unchanged, and a flag that sets it.

| Choice | Default | Flag | Notes |
| --- | --- | --- | --- |
| Project folder | `my-ts-monorepo` (prompted) | first argument | Becomes the package name, unsafe characters turned into `-` (`My Tools` becomes `my-tools`); rejected only if nothing valid remains. Required with `-y` or without a terminal; the default is the prompt's placeholder |
| npm scope | `@<folder name>` | `--scope @acme` | Lowercased, `@` added if missing; letters, digits, `-`, `.` and `_` only (the default is `@` + the folder's package name); nothing publishes until `NPM_PUBLISH` is set |
| Examples | all: `lib`, `cli`, `web` | `--examples lib,cli` | At least one; `lib` always keeps `shared` |
| git | init + first commit | `--no-git` | Skipped when already inside a git repo |
| Install | yes | `--no-install` | See "Installing on any machine" |
| Accept all defaults | no | `-y`, `--yes` | Also implied when stdin isn't a terminal |
| Overwrite a non-empty folder | refuse | `--force` | Asked interactively instead of refusing |
| Template version | the one this CLI release was built with | none in v1 | Printed in the header |

`--help` lists every flag; `--version` prints the CLI version and the template version it carries.

## Installing on any machine

The CLI itself runs on Node 22.13 and later (the first 22.x whose `styleText` respects `NO_COLOR`; to verify) with any package manager; the generated project needs pnpm 12, which brings its own pinned Node 26. A spike on a fresh machine (Node 24.12.0, npm 11.6.2, empty home folder) on 2026-10-27 set these rules.

| pnpm on the machine | What happens | What the CLI does |
| --- | --- | --- |
| 10.26 to 11.x (tested 10.26.2, 10.30.0, 10.33.0, 10.34.8, 11.28.8) | Switches itself to 12.15.0 from `packageManager` and installs | Runs `pnpm install` normally |
| 10.0 to 10.25 | Can't switch itself to pnpm 12 | Treated like 9.x: stops before installing and prints the upgrade command |
| 9.x or older (tested 9.15.9) | Without a guard, installs with itself: ignores the pinned pnpm, the 3-day rule and the pinned Node, and rewrites the lockfile | Stops before installing and prints the upgrade command. The template's new `engines.pnpm >=12` makes pnpm 9 fail with `ERR_PNPM_UNSUPPORTED_ENGINE` too |
| None | Can't install | Installs with `npm exec --package=pnpm@12.15.0 -- pnpm install --dir <folder>` from the parent folder (20 s on a cold machine, downloads Node 26.12.1), then says commits need pnpm and prints `npm install -g pnpm` |

Two facts shape this. npm and npx refuse to run inside the project unless the system Node matches the pinned 26.12.1 exactly, so the fallback must run from outside the folder. And the git hooks call `pnpm`, so a machine without a global pnpm fails the user's first commit after creation (the CLI's own commit skips the hooks); the CLI says so instead of hiding it.

Not yet tested: Windows; pnpm installed through Homebrew, Corepack or pnpm's standalone installer; Volta, whose pnpm setup caused the earlier `ENOEXEC` failure.

## Generating a project

The template's files are bundled into each CLI release at build time, so a user gets exactly what that release was tested with, offline, from a package with provenance. Downloading from GitHub at run time would skip that check and need the network.

```
build time:  template release tag ──▶ fetch at the pinned tag and commit ──▶ bundle into the CLI package
run time:    bundled files ──▶ temporary folder ──▶ copy · rename · remove · git init · install · commit ──▶ move into place
```

The run-time steps are mechanical:

1. **Copy** the bundled files into a temporary folder next to the target.
2. **Rename the scope** everywhere it appears: package names and workspace dependencies, root tsconfig paths, vitest aliases, imports in source and tests, and the docs. The template's scope is fixed as `@monorepo`.
3. **Replace the template's identity**: the root package name and the README's clone URL and folder tree become the folder name; the bug form's `@monorepo/core 0.1.0` placeholder uses the new scope; the LICENSE holder comes from `git config user.name`, or `[YOUR NAME]` when unset.
4. **Remove an unchosen example**: delete its package folders, then every block between its markers, including its CI steps. Markdown uses `<!-- example:web -->` … `<!-- /example:web -->`, YAML `# example:web` … `# /example:web`, and TypeScript, JavaScript and JSONC config (`tsconfig.json`, `vitest.config.ts`) `// example:web` … `// /example:web`. So the CLI edits no JSON keys; a file that can't hold comments moves into its example's folder instead.
5. **`git init`**, then **install** with `pnpm install`: the `prepare` script installs the git hooks, and the lockfile drops the removed packages and takes the new names. It should keep every remaining version as locked; that needs checking.
6. **Commit** everything as `chore: initial commit from create-ts-monorepo-starter 0.1.0 (template v2.3.0)`, a conventional message the commit-msg hook accepts, with `--no-verify`: the pre-commit hook runs typecheck, which needs a build first, and the CLI's tests already ran every check on this exact output.
7. **Move** the temporary folder into place.

With `--no-install`, step 5 runs `pnpm install --lockfile-only` instead: the lockfile takes the new names without installing anything, and the git hooks aren't installed until the project's first `pnpm install`. The final message says so.

## Libraries and build

The published package is one bundled file with zero runtime dependencies, so `npm create` downloads one small tarball and starts. Seven of 14 popular `create-*` tools ship this way (checked on npm, 2026-10-27).

| Need | Choice | Why |
| --- | --- | --- |
| Prompts | [@clack/prompts](https://www.npmjs.com/package/@clack/prompts) 1.x | Used by create-vite, sv, create-solid, create-qwik, create-tsdown; handles cancel cleanly |
| Flags | `node:util` `parseArgs` | Built into Node; the template's `cli` example already uses it |
| Running pnpm and git | `node:child_process` `spawn` | No dependency needed for a handful of commands |
| Colour | `node:util` `styleText` | Built in, respects `NO_COLOR` |
| Bundling | Rollup, the template's own bundler | One ESM file, with the bundled packages' MIT notices collected into the output |
| Repo shape | Created from the template | Dogfoods the `cli` example, real npm publishing, previews and the release workflow |

The repository is `prosdevlab/create-ts-monorepo-starter`, separate from the template, so template copies never inherit the CLI. It publishes unscoped as `create-ts-monorepo-starter` through npm trusted publishing with provenance.

## Template changes first

The CLI removes and renames; it never edits code it doesn't understand. That only works if the template is shaped for it, so these landed in the template first.

| Change | Release | Why |
| --- | --- | --- |
| Root `engines.pnpm >=12` | v2.1.1 | pnpm 9 otherwise installs silently with the wrong pnpm, Node and release-age rule |
| Correct the pnpm 10 advice in README and AGENTS.md | v2.1.1 | pnpm 10.26+ switches to 12 on its own; the `ENOEXEC` failure was Volta's setup |
| Rename to `ts-monorepo-starter` | v2.1.1 | Already planned |
| Examples named by role: `lib` + `shared` (was `core` → `utils` → `feature-a`), `cli`, `web` | v2.2.0 | Names read well from day one; two library packages still show one depending on the other |
| Markers around every example-specific block in README, AGENTS.md and config | v2.2.0 | Lets the CLI remove a removed example's docs and CI steps mechanically |
| A check in the template's CI that every marker opens and closes | v2.2.0 | A broken marker would make the CLI cut the wrong text |
| Dependabot in place of Renovate; `pnpm audit` in CI | v2.3.0 | No third-party app to install for update PRs |

The template stays usable from GitHub's "Use this template" button; the markers are comments that render as nothing.

None of the template's packages has a `repository` field, which npm provenance checks against the publishing repository. The README's publishing steps say "add `repository` to each package"; the template can't fill it in, because each copy lives in a different repository.

The lockfile test found that an example owns more than its folder. Removing the browser example left its Playwright, axe and size-limit dependencies in the root `package.json`, plus root config files, root scripts, CI steps and a `knip.json` entry; knip failed on the leftovers. So v2.2.0 moved each example's tools into the example's own `package.json` wherever the tool allows, which shrinks what the CLI must edit, and knip stays in the combination test as the net that catches anything missed.

## Testing and releases

The CLI's main test generates a project and runs that project's whole CI sequence on it. If that passes, the template and the CLI both work.

**Tests**

1. **Unit:** name and scope validation, flag parsing, marker removal, the package-manager detection.
2. **Every combination:** generate each of the 7 non-empty example sets with `-y`, then in each run `pnpm install --frozen-lockfile`, lint, check:unused, build, typecheck, test and check:packages. Fail if any file still mentions a removed example's name, a removed package, or an `example:` marker.
3. **Fresh machine:** the spike, kept as a CI job: no pnpm, pnpm 9 and pnpm 10, on Linux, macOS and Windows.
4. **Interrupt:** kill the CLI mid-generation and check the target folder doesn't exist.

**Staying in step with the template**

- Each CLI release pins one template release tag. The build fetches that tag and bundles the files, so users get exactly what was tested.
- A weekly scheduled job fails when the template has a newer release than the pinned one; a person bumps the pin in a PR, which runs the full combination test. (Dependabot can't track the pin; there is no Renovate.)
- A weekly scheduled job runs the same test against the template's `main`, so breakage shows before the next template release.

**Releases** use the template's own setup: changesets, the version PR, trusted publishing with provenance, and previews on every PR. A preview of the CLI can be tried straight from the PR comment.

## Open questions

- [ ] Does Node 22.13's `styleText` respect `NO_COLOR`, or does the CLI need Node 23 or a small check of its own?
- [ ] Windows: the generation steps, the `npm exec` fallback, and git hooks. The spike ran on macOS only.
- [ ] pnpm from Homebrew, Corepack, the standalone installer and Volta: does each switch to pnpm 12?
- [ ] Is the `@<folder name>` default scope right, or should the default stay obviously a placeholder until someone chooses?
- [x] **Lockfile after rename and removal (tested 2026-10-27).** After renaming `@monorepo` to `@acme` in 12 files and removing the browser example, a plain `pnpm install` added or changed 0 of 844 lockfile entries and removed 60, all belonging to the removed example. `pnpm install --lockfile-only` produced a byte-identical lockfile in 0.7 s without `node_modules`, so `--no-install` uses it and the lockfile is never left stale. Renaming inside the lockfile and installing frozen also passed, but kept all 60 dead entries: rejected. Defence in depth: after installing, the CLI checks that every lockfile entry already existed in the bundled lockfile, and stops with nothing written if one doesn't; the combination test asserts the same.
- [x] **Renaming an installed folder into place (tested 2026-10-27, macOS).** After the rename: no absolute paths to the old folder in `node_modules`, no broken symlinks, the frozen install was a no-op (78 ms), and lint, build, typecheck, test (12/12), check:packages and a commit through the git hooks all passed. The temporary folder stays a sibling of the target, because a rename across disks (for example from a tmpfs `/tmp`) fails and a copy would be slow. Windows can refuse a rename while an antivirus scanner holds files, so the move retries with backoff there; untested.
- [ ] Does `pnpm install --lockfile-only` need the network on a cold machine? It took 0.7 s with a warm store.

## Designs

CLI screens (a Claude design canvas, linked from the design doc) shows eight terminal screens: the recommended setup, the custom setup, no prompts (`-y`), no pnpm, pnpm 9 or older, a folder that isn't empty, a run cancelled with Ctrl-C, and `--help`.

## Sources

- Package metadata for create-vite, create-next-app, create-t3-app, sv, create-astro, create-turbo, create-expo, create-better-t-stack, create-typescript-app, create-react-app, create-tsdown, nuxi, create-solid and create-qwik, read from the npm registry on 2026-10-27.
- The install spike on a fresh machine, 2026-10-27: Node 24.12.0, npm 11.6.2, pnpm 9.15.9 to 11.28.8.
