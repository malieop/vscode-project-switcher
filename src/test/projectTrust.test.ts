import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, open, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { captureProjectTrust, revalidateProjectTrust, type ProjectTrustToken } from '../projectTrust';

function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

interface Fixture { root: string; project: string; other: string; }
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'project-trust-'));
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const project = join(root, 'sourceA');
    const other = join(root, 'sourceB');
    for (const dir of [project, other]) {
      await mkdir(dir);
      await git(dir, root, 'init', '-b', 'main', '--template=');
      await git(dir, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial');
    }
    await run({ root, project, other });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('captures stable ordinary and linked checkouts and tolerates normal Git activity', async () => {
  await fixture(async ({ root, project }) => {
    const linked = join(root, 'linked');
    await git(project, root, 'worktree', 'add', '-b', 'linked-branch', linked);
    const ordinaryToken = await captureProjectTrust(project);
    const linkedToken = await captureProjectTrust(linked);
    await revalidateProjectTrust(ordinaryToken);
    await revalidateProjectTrust(linkedToken);
    await git(project, root, 'branch', 'new-local-branch');
    await git(project, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'normal activity');
    await revalidateProjectTrust(ordinaryToken);
    await revalidateProjectTrust(linkedToken);
  });
});

test('rejects replacing .git directory without changing the selected checkout inode', async () => {
  await fixture(async ({ root, project, other }) => {
    const token = await captureProjectTrust(project);
    const before = await stat(project, { bigint: true });
    await rename(join(project, '.git'), join(root, 'original-git'));
    await rename(join(other, '.git'), join(project, '.git'));
    const after = await stat(project, { bigint: true });
    assert.equal(before.ino, after.ino);
    await assert.rejects(revalidateProjectTrust(token), /could not be revalidated/);
    await rename(join(project, '.git'), join(other, '.git'));
    await rename(join(root, 'original-git'), join(project, '.git'));
    await assert.rejects(revalidateProjectTrust(token), /Invalid project trust token/);
  });
});

test('rejects in-place redirection of a linked worktree gitdir file even when inode and size are unchanged', async () => {
  await fixture(async ({ root, project, other }) => {
    const linked = join(root, 'wt-one');
    const redirected = join(root, 'wt-two');
    await git(project, root, 'worktree', 'add', '-b', 'branch-one', linked);
    await git(other, root, 'worktree', 'add', '-b', 'branch-two', redirected);
    const path = join(linked, '.git');
    const replacement = await readFile(join(redirected, '.git'));
    const before = await stat(path, { bigint: true });
    assert.equal(BigInt(replacement.length), before.size);
    const token = await captureProjectTrust(linked);
    const file = await open(path, 'r+');
    try { await file.write(replacement, 0, replacement.length, 0); } finally { await file.close(); }
    // Restore mtime; the hash still binds the file's contents.
    await utimes(path, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
    const after = await stat(path, { bigint: true });
    assert.equal(before.ino, after.ino);
    assert.equal(before.size, after.size);
    await assert.rejects(revalidateProjectTrust(token));
  });
});

test('detects .git symlink replacement and replacement of its resolved target', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project, other }) => {
    const dotGit = join(project, '.git');
    const target = join(root, 'metadata');
    await rename(dotGit, target);
    await symlink(target, dotGit, 'dir');
    const targetToken = await captureProjectTrust(project);
    await revalidateProjectTrust(targetToken);
    await rename(target, join(root, 'old-metadata'));
    await rename(join(other, '.git'), target);
    await assert.rejects(revalidateProjectTrust(targetToken));
    const linkToken = await captureProjectTrust(project);
    await rename(dotGit, join(root, 'old-link'));
    await symlink(target, dotGit, 'dir');
    await assert.rejects(revalidateProjectTrust(linkToken));
  });
});

test('binds a symlinked linked-worktree gitdir file to its contents and target', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project, other }) => {
    const linked = join(root, 'wt-one');
    const redirected = join(root, 'wt-two');
    await git(project, root, 'worktree', 'add', '-b', 'branch-one', linked);
    await git(other, root, 'worktree', 'add', '-b', 'branch-two', redirected);
    const dotGit = join(linked, '.git');
    const file = join(root, 'gitdir-file');
    await rename(dotGit, file);
    await symlink(file, dotGit, 'file');
    const token = await captureProjectTrust(linked);
    await revalidateProjectTrust(token);
    const before = await lstat(dotGit, { bigint: true });
    await writeFile(file, await readFile(join(redirected, '.git')));
    const after = await lstat(dotGit, { bigint: true });
    assert.equal(before.ino, after.ino);
    await assert.rejects(revalidateProjectTrust(token));
  });
});

test('detects replacement of a linked worktree common directory independently of its admin directory', async () => {
  await fixture(async ({ root, project, other }) => {
    const linked = join(root, 'linked');
    await git(project, root, 'worktree', 'add', '-b', 'linked-branch', linked);
    const admin = (await git(linked, root, 'rev-parse', '--absolute-git-dir')).trim();
    const movedAdmin = join(root, 'standalone-admin');
    const common = join(await realpath(project), '.git');
    await rename(admin, movedAdmin);
    await writeFile(join(linked, '.git'), `gitdir: ${movedAdmin}\n`);
    await writeFile(join(movedAdmin, 'commondir'), `${common}\n`);
    const token = await captureProjectTrust(linked);
    const before = await stat(movedAdmin, { bigint: true });
    await rename(common, join(root, 'old-common'));
    await rename(join(other, '.git'), common);
    const after = await stat(movedAdmin, { bigint: true });
    assert.equal(before.ino, after.ino);
    await assert.rejects(revalidateProjectTrust(token));
  });
});

test('rejects checkout replacement, missing git entries, nested folders, invalid files and forged tokens', async () => {
  await fixture(async ({ root, project }) => {
    const token = await captureProjectTrust(project);
    await rename(project, join(root, 'old-checkout'));
    await mkdir(project);
    await git(project, root, 'init', '-b', 'main', '--template=');
    await assert.rejects(revalidateProjectTrust(token));
    const nested = join(project, 'nested');
    await mkdir(nested);
    for (const path of ['relative', `${root}\0bad`, root, nested, join(root, 'missing')]) {
      await assert.rejects(captureProjectTrust(path));
    }
    await assert.rejects(revalidateProjectTrust({} as ProjectTrustToken), /Invalid project trust token/);
    await rename(join(project, '.git'), join(root, 'saved-git'));
    await assert.rejects(captureProjectTrust(project));
    await writeFile(join(project, '.git'), Buffer.alloc(64 * 1024 + 1, 120));
    await assert.rejects(captureProjectTrust(project));
  });
});

test('resolves aliases but rejects replacing the selected checkout symlink', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const alias = join(root, 'alias');
    await symlink(project, alias, 'dir');
    const token = await captureProjectTrust(alias);
    await revalidateProjectTrust(token);
    await rename(alias, join(root, 'old-alias'));
    await symlink(project, alias, 'dir');
    await assert.rejects(revalidateProjectTrust(token));
  });
});

test('scrubs repository and configuration environment overrides', async () => {
  await fixture(async ({ root, project }) => {
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { GIT_DIR: join(root, 'missing'), GIT_WORK_TREE: root, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: root });
    try {
      const token = await captureProjectTrust(project);
      await revalidateProjectTrust(token);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  });
});

test('inspection does not invoke hooks or configured fsmonitor commands', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const marker = join(root, 'executed');
    const hook = join(project, '.git', 'hooks', 'post-checkout');
    const monitor = join(root, 'fsmonitor');
    const script = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
    await mkdir(join(project, '.git', 'hooks'), { recursive: true });
    await writeFile(hook, script, { mode: 0o755 });
    await writeFile(monitor, script, { mode: 0o755 });
    await git(project, root, 'config', 'core.fsmonitor', monitor);
    const token = await captureProjectTrust(project);
    await revalidateProjectTrust(token);
    await assert.rejects(lstat(marker));
  });
});

test('fails closed if .git changes during capture', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project, other }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    const wrapper = `#!${process.execPath}\nconst cp = require('node:child_process');\nconst fs = require('node:fs');\nconst result = cp.spawnSync('git', process.argv.slice(2), {stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(previousPath)}}});\nfs.renameSync(${JSON.stringify(join(project, '.git'))}, ${JSON.stringify(join(root, 'old-git'))});\nfs.renameSync(${JSON.stringify(join(other, '.git'))}, ${JSON.stringify(join(project, '.git'))});\nprocess.exit(result.status ?? 1);\n`;
    await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    try { await assert.rejects(captureProjectTrust(project)); } finally { process.env.PATH = previousPath; }
  });
});

test('rejects oversized or malformed Git output without exposing it', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    try {
      for (const output of ["secret\n", 'x'.repeat(65 * 1024)]) {
        await writeFile(join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o755 });
        await assert.rejects(captureProjectTrust(project), (error: unknown) =>
          error instanceof Error && !error.message.includes('secret') && error.message.length < 100);
      }
    } finally { process.env.PATH = previousPath; }
  });
});
