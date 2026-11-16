# create-ts-monorepo-starter

## 0.1.1

### Patch Changes

- ced2af3: Check that pnpm can switch to the template's pnpm before creating anything. When the switch fails, the CLI exits with 3, creates nothing, and prints the command that fixes it. `--check` runs only this check.
