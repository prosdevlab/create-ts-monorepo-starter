---
"create-ts-monorepo-starter": minor
---

`--json` prints one JSON object on stdout for every way a run can end: a created project, `--check`, `--version`, a usage error, a failure, a Ctrl-C and an unexpected error. The object says what the run left on disk, and for a failure, how to fix it and the command to retry it when that is safe. The exit codes are the same as without `--json`, all text goes to stderr, and `--json` never asks a question. `--help` still prints its text. The README's "For agents" section has the contract.

When stdout isn't a terminal, a run now prints `add --json for machine-readable output` as its first line on stderr.
