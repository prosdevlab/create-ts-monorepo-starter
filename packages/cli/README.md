# create-ts-monorepo-starter

Create a TypeScript monorepo for CLIs, libraries and browser libraries from the
[ts-monorepo-starter](https://github.com/prosdevlab/ts-monorepo-starter) template: pnpm 12, Turborepo, Biome, Vitest,
Changesets, CI and a release workflow, plus the example packages you pick. The project passes its own CI on the first
commit.

![Running npm create ts-monorepo-starter@latest: choosing a folder, the @acme scope and the lib and cli examples, then installing and committing](https://raw.githubusercontent.com/prosdevlab/create-ts-monorepo-starter/main/docs/demo/demo.gif)

```bash
npm create ts-monorepo-starter@latest my-tools
pnpm create ts-monorepo-starter my-tools
yarn create ts-monorepo-starter my-tools
bun create ts-monorepo-starter my-tools
```

Runs on Node 22.13 or later. `--help` lists the options; `-y` asks nothing.

Options, pnpm versions and how it works:
[the full README on GitHub](https://github.com/prosdevlab/create-ts-monorepo-starter#readme).

MIT licensed.
