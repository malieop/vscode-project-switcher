import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildCheckoutModel, validatePrimaryCheckout } from '../checkoutModel';
import type { GitWorktree } from '../gitDiscovery';

function tree(path: string, branch?: string, detached = false): GitWorktree {
  return { path, branch, detached, bare: false, locked: false, prunable: false };
}

test('groups the selected primary checkout and linked worktrees by identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-checkouts-'));
  try {
    const primary = join(root, 'project');
    const alias = join(root, 'project-alias');
    const linked = join(root, 'external-worktree');
    const missing = join(root, 'missing-worktree');
    await mkdir(primary);
    await mkdir(linked);
    await symlink(primary, alias, 'dir');
    const selected = pathToFileURL(alias).href;
    const rows = await buildCheckoutModel(selected, pathToFileURL(linked).href, [
      tree(primary, 'main'), tree(linked, 'feature/login'), tree(missing, undefined, true)
    ]);
    assert.deepEqual(rows, [
      { uri: selected, primary: true, available: true, current: false, branch: 'main' },
      { uri: pathToFileURL(linked).href, primary: false, available: true, current: true, branch: 'feature/login' },
      { uri: pathToFileURL(missing).href, primary: false, available: false, current: false, branch: 'Detached HEAD' }
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not present an unrelated folder or bare repository as a checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-checkouts-invalid-'));
  try {
    const other = join(root, 'other');
    await mkdir(other);
    await assert.rejects(buildCheckoutModel(pathToFileURL(root).href, undefined, [tree(other, 'main')]), /checkout root/);
    await assert.rejects(buildCheckoutModel(pathToFileURL(root).href, undefined, [{ ...tree(root), bare: true }]), /Bare/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new projects must identify Git’s main checkout, allowing aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-primary-'));
  try {
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    const alias = join(root, 'alias');
    await mkdir(main);
    await mkdir(linked);
    await symlink(main, alias, 'dir');
    const trees = [tree(main, 'main'), tree(linked, 'feature')];
    await validatePrimaryCheckout(pathToFileURL(alias).href, trees);
    await assert.rejects(validatePrimaryCheckout(pathToFileURL(linked).href, trees), /main Git checkout/);
    await assert.rejects(validatePrimaryCheckout(pathToFileURL(main).href, [{ ...tree(main), bare: true }]), /non-bare/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a legacy saved worktree does not become the main checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-legacy-checkout-'));
  try {
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    await mkdir(main);
    await mkdir(linked);
    const rows = await buildCheckoutModel(pathToFileURL(linked).href, undefined, [tree(main, 'main'), tree(linked, 'feature')]);
    assert.equal(rows[0].primary, true);
    assert.equal(rows[0].uri, pathToFileURL(main).href);
    assert.equal(rows[1].primary, false);
    assert.equal(rows[1].uri, pathToFileURL(linked).href);
  } finally { await rm(root, { recursive: true, force: true }); }
});
