# create-ts-monorepo-starter

## 0.2.0

### Minor Changes

- b96a1ce: Bundle template v2.4.0 (https://github.com/prosdevlab/ts-monorepo-starter/releases/tag/v2.4.0). Generated projects check that every changeset parses: CI runs `pnpm check:changesets` after Lint, so a malformed changeset fails its own pull request instead of the release after merge.

## 0.1.1

### Patch Changes

- ced2af3: Check that pnpm can switch to the template's pnpm before creating anything. When the switch fails, the CLI exits with 3, creates nothing, and prints the command that fixes it. `--check` runs only this check.
