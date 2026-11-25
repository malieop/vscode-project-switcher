import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { destinationExists, inspectProjectDirectory, validDirectoryComponent, worktreeDestination } from '../worktreeDestination';

test('builds a destination under the selected parent with safe components', () => {
  const root = join(tmpdir(), 'worktrees');
  assert.equal(worktreeDestination(root, 'project-a', 'feature-login'), join(root, 'project-a', 'feature-login'));
  for (const bad of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'x\0y', 'CON', 'folder.', 'name ']) {
    assert.equal(validDirectoryComponent(bad), false, bad);
    assert.throws(() => worktreeDestination(root, 'project', bad));
  }
  assert.throws(() => worktreeDestination('relative', 'project', 'branch'));
});

test('identifies existing project groups and rejects symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-group-'));
  try {
    const absent = await inspectProjectDirectory(root, 'project');
    assert.ok(absent.rootIdentity);
    assert.equal(absent.groupIdentity, undefined);
    await mkdir(join(root, 'project'));
    const existing = await inspectProjectDirectory(root, 'project');
    assert.equal(existing.rootIdentity, absent.rootIdentity);
    assert.ok(existing.groupIdentity);
    await symlink(join(root, 'project'), join(root, 'link'));
    await assert.rejects(inspectProjectDirectory(root, 'link'), /not a symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('treats files, directories, and broken symlinks as occupied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-destination-'));
  try {
    const directory = join(root, 'project');
    const link = join(root, 'link');
    const file = join(root, 'file');
    await mkdir(directory);
    await writeFile(file, 'keep');
    await symlink(join(root, 'missing'), link);
    assert.equal(await destinationExists(directory), true);
    assert.equal(await destinationExists(file), true);
    assert.equal(await destinationExists(link), true);
    assert.equal(await destinationExists(join(root, 'missing')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
