---
"create-ts-monorepo-starter": minor
---

A failed install now exits with 4 instead of 1, so a script can tell it from other failures. Retrying may work: nothing was created. The message is unchanged. Every other exit code stays the same.
