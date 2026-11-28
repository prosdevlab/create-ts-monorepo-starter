---
"create-ts-monorepo-starter": patch
---

An unexpected error before a run starts (detecting pnpm for `--check`, or reading your git name) now prints `✗` with its message and exits 1, like any other failure. Before, it printed a stack trace.
