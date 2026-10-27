import { EXAMPLES } from './args.js';

type Style = 'html' | 'hash' | 'slash';

const NAMES: readonly string[] = [...EXAMPLES, 'template-only'];

// Same patterns as the template's own marker check (scripts/check-examples.mjs).
const MARKER: Record<Style, RegExp> = {
  html: /^<!--\s*(\/?)example:(\S+?)\s*-->$/,
  hash: /^#\s*(\/?)example:(\S+)$/,
  slash: /^\/\/\s*(\/?)example:(\S+)$/,
};

const SLASH_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsonc'];

export class MarkerError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    problem: string
  ) {
    super(`${path}:${line} ${problem}`);
    this.name = 'MarkerError';
  }
}

/** Marker comment style of a repo-relative path, or null when the file is left untouched. */
export function commentStyle(path: string): Style | null {
  const file = path.replaceAll('\\', '/');
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  if (ext === '.md') return 'html';
  if (ext === '.yml' || ext === '.yaml') return 'hash';
  if (name === '.gitignore' || name === '_gitignore' || file.startsWith('.husky/')) return 'hash';
  if (SLASH_EXTENSIONS.includes(ext)) return 'slash';
  if (/^tsconfig.*\.json$/.test(name) || name === 'turbo.json') return 'slash';
  return null;
}

/** Drops blocks named in `remove` (plus template-only) and the marker lines of the rest. */
export function applyMarkers(text: string, path: string, remove: ReadonlySet<string>): string {
  const style = commentStyle(path);
  if (!style) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  let open: { name: string; line: number; drop: boolean } | null = null;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const match = raw.trim().match(MARKER[style]);
    if (!match) {
      if (!open?.drop) out.push(raw);
      continue;
    }
    const [, closing, name = ''] = match;
    if (!NAMES.includes(name)) throw new MarkerError(path, line, `unknown example "${name}"`);
    if (closing) {
      if (open?.name !== name) {
        throw new MarkerError(path, line, `example:${name} closes without a matching opening`);
      }
      open = null;
    } else {
      if (open)
        throw new MarkerError(path, line, `example:${name} opens inside example:${open.name}`);
      open = { name, line, drop: name === 'template-only' || remove.has(name) };
    }
  }
  if (open) throw new MarkerError(path, open.line, `example:${open.name} is never closed`);
  return out.join(eol);
}
