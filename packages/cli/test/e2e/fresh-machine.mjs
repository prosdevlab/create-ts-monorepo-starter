// CI's fresh-machine job: runs the built CLI with -y where pnpm is missing, too old, or 10.x.
// Usage: node fresh-machine.mjs <path to dist/cli.js> <none | 9.15.9 | 10.34.8>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [cliPath, pnpmCase] = process.argv.slice(2);
if (!cliPath || !['none', '9.15.9', '10.34.8'].includes(pnpmCase ?? '')) {
  console.error('Usage: node fresh-machine.mjs <dist/cli.js> <none | 9.15.9 | 10.34.8>');
  process.exit(2);
}
const cli = resolve(cliPath);

const root = mkdtempSync(join(tmpdir(), 'ctms-fresh-'));
const work = join(root, 'work');
mkdirSync(work);
const gitconfig = join(root, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = E2E\n\temail = e2e@example.com\n');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: '1',
  NO_COLOR: '1',
};
const project = join(work, 'my-tools');

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** Runs a command; Windows needs a shell for pnpm's .cmd shim (arguments here are plain words). */
function run(cmd, args, cwd) {
  const shell = process.platform === 'win32' && cmd !== process.execPath;
  const result = shell
    ? spawnSync([cmd, ...args].join(' '), { cwd, env, encoding: 'utf8', shell: true })
    : spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  console.log(
    `$ ${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')} (exit ${result.status})`
  );
  if (result.stdout) console.log(result.stdout.trimEnd());
  if (result.stderr) console.log(result.stderr.trimEnd());
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// The machine must be what the case says, as the CLI will see it (cmd.exe on Windows).
const before = run('pnpm', ['--version'], work);
if (pnpmCase === 'none') check(before.code !== 0, 'no pnpm on PATH');
else check(before.stdout.trim() === pnpmCase, `pnpm --version is ${pnpmCase}`);

const created = run(process.execPath, [cli, 'my-tools', '-y'], work);
check(created.code === 0, 'the CLI exits 0');
check(existsSync(join(project, 'package.json')), 'the project exists');
const log = run('git', ['log', '--format=%s'], project);
check(log.stdout.trim().split('\n').length === 1, 'git has exactly one commit');

if (pnpmCase === 'none') {
  check(created.stderr.includes('(npm exec)'), 'installs through npm exec');
  check(created.stdout.includes('npm install -g pnpm'), 'prints npm install -g pnpm');
  check(existsSync(join(project, 'node_modules')), 'node_modules exists');
} else if (pnpmCase === '9.15.9') {
  const message = 'pnpm 9.15.9 is too old for this project';
  check(created.stderr.includes(message), `prints "${message}"`);
  check(!existsSync(join(project, 'node_modules')), 'no node_modules');
} else {
  check(
    created.stdout.includes('Installed dependencies with pnpm 12.15.0'),
    'installs with pnpm 12.15.0'
  );
  check(
    run('pnpm', ['--version'], project).stdout.trim() === '12.15.0',
    'pnpm switches to 12.15.0'
  );
  check(run('pnpm', ['build'], project).code === 0, 'pnpm build passes');
  check(run('pnpm', ['test'], project).code === 0, 'pnpm test passes');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed; the project is in ${project}`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true, maxRetries: 5 });
console.log('\nAll checks passed.');
