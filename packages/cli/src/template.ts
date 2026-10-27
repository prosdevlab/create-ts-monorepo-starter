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
