import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deleteBranch, inspectWorktreeLosses, removeWorktree } from '../gitWorktreeRemove';
import { GitWorktreeError } from '../gitWorktreeCreate';

function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

interface Fixture { root: string; project: string; worktree: string }

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'switcher-remove-'));
  const project = join(root, 'project');
  await mkdir(project);
  await git(project, root, 'init', '-b', 'main', '--template=');
  await writeFile(join(project, 'file.txt'), 'original\n');
  await git(project, root, 'add', 'file.txt');
  await git(project, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  await mkdir(join(root, 'worktrees'));
  const worktree = join(root, 'worktrees', 'wt');
  await git(project, root, 'worktree', 'add', '-b', 'feature', worktree);
  return { root, project: await realpath(project), worktree: await realpath(worktree) };
}

async function commitOn(cwd: string, root: string, message: string): Promise<void> {
  await writeFile(join(cwd, 'file.txt'), `${message}\n`);
  await git(cwd, root, 'add', 'file.txt');
  await git(cwd, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message);
}

async function branches(project: string, root: string): Promise<string> {
  return git(project, root, 'branch', '--list');
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test('a clean worktree with a merged branch shows no losses', async () => {
  const { root, project, worktree } = await fixture();
  try {
    const losses = await inspectWorktreeLosses(project, worktree, { branch: 'feature' });
    assert.deepEqual(losses, { uncommittedChanges: false, untrackedFiles: false, unmergedCommits: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uncommitted changes and untracked files are detected separately', async () => {
  const { root, project, worktree } = await fixture();
  try {
    await writeFile(join(worktree, 'file.txt'), 'modified\n');
    let losses = await inspectWorktreeLosses(project, worktree, { branch: 'feature' });
    assert.deepEqual(losses, { uncommittedChanges: true, untrackedFiles: false, unmergedCommits: false });
    await git(worktree, root, 'checkout', '--', 'file.txt');
    await writeFile(join(worktree, 'new.txt'), 'new\n');
    losses = await inspectWorktreeLosses(project, worktree, { branch: 'feature' });
    assert.deepEqual(losses, { uncommittedChanges: false, untrackedFiles: true, unmergedCommits: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('commits not merged into the main checkout HEAD or upstream are detected', async () => {
  const { root, project, worktree } = await fixture();
  try {
    await commitOn(worktree, root, 'work');
    let losses = await inspectWorktreeLosses(project, worktree, { branch: 'feature' });
    assert.equal(losses.unmergedCommits, true);
    // A configured local upstream does not hide the commits while it lags behind.
    await git(project, root, 'branch', '--set-upstream-to=main', 'feature');
    losses = await inspectWorktreeLosses(project, worktree, { branch: 'feature' });
    assert.equal(losses.unmergedCommits, true);
    // Merging into the main checkout clears the category.
    await git(project, root, 'merge', '--ff-only', 'feature');
    losses = await inspectWorktreeLosses(project, worktree, { branch: 'feature' });
    assert.equal(losses.unmergedCommits, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a detached HEAD is checked against the main checkout HEAD', async () => {
  const { root, project } = await fixture();
  try {
    await git(project, root, 'worktree', 'add', '--detach', join(root, 'worktrees', 'det'));
    const detached = await realpath(join(root, 'worktrees', 'det'));
    const head = (await git(detached, root, 'rev-parse', 'HEAD')).trim();
    let losses = await inspectWorktreeLosses(project, detached, { head });
    assert.equal(losses.unmergedCommits, false);
    await commitOn(detached, root, 'detached work');
    losses = await inspectWorktreeLosses(project, detached, { head: (await git(detached, root, 'rev-parse', 'HEAD')).trim() });
    assert.equal(losses.unmergedCommits, true);
    assert.equal(typeof head, 'string');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removing a clean worktree deletes its directory and registration', async () => {
  const { root, project, worktree } = await fixture();
  try {
    await removeWorktree(project, worktree, false);
    assert.equal(await exists(worktree), false);
    assert.ok(!(await git(project, root, 'worktree', 'list', '--porcelain')).includes(worktree));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a dirty worktree is refused without force and removed with force', async () => {
  const { root, project, worktree } = await fixture();
  try {
    await writeFile(join(worktree, 'file.txt'), 'dirty\n');
    await assert.rejects(removeWorktree(project, worktree, false),
      (error: unknown) => error instanceof GitWorktreeError && error.operation === 'remove' && error.reason === 'failed');
    assert.equal(await exists(worktree), true);
    await removeWorktree(project, worktree, true);
    assert.equal(await exists(worktree), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the primary checkout is refused even when reached by path', async () => {
  const { root, project } = await fixture();
  try {
    await assert.rejects(removeWorktree(project, project, true), /primary checkout/);
    assert.equal(await exists(project), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a merged branch deletes with -d; an unmerged branch needs -D', async () => {
  const { root, project, worktree } = await fixture();
  try {
    await removeWorktree(project, worktree, false);
    await deleteBranch(project, 'feature', false);
    assert.ok(!(await branches(project, root)).includes('feature'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deleting an unmerged branch fails without force and succeeds with force', async () => {
  const { root, project, worktree } = await fixture();
  try {
    await commitOn(worktree, root, 'work');
    await removeWorktree(project, worktree, false);
    await assert.rejects(deleteBranch(project, 'feature', false),
      (error: unknown) => error instanceof GitWorktreeError && error.operation === 'branch' && error.reason === 'failed');
    assert.ok((await branches(project, root)).includes('feature'));
    await deleteBranch(project, 'feature', true);
    assert.ok(!(await branches(project, root)).includes('feature'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
