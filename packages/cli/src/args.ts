import { parseArgs } from 'node:util';

export type Example = 'lib' | 'cli' | 'web';
export const EXAMPLES: readonly Example[] = ['lib', 'cli', 'web'];

export interface Options {
  folder?: string;
  scope?: string;
  examples?: Example[];
  git: boolean;
  install: boolean;
  force: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
}

export type ParseResult = { ok: true; options: Options } | { ok: false; message: string };

const HINT = 'Run with --help to see the options.';

function isExample(value: string): value is Example {
  return (EXAMPLES as readonly string[]).includes(value);
}

function parseExamples(raw: string): Example[] | string {
  const entries = [
    ...new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
  if (entries.length === 0) return 'Choose at least one example.';
  const examples: Example[] = [];
  for (const entry of entries) {
    if (!isExample(entry)) return `Unknown example "${entry}". Choose from ${EXAMPLES.join(', ')}.`;
    examples.push(entry);
  }
  return examples;
}

function parserMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^']+)'/.exec(text);
  if (unknown) return `Unknown option ${unknown[1]}. ${HINT}`;
  return `${text.replace(/\.$/, '')}. ${HINT}`;
}

// Never throws: every failure comes back as { ok: false, message }.
export function parseArgv(argv: string[]): ParseResult {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return { ok: false, message: parserMessage(error) };
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    return {
      ok: false,
      message: `Expected one folder, got ${positionals.length}: ${positionals.join(', ')}`,
    };
  }
  const options: Options = {
    git: values.git ?? true,
    install: values.install ?? true,
    force: values.force ?? false,
    yes: values.yes ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
  if (positionals[0] !== undefined) options.folder = positionals[0];
  if (values.scope !== undefined) options.scope = values.scope;
  if (values.examples !== undefined) {
    const examples = parseExamples(values.examples.join(','));
    if (typeof examples === 'string') return { ok: false, message: examples };
    options.examples = examples;
  }
  return { ok: true, options };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      scope: { type: 'string' },
      examples: { type: 'string', multiple: true },
      git: { type: 'boolean' },
      install: { type: 'boolean' },
      force: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}
