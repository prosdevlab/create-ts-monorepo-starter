import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `../dist/` resolves to the same folder from src/ (tests) and from the bundled dist/cli.js.
const dist = new URL('../dist/', import.meta.url);

/** Dotfiles are stored renamed in the bundle because npm and pnpm drop them from packages. */
export const DOTFILE_RENAMES: Record<string, string> = {
  _gitignore: '.gitignore',
  _npmrc: '.npmrc',
};

/** Absolute path of the bundled template. */
export function templateDir(): string {
  return fileURLToPath(new URL('template', dist));
}

/** The bundled release; `tag` is null only for a TEMPLATE_REF build. */
export function templateVersion(): { tag: string | null; commit: string } {
  const { tag, commit } = JSON.parse(
    readFileSync(new URL('template-version.json', dist), 'utf8')
  ) as { tag: string | null; commit: string };
  return { tag, commit };
}

/** The pnpm the template pins (`pnpm@x.y.z`), without any `+sha` suffix. */
export function pnpmSpec(
  manifest: string = readFileSync(new URL('template/package.json', dist), 'utf8')
): string {
  const { packageManager } = JSON.parse(manifest) as { packageManager?: string };
  const spec = packageManager?.split('+')[0];
  if (!spec || !/^pnpm@\d+\.\d+\.\d+$/.test(spec)) {
    throw new Error(`The bundled template has no usable packageManager (found: ${packageManager})`);
  }
  return spec;
}

/** This CLI's version, from the package.json that ships next to dist/ (and src/). */
export function cliVersion(): string {
  const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/** The template's tag, or its short commit for a TEMPLATE_REF build. */
export function templateLabel(): string {
  const { tag, commit } = templateVersion();
  return tag ?? commit.slice(0, 7);
}
