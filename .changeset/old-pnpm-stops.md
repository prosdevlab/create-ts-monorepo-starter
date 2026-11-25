---
"create-ts-monorepo-starter": patch
---

With a pnpm older than 10.26, the CLI now exits with 3 and creates nothing, and prints the upgrade command, as `--check` does. Before, it reported the problem but exited 0 and created a project whose lockfile still named the template's `@monorepo/` packages, so its first `pnpm install --frozen-lockfile` failed.
