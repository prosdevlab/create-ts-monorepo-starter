/**
 * Removes credentials from a line of pnpm's or git's output before it is printed or reported:
 * the password in `scheme://user:pass@`, the value of npmrc's auth keys and of a Bearer header,
 * and whole tokens shaped like npm's and GitHub's. A credential in another shape isn't caught.
 */
const PATTERNS: [RegExp, string][] = [
  // scheme://user:password@host: keep the user, hide the password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1***@'],
  // npmrc keys, often printed with their registry prefix: //r.example/:_authToken=...
  [/(_authToken|_auth|_password)(\s*=\s*)("?)[^\s"]+\3/g, '$1$2$3***$3'],
  [/(Authorization:\s*Bearer\s+)\S+/gi, '$1***'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '***'],
  [/\bghp_[A-Za-z0-9]{36}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{82}\b/g, '***'],
];

export function redact(line: string): string {
  return PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    line
  );
}
