import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { folderIdentity, localFolderPath, sameFolderIdentity } from '../folderIdentity';

test('identifies symlinks, distinct directories, files and missing paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-identity-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const link = join(root, 'link');
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link, 'dir');
    await writeFile(join(root, 'file'), 'untouched');
    const a = await folderIdentity(pathToFileURL(first).href);
    const b = await folderIdentity(pathToFileURL(second).href);
    const alias = await folderIdentity(pathToFileURL(link).href);
    assert.equal(a.kind, 'directory');
    assert.equal(b.kind, 'directory');
    assert.equal(alias.kind, 'directory');
    if (a.kind !== 'directory' || b.kind !== 'directory' || alias.kind !== 'directory') return;
    assert.equal(sameFolderIdentity(a.identity, alias.identity), true);
    assert.equal(sameFolderIdentity(a.identity, b.identity), false);
    assert.equal((await folderIdentity(pathToFileURL(join(root, 'file')).href)).kind, 'not-directory');
    assert.equal((await folderIdentity(pathToFileURL(join(root, 'missing')).href)).kind, 'unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('respects the actual filesystem for differently cased names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-case-'));
  try {
    const upper = join(root, 'CaseFolder');
    const lower = join(root, 'casefolder');
    await mkdir(upper);
    let distinct = false;
    try { await mkdir(lower); distinct = true; } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const a = await folderIdentity(pathToFileURL(upper).href);
    const b = await folderIdentity(pathToFileURL(lower).href);
    assert.equal(a.kind, 'directory');
    assert.equal(b.kind, 'directory');
    if (a.kind !== 'directory' || b.kind !== 'directory') return;
    assert.equal(sameFolderIdentity(a.identity, b.identity), !distinct);
    assert.ok(await realpath(upper));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid and remote URIs without touching the filesystem', async () => {
  for (const uri of ['https://example.com/a', 'file://remote-host/a', 'file:relative', 'file:///a?query', 'file:///a#hash', 'file:///a%00b', 'file:///a%2Fb']) {
    assert.equal(localFolderPath(uri), undefined, uri);
    assert.equal((await folderIdentity(uri)).kind, 'invalid-uri', uri);
  }
});
