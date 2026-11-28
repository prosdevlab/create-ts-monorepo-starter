import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact';

const npm = `npm_${'a1B2'.repeat(9)}`;
const ghp = `ghp_${'a1B2'.repeat(9)}`;
const pat = `github_pat_${'a1_B'.repeat(20)}x1`;

describe('redact', () => {
  it.each([
    ['https://ada:hunter2@r.example/x', 'https://ada:***@r.example/x'],
    ['git+ssh://ada:hunter2@host/repo.git', 'git+ssh://ada:***@host/repo.git'],
    ['//r.example/:_authToken=abc123', '//r.example/:_authToken=***'],
    ['_authToken = "abc123"', '_authToken = "***"'],
    ['//r.example/:_auth=YWRhOmh1bnRlcjI=', '//r.example/:_auth=***'],
    ['//r.example/:_password=aHVudGVyMg==', '//r.example/:_password=***'],
    ['Authorization: Bearer abc.def', 'Authorization: Bearer ***'],
    [`token ${npm} used`, 'token *** used'],
    [`token ${ghp}`, 'token ***'],
    [`token ${pat}`, 'token ***'],
  ])('hides the credential in %s', (line, hidden) => {
    expect(redact(line)).toBe(hidden);
  });

  it('hides two credentials on one line', () => {
    expect(redact(`https://a:b@x.example and ${npm}`)).toBe('https://a:***@x.example and ***');
  });

  it.each([
    'npm_config_registry=https://r.example',
    'ghp_x',
    'https://ada@r.example/x',
    'ERR_PNPM_FETCH  GET https://registry.npmjs.org/left-pad: 404',
    'Progress: resolved 120, reused 118, downloaded 2, added 120',
  ])('leaves %s alone', (line) => {
    expect(redact(line)).toBe(line);
  });
});
