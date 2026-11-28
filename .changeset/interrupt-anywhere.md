---
"create-ts-monorepo-starter": patch
---

A Ctrl-C before the project starts or during `--check` now prints `Cancelled. Nothing was written.`, stops pnpm and everything it started, removes the temporary `ctms-pnpm-*` folder, and exits with 130. Before, the process died by the signal and left that folder in the system temp folder. A Ctrl-C while the CLI checks that pnpm can switch versions also removes that folder now.
