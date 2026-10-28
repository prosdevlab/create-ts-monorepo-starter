---
name: update-template
description: Use when the template (prosdevlab/ts-monorepo-starter) has a new release to bundle — the weekly template-main.yml run failed with "Template vX.Y.Z is out; run pnpm update-template", or someone asks to update, bump or take a new template release. Pins the release, verifies the CLI against it, fixes what the new template broke, and prepares the PR.
---

# Update the bundled template

The CLI ships exactly one template release, pinned in `packages/cli/template-version.json`. Users get a new template
only when a CLI release bundles it. `pnpm update-template` does the mechanical part; your job is reading what changed,
running the checks, and fixing what breaks. AGENTS.md "Taking a New Template Release" is the source for these steps.

## 1. Start clean

```bash
git switch main && git pull
git status --porcelain   # must print nothing; stop and ask if it doesn't
```

## 2. Pin the release

```bash
pnpm update-template          # the latest release; or: pnpm update-template vX.Y.Z
```

- `Already on template vX.Y.Z; nothing to do.` → stop and report that.
- `GitHub answered 403` → rate limited; set `GITHUB_TOKEN` (e.g. `GITHUB_TOKEN=$(gh auth token)` in the same command,
  never echoed) and rerun.
- Otherwise it updated `template-version.json`, added `.changeset/template-vX-Y-Z.md`, and printed the release notes of
  every release since the pinned one. Then:

```bash
git switch -c chore/template-vX.Y.Z
```

## 3. Read the release notes

Before running anything, note each change that touches what the CLI does to the template, and check it against the
code:

| The notes mention | Check |
| --- | --- |
| new, renamed or removed example packages | `EXAMPLES` (`args.ts`), `EXAMPLE_DIRS` (`generate.ts`), `PACKAGES` (`run.ts`), `EXAMPLE_HINTS` (`ui.ts`) |
| new marker kinds or file types with markers | `markers.ts` mirrors the template's `scripts/check-examples.mjs` |
| README, LICENSE or package names changed | the identity edits in `generate.ts` (`identityEdits`) |
| new template-only files | `TEMPLATE_ONLY_FILES` in `generate.ts` |
| new dotfiles at the root | `DOTFILE_RENAMES` in `template.ts` |
| pnpm version (`packageManager`) or Node pin | the install path in `pnpm.ts`; the "pnpm" section of README.md |
| new README sections the closing checklist names | the checklist in `ui.ts` |

## 4. Run the checks

```bash
pnpm build && pnpm test && pnpm test:e2e
```

`test:e2e` needs the network and takes several minutes: it generates every combination of examples and runs each
project's own CI. Run it even when the unit tests pass.

| Failure | Meaning | Do |
| --- | --- | --- |
| `vX.Y.Z points at <sha>, expected <sha>` (build) | the tag moved after release | stop and report; never edit the commit by hand |
| `Template changed: "..." not found in <file>` | a line `generate.ts` rewrites is gone | update `identityEdits` to the new text, with a test |
| a marker error | the template uses a marker the CLI doesn't parse | update `markers.ts` to match `check-examples.mjs`, with a test |
| `assertLockfileSubset` lists new entries | the install resolved versions the template didn't test | stop and report: the template's lockfile and manifests disagree, a template bug |
| an e2e project's own CI fails | the generated project is broken | reproduce with `E2E_SUBSETS=<combo> pnpm test:e2e`; fix the CLI if it caused it, otherwise stop and report it as a template bug |

Fix CLI code only, each fix in its own commit with a test, following AGENTS.md. Never edit `dist/template` (it's
rebuilt) or pin a different commit to make a failure go away. A bug in the template itself is fixed in the template
repository and released there; this update waits for that release.

## 5. Finish

1. Run the full "Before Calling Work Done" sequence from AGENTS.md.
2. Commit the pin and changeset as `chore: bundle template vX.Y.Z`, separate from any fixes.
3. **Ask before pushing or opening the PR.** The PR body says which template changes users will notice (from the
   release notes), every fix made in the CLI and why, and the test counts.
4. After it merges, Changesets opens a version PR; merging that publishes. That's the maintainers' call.
5. If the CLI's prompts or output changed, mention that the README demo can be re-recorded after the release
   (CONTRIBUTING.md "The README Demo").
