---
"create-ts-monorepo-starter": patch
---

Credentials in the pnpm and git output the CLI quotes are now hidden: the password in a `user:password@` URL, npm's `_authToken`, `_auth` and `_password` values, Bearer headers, and npm and GitHub tokens show as `***`. This covers the last lines shown when an install fails, the lines quoted when pnpm can't switch versions, and git's warnings.
