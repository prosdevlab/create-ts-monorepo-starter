import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/update-template.mjs', import.meta.url));
const REPO = 'o/r';

// A stand-in for the GitHub API: the given releases, newest first, and a commit per tag.
function github(releases: { tag_name: string; body?: string }[]): Promise<Server> {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const tagged = /^\/repos\/o\/r\/releases\/tags\/(.+)$/.exec(url);
    const commit = /^\/repos\/o\/r\/commits\/(.+)$/.exec(url);
    if (url === '/repos/o/r/releases/latest') send(200, releases[0]);
    else if (url.startsWith('/repos/o/r/releases?')) send(200, releases);
    else if (tagged) {
      const found = releases.find((release) => release.tag_name === tagged[1]);
      send(found ? 200 : 404, found ?? { message: 'Not Found' });
    } else if (commit) send(200, { sha: `sha-of-${commit[1]}` });
    else send(404, { message: 'Not Found' });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

let dir: string;
let server: Server | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'update-template-'));
  mkdirSync(join(dir, 'changesets'));
});
afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function update(
  pinned: string,
  releases: { tag_name: string; body?: string }[],
  args: string[] = []
) {
  server = await github(releases);
  const { port } = server.address() as AddressInfo;
  const file = join(dir, 'template-version.json');
  writeFileSync(
    file,
    `${JSON.stringify({ repository: REPO, tag: pinned, commit: 'old' }, null, 2)}\n`
  );
  const env = {
    ...process.env,
    TEMPLATE_VERSION_FILE: file,
    CHANGESET_DIR: join(dir, 'changesets'),
    GITHUB_API: `http://127.0.0.1:${port}`,
  };
  delete env.GITHUB_TOKEN;
  // spawn, not spawnSync: the stand-in API runs in this process and must keep answering.
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

const pinnedFile = () => JSON.parse(readFileSync(join(dir, 'template-version.json'), 'utf8'));
const changesets = () => readdirSync(join(dir, 'changesets'));

describe('update-template', () => {
  it('pins the latest release and adds a patch changeset for a template patch release', async () => {
    const result = await update('v2.3.0', [{ tag_name: 'v2.3.1', body: 'Node 26 LTS' }]);
    expect(result.status).toBe(0);
    expect(pinnedFile()).toEqual({ repository: REPO, tag: 'v2.3.1', commit: 'sha-of-v2.3.1' });
    expect(changesets()).toEqual(['template-v2-3-1.md']);
    expect(readFileSync(join(dir, 'changesets', 'template-v2-3-1.md'), 'utf8')).toBe(
      '---\n"create-ts-monorepo-starter": patch\n---\n\nBundle template v2.3.1 (https://github.com/o/r/releases/tag/v2.3.1).\n'
    );
    expect(result.stdout).toContain('Node 26 LTS');
  });

  it('adds a minor changeset for a template minor or major release', async () => {
    await update('v2.3.0', [{ tag_name: 'v3.0.0' }]);
    expect(readFileSync(join(dir, 'changesets', 'template-v3-0-0.md'), 'utf8')).toContain(
      '"create-ts-monorepo-starter": minor'
    );
  });

  it('prints the notes of every release it skips, oldest first', async () => {
    const result = await update('v2.3.0', [
      { tag_name: 'v2.4.0', body: 'second' },
      { tag_name: 'v2.3.1', body: 'first' },
      { tag_name: 'v2.3.0', body: 'already pinned' },
    ]);
    expect(result.stdout).not.toContain('already pinned');
    expect(result.stdout.indexOf('first')).toBeLessThan(result.stdout.indexOf('second'));
  });

  it('takes a named release instead of the latest', async () => {
    const result = await update(
      'v2.3.0',
      [{ tag_name: 'v2.4.0' }, { tag_name: 'v2.3.1' }],
      ['v2.3.1']
    );
    expect(result.status).toBe(0);
    expect(pinnedFile().tag).toBe('v2.3.1');
  });

  it('changes nothing when the release is already pinned', async () => {
    const result = await update('v2.3.0', [{ tag_name: 'v2.3.0' }]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Already on template v2.3.0');
    expect(pinnedFile().commit).toBe('old');
    expect(changesets()).toEqual([]);
  });

  it('refuses to go back to an older release', async () => {
    const result = await update('v2.3.0', [{ tag_name: 'v2.2.0' }], ['v2.2.0']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('older than the pinned v2.3.0');
    expect(pinnedFile().tag).toBe('v2.3.0');
  });

  it('fails without writing anything when the release does not exist', async () => {
    const result = await update('v2.3.0', [{ tag_name: 'v2.3.0' }], ['v9.9.9']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub answered 404');
    expect(changesets()).toEqual([]);
  });
});
