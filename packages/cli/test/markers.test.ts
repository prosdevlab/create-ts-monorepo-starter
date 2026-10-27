import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMarkers, commentStyle, MarkerError } from '../src/markers';
import { templateDir } from '../src/template';

const md = 'a\n<!-- example:web -->\nweb\n<!-- /example:web -->\nb\n';
const none = new Set<string>();

describe('commentStyle', () => {
  it.each([
    ['README.md', 'html'],
    ['docs/a.md', 'html'],
    ['.github/workflows/ci.yml', 'hash'],
    ['pnpm-workspace.yaml', 'hash'],
    ['_gitignore', 'hash'],
    ['.gitignore', 'hash'],
    ['.husky/pre-commit', 'hash'],
    ['src\\a.ts', 'slash'],
    ['a.mts', 'slash'],
    ['a.cts', 'slash'],
    ['a.tsx', 'slash'],
    ['a.js', 'slash'],
    ['a.mjs', 'slash'],
    ['a.cjs', 'slash'],
    ['biome.jsonc', 'slash'],
    ['tsconfig.json', 'slash'],
    ['tsconfig.base.json', 'slash'],
    ['packages/web/tsconfig.json', 'slash'],
    ['turbo.json', 'slash'],
    ['package.json', null],
    ['data.json', null],
    ['LICENSE', null],
  ])('%s -> %s', (path, style) => {
    expect(commentStyle(path)).toBe(style);
  });
});

describe('applyMarkers', () => {
  it('removes a Markdown block and its markers', () => {
    expect(applyMarkers(md, 'README.md', new Set(['web']))).toBe('a\nb\n');
  });

  it("keeps a chosen block's content and drops its markers", () => {
    expect(applyMarkers(md, 'README.md', none)).toBe('a\nweb\nb\n');
  });

  it('handles YAML and slash markers, keeping indentation', () => {
    const yml = 'a:\n  # example:cli\n  b: 1\n  # /example:cli\n  c: 2\n';
    expect(applyMarkers(yml, 'x.yml', new Set(['cli']))).toBe('a:\n  c: 2\n');
    expect(applyMarkers(yml, 'x.yml', none)).toBe('a:\n  b: 1\n  c: 2\n');
    const ts = 'x\n  // example:lib\n  y\n  // /example:lib\nz\n';
    expect(applyMarkers(ts, 'x.ts', new Set(['lib']))).toBe('x\nz\n');
    expect(applyMarkers(ts, 'x.ts', none)).toBe('x\n  y\nz\n');
  });

  it('always removes template-only blocks', () => {
    const text = 'a\n<!-- example:template-only -->\nt\n<!-- /example:template-only -->\nb\n';
    expect(applyMarkers(text, 'README.md', none)).toBe('a\nb\n');
  });

  it('throws on an unclosed marker', () => {
    const text = 'a\n<!-- example:web -->\nweb\n';
    expect(() => applyMarkers(text, 'README.md', none)).toThrow(
      new MarkerError('README.md', 2, 'example:web is never closed')
    );
    expect(() => applyMarkers(text, 'README.md', none)).toThrow(
      'README.md:2 example:web is never closed'
    );
  });

  it('throws on a nested marker', () => {
    const text = 'a\n<!-- example:web -->\n<!-- example:cli -->\n';
    try {
      applyMarkers(text, 'README.md', none);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MarkerError);
      expect((error as MarkerError).message).toBe(
        'README.md:3 example:cli opens inside example:web'
      );
      expect((error as MarkerError).path).toBe('README.md');
      expect((error as MarkerError).line).toBe(3);
    }
  });

  it('throws on a close without an open', () => {
    expect(() => applyMarkers('a\n<!-- /example:web -->\n', 'README.md', none)).toThrow(
      'README.md:2 example:web closes without a matching opening'
    );
  });

  it('throws on an unknown example name', () => {
    expect(() => applyMarkers('<!-- example:webb -->\n', 'README.md', none)).toThrow(
      'README.md:1 unknown example "webb"'
    );
  });

  it('leaves files with no comment style alone', () => {
    const x = '<!-- example:web -->\nnot closed\n';
    expect(applyMarkers(x, 'LICENSE', new Set(['web']))).toBe(x);
    expect(applyMarkers(x, 'package.json', new Set(['web']))).toBe(x);
  });

  it('keeps CRLF line endings', () => {
    const text = 'a\r\n<!-- example:web -->\r\nweb\r\n<!-- /example:web -->\r\nb\r\n';
    expect(applyMarkers(text, 'README.md', none)).toBe('a\r\nweb\r\nb\r\n');
    expect(applyMarkers(text, 'README.md', new Set(['web']))).toBe('a\r\nb\r\n');
  });

  it('keeps a missing trailing newline missing', () => {
    expect(applyMarkers('a\n<!-- example:web -->\nw\n<!-- /example:web -->\nb', 'a.md', none)).toBe(
      'a\nw\nb'
    );
  });

  it('accepts whitespace variants', () => {
    expect(
      applyMarkers('a\n<!--example:web-->\nw\n<!--  /example:web  -->\nb\n', 'a.md', none)
    ).toBe('a\nw\nb\n');
    expect(applyMarkers('a\n//example:web\nw\n//  /example:web\nb\n', 'a.ts', none)).toBe(
      'a\nw\nb\n'
    );
  });

  it('treats a marker of another style as text', () => {
    const text = '# example:web\nx\n';
    expect(applyMarkers(text, 'a.md', new Set(['web']))).toBe(text);
    const ts = '<!-- example:web -->\n';
    expect(applyMarkers(ts, 'a.ts', new Set(['web']))).toBe(ts);
  });

  it('handles _gitignore and .husky hooks as hash style', () => {
    const text = 'a\n# example:web\nweb/\n# /example:web\n';
    expect(applyMarkers(text, '_gitignore', new Set(['web']))).toBe('a\n');
    expect(applyMarkers(text, '.husky/pre-commit', none)).toBe('a\nweb/\n');
  });

  it('handles tsconfig and turbo.json as slash style', () => {
    const text = '{\n  // example:web\n  "a": 1,\n  // /example:web\n  "b": 2\n}\n';
    const removed = '{\n  "b": 2\n}\n';
    expect(applyMarkers(text, 'tsconfig.base.json', new Set(['web']))).toBe(removed);
    expect(applyMarkers(text, 'turbo.json', new Set(['web']))).toBe(removed);
  });

  it('never touches package.json', () => {
    const text = '{ "x": "// example:web" }\n// example:web\n';
    expect(applyMarkers(text, 'package.json', new Set(['web']))).toBe(text);
  });
});

const MARKER_LINE = {
  html: /^<!--\s*\/?example:/,
  hash: /^#\s*\/?example:/,
  slash: /^\/\/\s*\/?example:/,
};

function filesOf(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesOf(dir, rel) : [rel];
  });
}

describe('the bundled template', () => {
  const dir = templateDir();
  const files = filesOf(dir);

  it.each([['web'], ['lib'], ['cli'], ['lib', 'cli', 'web'], []])(
    'strips cleanly when removing {%s}',
    (...removed) => {
      const remove = new Set(removed);
      let styled = 0;
      for (const file of files) {
        const text = readFileSync(join(dir, file), 'utf8');
        const style = commentStyle(file);
        const out = applyMarkers(text, file, remove);
        if (!style) {
          expect(out).toBe(text);
          continue;
        }
        styled++;
        for (const line of out.split('\n')) {
          expect(MARKER_LINE[style].test(line.trim()), `${file}: ${line}`).toBe(false);
        }
      }
      expect(styled).toBeGreaterThan(0);
    }
  );
});
