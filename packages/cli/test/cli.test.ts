import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { versionText } from '../src/ui';

// Spawns the built dist/cli.js with stdin and stdout piped, so neither is a terminal.
const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctms-cli-'));
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n');
  env = { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: gitconfig };
  env.GIT_CONFIG_NOSYSTEM = '1';
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) {
    delete env[key];
  }
  delete env.FORCE_COLOR;
  delete env.npm_config_user_agent;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('cli', () => {
  it('exits 2 and names the missing folder when nothing can be asked', () => {
    const result = cli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      'Pass a folder name, for example: create-ts-monorepo-starter my-tools\n'
    );
    expect(result.stdout).toBe('');
  });

  it('exits 2 for a usage error', () => {
    const result = cli(['my-tools', '--shout']);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('Unknown option --shout. Run with --help to see the options.\n');
    expect(readdirSync(root)).not.toContain('my-tools');
  });

  it('prints the version', () => {
    const result = cli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${versionText()}\n`);
  });

  it('refuses a non-empty folder with -y and writes nothing', () => {
    mkdirSync(join(root, 'my-tools'));
    writeFileSync(join(root, 'my-tools', 'notes.txt'), 'keep me');
    const before = readdirSync(root).sort();
    const result = cli(['my-tools', '-y']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "my-tools isn't empty. Use another folder, or pass --force to move it aside."
    );
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readdirSync(join(root, 'my-tools'))).toEqual(['notes.txt']);
  });

  it('creates a committed project without installing, and no colour with NO_COLOR', () => {
    const result = cli(['proj', '--no-install', '-y'], { NO_COLOR: '1' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('\x1b[');
    expect(result.stdout).toContain('✓ Created proj');
    expect(result.stdout).toContain('Next: cd proj && pnpm install && pnpm build && pnpm test');

    const project = join(root, 'proj');
    const name = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).name;
    expect(name).toBe('proj');
    const log = execFileSync('git', ['log', '--format=%s'], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    expect(log.trim().split('\n')).toEqual([
      expect.stringMatching(
        /^chore: initial commit from create-ts-monorepo-starter \S+ \(template \S+\)$/
      ),
    ]);
    expect(readdirSync(root).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  }, 60_000);
});
