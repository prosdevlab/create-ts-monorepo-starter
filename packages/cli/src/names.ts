import { basename, resolve } from 'node:path';

const MAX_NAME_LENGTH = 214;

export class NameError extends Error {
  override name = 'NameError';
}

// Folder -> npm package name: last path segment, lowercased, unsafe runs collapsed to "-".
export function packageNameFromFolder(folder: string, cwd: string = process.cwd()): string {
  const segment = basename(resolve(cwd, folder));
  const name = segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!name) throw new NameError(`Can't make an npm package name from "${folder}"`);
  if (name.length > MAX_NAME_LENGTH) {
    throw new NameError(`"${folder}" gives a package name over ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

export function defaultScope(folder: string, cwd: string = process.cwd()): string {
  return `@${packageNameFromFolder(folder, cwd)}`;
}

// Lowercases and adds a missing "@"; rejects anything npm would not accept as a scope.
export function normalizeScope(
  input: string
): { ok: true; scope: string } | { ok: false; message: string } {
  const trimmed = input.trim();
  const scope = (trimmed.startsWith('@') ? trimmed : `@${trimmed}`).toLowerCase();
  if (!/^@[a-z0-9._-]+$/.test(scope)) {
    return {
      ok: false,
      message: `Scope "${input}" can only contain lowercase letters, digits, "-", "." and "_".`,
    };
  }
  return { ok: true, scope };
}
