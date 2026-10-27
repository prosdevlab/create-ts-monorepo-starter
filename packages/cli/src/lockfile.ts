/** Thrown when an install added lockfile entries the bundled lockfile lacks. */
export class LockfileError extends Error {
  override name = 'LockfileError';
}

const SECTIONS = ['packages', 'snapshots'] as const;

function unquote(key: string): string {
  return key.startsWith("'") && key.endsWith("'") ? key.slice(1, -1).replaceAll("''", "'") : key;
}

/** Entries as `packages: name@version` / `snapshots: name@version`, across every YAML document. */
function sectionEntries(text: string): Set<string> {
  const found = new Set<string>();
  for (const doc of text.split(/^---\r?$/m)) {
    let section: string | null = null;
    for (const line of doc.split(/\r?\n/)) {
      if (line.startsWith('#')) continue;
      const top = /^(\w+):\s*$/.exec(line);
      if (top) {
        section = (SECTIONS as readonly string[]).includes(top[1] as string)
          ? (top[1] as string)
          : null;
      } else if (/^\S/.test(line)) {
        section = null;
      } else if (section) {
        // A key ends at the first `:` followed by whitespace or end of line, so `node@runtime:1.0.0:` works.
        const key = /^ {2}('(?:[^']|'')*'|[^\s'#].*?):(?=\s|$)/.exec(line);
        if (key) found.add(`${section}: ${unquote(key[1] as string)}`);
      }
    }
  }
  return found;
}

/** Every key under a top-level `packages:` or `snapshots:` section, across all YAML documents. */
export function lockfileEntries(text: string): Set<string> {
  return new Set([...sectionEntries(text)].map((e) => e.slice(e.indexOf(': ') + 2)));
}

/** Throws unless every entry of `generated` already exists in `bundled`. */
export function assertLockfileSubset(bundled: string, generated: string): void {
  const have = sectionEntries(bundled);
  const added = [...sectionEntries(generated)].filter((e) => !have.has(e));
  if (added.length === 0) return;
  const lines = added.slice(0, 10).map((e) => `+ ${e}`);
  if (added.length > 10) lines.push(`…and ${added.length - 10} more`);
  throw new LockfileError(`Lockfile changed during install:\n${lines.join('\n')}`);
}
