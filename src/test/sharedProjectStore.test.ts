import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ProjectMemento, ProjectStoreError, PROJECT_STORE_KEY } from '../projectStore';
import { SharedProjectStore } from '../sharedProjectStore';

class State implements ProjectMemento {
  readsFail = false;
  writes = 0;
  constructor(public value: unknown) {}
  get<T>(key: string): T | undefined {
    assert.equal(key, PROJECT_STORE_KEY);
    if (this.readsFail) throw new Error('injected read failure');
    return this.value as T | undefined;
  }
  async update(): Promise<void> { this.writes++; throw new Error('legacy state must not be changed'); }
}

const legacy = (...uris: string[]): State => new State({ version: 1, folders: uris.map(uri => ({ uri })) });
const asUri = (path: string): string => pathToFileURL(path).href;
const file = (root: string): string => join(root, 'shared-projects-v1', 'projects.json');
const hasCode = (code: string) => (error: unknown): boolean => error instanceof ProjectStoreError && error.code === code;

test('concurrent stores coordinate additions, removals, refreshes and private permissions', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-concurrent-'));
  try {
    const folders = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const folder = join(root, `project-${i}`);
      await fs.mkdir(folder);
      return asUri(folder);
    }));
    const stores = folders.map(() => new SharedProjectStore(root));
    const additions = await Promise.all(stores.map((store, i) => store.add(folders[i])));
    assert.ok(additions.every(result => result.kind === 'added'));
    assert.deepEqual(new Set((await stores[0].refresh()).map(project => project.uri)), new Set(folders));
    const removals = await Promise.all(stores.slice(0, 5).map((store, i) => store.remove(folders[i])));
    assert.ok(removals.every(result => result.kind === 'removed'));
    assert.deepEqual(new Set((await new SharedProjectStore(root).getProjects()).map(p => p.uri)), new Set(folders.slice(5)));
    assert.equal((await fs.stat(join(root, 'shared-projects-v1'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file(root))).mode & 0o777, 0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('lock serializes edits from separate processes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-processes-'));
  try {
    const uris: string[] = [];
    for (let i = 0; i < 4; i++) {
      const folder = join(root, `folder-${i}`);
      await fs.mkdir(folder);
      uris.push(asUri(folder));
    }
    const script = `const { SharedProjectStore } = require(process.argv[1]);
      new SharedProjectStore(process.argv[2]).add(process.argv[3]).catch(e => { console.error(e); process.exitCode = 1; });`;
    const run = (uri: string): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, require.resolve('../sharedProjectStore'), root, uri]);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });
    await Promise.all(uris.map(run));
    assert.deepEqual(new Set((await new SharedProjectStore(root).getProjects()).map(p => p.uri)), new Set(uris));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('migrates multiple profiles, deduplicates verified aliases and retains missing and non-Git paths', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-profiles-'));
  try {
    const real = join(root, 'real');
    const alias = join(root, 'alias');
    const second = join(root, 'ordinary-non-git');
    const missing = asUri(join(root, 'missing'));
    await fs.mkdir(real);
    await fs.mkdir(second);
    await fs.symlink(real, alias, 'dir');
    const a = asUri(real);
    const b = asUri(alias);
    const c = asUri(second);
    const first = legacy(a, missing);
    const other = legacy(b, c);
    assert.deepEqual(await new SharedProjectStore(root, first).getProjects(), [{ uri: a }, { uri: missing }]);
    assert.deepEqual(await new SharedProjectStore(root, other).getProjects(), [{ uri: a }, { uri: missing }, { uri: c }]);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await new SharedProjectStore(root, i % 2 ? other : first).refresh(), [{ uri: a }, { uri: missing }, { uri: c }]);
    }
    assert.equal(first.writes + other.writes, 0);
    assert.deepEqual(first.value, { version: 1, folders: [{ uri: a }, { uri: missing }] });
    assert.deepEqual(other.value, { version: 1, folders: [{ uri: b }, { uri: c }] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('removal tombstones block retries and later profile alias migration; explicit re-add works', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-tombstones-'));
  try {
    const folder = join(root, 'folder');
    const alias = join(root, 'alias');
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, 'data'), 'keep');
    await fs.symlink(folder, alias, 'dir');
    const a = asUri(folder);
    const b = asUri(alias);
    const first = legacy(a);
    const later = legacy(b);
    const store = new SharedProjectStore(root, first);
    assert.deepEqual(await store.getProjects(), [{ uri: a }]);
    assert.equal((await store.remove(a)).kind, 'removed');
    assert.deepEqual(await new SharedProjectStore(root, first).getProjects(), []);
    await assert.rejects(new SharedProjectStore(root, later).getProjects(), hasCode('identity-uncertain'));
    assert.equal((await new SharedProjectStore(root, later).add(b)).kind, 'added');
    assert.deepEqual(await new SharedProjectStore(root, later).getProjects(), [{ uri: b }]);
    assert.equal(await fs.readFile(join(folder, 'data'), 'utf8'), 'keep');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('re-adding a retargeted removed path never restores its old target from another profile', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-retargeted-tombstone-'));
  try {
    const x = join(root, 'repository-x');
    const y = join(root, 'repository-y');
    const project = join(root, 'project');
    await fs.mkdir(x);
    await fs.mkdir(y);
    await fs.writeFile(join(x, 'keep'), 'x');
    await fs.writeFile(join(y, 'keep'), 'y');
    await fs.symlink(x, project, 'dir');
    const a = asUri(project);
    const xUri = asUri(x);
    const profileA = legacy(a);
    const store = new SharedProjectStore(root, profileA);
    assert.deepEqual(await store.getProjects(), [{ uri: a }]);
    assert.deepEqual(await store.remove(a), { kind: 'removed', projects: [] });
    await fs.unlink(project);
    await fs.symlink(y, project, 'dir');
    const profileB = legacy(xUri);
    const beforeAdd = await fs.readFile(file(root), 'utf8');
    await assert.rejects(new SharedProjectStore(root, profileB).getProjects(), hasCode('identity-uncertain'));
    assert.equal(await fs.readFile(file(root), 'utf8'), beforeAdd);
    assert.deepEqual(await store.add(a), { kind: 'added', projects: [{ uri: a }] });
    const after = await fs.readFile(file(root), 'utf8');
    assert.ok((JSON.parse(after) as { tombstones: string[] }).tombstones.includes(a));
    for (let i = 0; i < 3; i++) {
      await assert.rejects(new SharedProjectStore(root, profileB).getProjects(), (error: unknown) => {
        assert.ok(error instanceof ProjectStoreError);
        assert.equal(error.code, 'identity-uncertain');
        assert.ok(error.message.includes(a));
        assert.ok(error.message.includes(xUri));
        assert.ok(error.message.includes('explicitly'));
        assert.deepEqual(error.knownProjects, [{ uri: a }]);
        return true;
      });
    }
    assert.equal(await fs.readFile(file(root), 'utf8'), after);
    assert.deepEqual(await new SharedProjectStore(root, profileA).getProjects(), [{ uri: a }]);
    assert.equal(await fs.readFile(join(x, 'keep'), 'utf8'), 'x');
    assert.equal(await fs.readFile(join(y, 'keep'), 'utf8'), 'y');
    assert.deepEqual(profileB.value, { version: 1, folders: [{ uri: xUri }] });
    assert.equal(profileA.writes + profileB.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('existing version 1 tombstones remain safe after a path is replaced and explicitly added', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-v1-tombstone-'));
  try {
    const oldTarget = join(root, 'old');
    const newTarget = join(root, 'new');
    const project = join(root, 'project');
    await fs.mkdir(oldTarget);
    await fs.mkdir(newTarget);
    await fs.symlink(newTarget, project, 'dir');
    await new SharedProjectStore(root).getProjects();
    const previous = { version: 1, folders: [], tombstones: [asUri(project)] };
    await fs.writeFile(file(root), JSON.stringify(previous));
    const store = new SharedProjectStore(root);
    assert.deepEqual(await store.add(asUri(project)), { kind: 'added', projects: [{ uri: asUri(project) }] });
    const after = await fs.readFile(file(root), 'utf8');
    assert.deepEqual((JSON.parse(after) as { tombstones: string[] }).tombstones, [asUri(project)]);
    const state = legacy(asUri(oldTarget));
    await assert.rejects(new SharedProjectStore(root, state).getProjects(), hasCode('identity-uncertain'));
    assert.equal(await fs.readFile(file(root), 'utf8'), after);
    assert.equal(state.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unavailable tombstone blocks an ambiguous late alias, never silently restores it', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-uncertain-'));
  try {
    const folder = join(root, 'folder');
    const alias = join(root, 'alias');
    await fs.mkdir(folder);
    await fs.symlink(folder, alias, 'dir');
    const a = asUri(alias);
    const b = asUri(folder);
    const first = legacy(a);
    const store = new SharedProjectStore(root, first);
    await store.getProjects();
    await store.remove(a);
    await fs.unlink(alias);
    const before = await fs.readFile(file(root), 'utf8');
    const later = legacy(b);
    await assert.rejects(new SharedProjectStore(root, later).getProjects(), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'identity-uncertain');
      assert.deepEqual(error.knownProjects, []);
      return true;
    });
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
    assert.deepEqual(await new SharedProjectStore(root, first).getProjects(), []);
    // The user can explicitly add the path, without silently importing it.
    assert.equal((await new SharedProjectStore(root, later).add(b)).kind, 'added');
    assert.deepEqual(await new SharedProjectStore(root, later).getProjects(), [{ uri: b }]);
    assert.equal(later.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a removed unavailable project does not block explicitly adding another project', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-add-after-missing-'));
  try {
    const missing = asUri(join(root, 'gone'));
    const other = join(root, 'other');
    await fs.mkdir(other);
    const state = legacy(missing);
    const store = new SharedProjectStore(root, state);
    assert.deepEqual(await store.getProjects(), [{ uri: missing }]);
    assert.equal((await store.remove(missing)).kind, 'removed');
    assert.equal((await store.add(asUri(other))).kind, 'added');
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: asUri(other) }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a failed first migration never reports an unconfirmed empty list', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-first-failure-'));
  try {
    const state = legacy(asUri(root));
    const store = new SharedProjectStore(root, state);
    const nativeFs = require('node:fs/promises') as typeof fs;
    const injected = mock.method(nativeFs, 'rename', async () => { throw new Error('injected rename failure'); });
    try {
      await assert.rejects(store.getProjects(), (error: unknown) => {
        assert.ok(error instanceof ProjectStoreError);
        assert.equal(error.code, 'write-failed');
        assert.equal(error.knownProjects, undefined);
        return true;
      });
      await assert.rejects(store.getProjects(), hasCode('write-failed'));
    } finally { injected.mock.restore(); }
    await assert.rejects(fs.stat(join(root, 'shared-projects-v1', 'initialized')), { code: 'ENOENT' });
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: asUri(root) }] });
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: asUri(root) }]);
  } finally { mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a later ambiguous legacy entry prevents partial migration', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-migration-atomic-'));
  try {
    const removed = join(root, 'removed');
    const valid = join(root, 'valid');
    await fs.mkdir(removed);
    await fs.mkdir(valid);
    const state = legacy(asUri(removed));
    const store = new SharedProjectStore(root, state);
    await store.getProjects();
    await store.remove(asUri(removed));
    const before = await fs.readFile(file(root), 'utf8');
    const later = legacy(asUri(valid), asUri(join(root, 'unavailable')));
    await assert.rejects(new SharedProjectStore(root, later).getProjects(), hasCode('identity-uncertain'));
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), []);
    assert.equal(later.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('removed known aliases remain tombstoned even if the primary path disappears', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-known-alias-'));
  try {
    const folder = join(root, 'folder');
    const alias = join(root, 'alias');
    await fs.mkdir(folder);
    await fs.symlink(folder, alias, 'dir');
    const a = asUri(alias);
    const b = asUri(folder);
    const store = new SharedProjectStore(root, legacy(a, b));
    assert.deepEqual(await store.getProjects(), [{ uri: a }]);
    await store.remove(a);
    await fs.unlink(alias);
    assert.deepEqual(await new SharedProjectStore(root, legacy(b)).getProjects(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a previously confirmed alias that is retargeted becomes a separate project', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-retarget-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const alias = join(root, 'alias');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.symlink(first, alias, 'dir');
    const state = legacy(asUri(first), asUri(alias));
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: asUri(first) }]);
    await fs.unlink(alias);
    await fs.symlink(second, alias, 'dir');
    assert.deepEqual(await new SharedProjectStore(root, state).refresh(), [{ uri: asUri(first) }, { uri: asUri(alias) }]);
    assert.deepEqual(await new SharedProjectStore(root, state).refresh(), [{ uri: asUri(first) }, { uri: asUri(alias) }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('removal preserves a provably retargeted alias without tombstoning it', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-remove-retarget-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const alias = join(root, 'alias');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.writeFile(join(first, 'keep'), 'first');
    await fs.writeFile(join(second, 'keep'), 'second');
    await fs.symlink(first, alias, 'dir');
    const state = legacy(asUri(first), asUri(alias));
    await new SharedProjectStore(root, state).getProjects();
    await fs.unlink(alias);
    await fs.symlink(second, alias, 'dir');
    const result = await new SharedProjectStore(root).remove(asUri(first));
    assert.deepEqual(result, { kind: 'removed', projects: [{ uri: asUri(alias) }] });
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: asUri(alias) }]);
    }
    assert.equal(await fs.readFile(join(first, 'keep'), 'utf8'), 'first');
    assert.equal(await fs.readFile(join(second, 'keep'), 'utf8'), 'second');
    assert.equal(state.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('removal does not restore a retargeted alias that may match another tombstone', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-remove-retarget-tombstone-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const alias = join(root, 'alias');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.symlink(first, alias, 'dir');
    const initial = legacy(asUri(first), asUri(alias), asUri(second));
    const store = new SharedProjectStore(root, initial);
    await store.getProjects();
    await store.remove(asUri(second));
    await fs.unlink(alias);
    await fs.symlink(second, alias, 'dir');
    const before = await fs.readFile(file(root), 'utf8');
    await assert.rejects(new SharedProjectStore(root).remove(asUri(first)), hasCode('identity-uncertain'));
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unavailable formerly confirmed alias blocks reconciliation and removal without losing data', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-alias-missing-'));
  try {
    const folder = join(root, 'folder');
    const alias = join(root, 'alias');
    await fs.mkdir(folder);
    await fs.symlink(folder, alias, 'dir');
    const state = legacy(asUri(folder), asUri(alias));
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: asUri(folder) }]);
    await fs.unlink(alias);
    const before = await fs.readFile(file(root), 'utf8');
    await assert.rejects(new SharedProjectStore(root, state).getProjects(), hasCode('identity-uncertain'));
    // Even a profile without the alias's legacy state must not tombstone an
    // alias whose present identity can no longer be established.
    await assert.rejects(new SharedProjectStore(root).remove(asUri(folder)), hasCode('identity-uncertain'));
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
    await fs.symlink(folder, alias, 'dir');
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: asUri(folder) }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unavailable primary with a known alias requires an explicit ambiguity decision', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-primary-missing-'));
  try {
    const folder = join(root, 'folder');
    const primary = join(root, 'primary');
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, 'keep'), 'unchanged');
    await fs.symlink(folder, primary, 'dir');
    const state = legacy(asUri(primary), asUri(folder));
    const store = new SharedProjectStore(root, state);
    assert.deepEqual(await store.getProjects(), [{ uri: asUri(primary) }]);
    await fs.unlink(primary);
    const before = await fs.readFile(file(root), 'utf8');
    await assert.rejects(store.remove(asUri(primary)), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'identity-uncertain');
      assert.ok(error.message.includes(asUri(primary)));
      assert.ok(error.message.includes(asUri(folder)));
      assert.deepEqual(error.knownProjects, [{ uri: asUri(primary) }]);
      return true;
    });
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
    assert.equal(await fs.readFile(join(folder, 'keep'), 'utf8'), 'unchanged');
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: asUri(primary) }, { uri: asUri(folder) }] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unavailable saved entry can be removed despite unrelated blocked legacy migration', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-remove-blocked-import-'));
  try {
    const old = join(root, 'old');
    const primary = join(root, 'primary');
    const unknown = join(root, 'legacy-unavailable');
    await fs.mkdir(old);
    await fs.mkdir(primary);
    const store = new SharedProjectStore(root);
    await store.add(asUri(old));
    await store.remove(asUri(old));
    await store.add(asUri(primary));
    await fs.rename(primary, join(root, 'primary-moved'));
    const state = legacy(asUri(unknown));
    const participating = new SharedProjectStore(root, state);
    await assert.rejects(participating.getProjects(), hasCode('identity-uncertain'));
    assert.deepEqual(await participating.remove(asUri(primary)), { kind: 'removed', projects: [] });
    // Nothing was silently imported or dropped: the later migration remains
    // blocked, with the removal and the untouched legacy entry both retained.
    const after = await fs.readFile(file(root), 'utf8');
    for (let i = 0; i < 2; i++) {
      await assert.rejects(new SharedProjectStore(root, state).getProjects(), (error: unknown) => {
        assert.ok(error instanceof ProjectStoreError);
        assert.equal(error.code, 'identity-uncertain');
        assert.deepEqual(error.knownProjects, []);
        assert.ok(error.message.includes(asUri(unknown)));
        assert.ok(error.message.includes(asUri(old)));
        return true;
      });
    }
    assert.equal(await fs.readFile(file(root), 'utf8'), after);
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: asUri(unknown) }] });
    assert.equal(state.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('removing an unavailable primary defers a newly encountered possible alias', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-remove-new-alias-'));
  try {
    const folder = join(root, 'folder');
    const primary = join(root, 'primary');
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, 'keep'), 'unchanged');
    await fs.symlink(folder, primary, 'dir');
    await new SharedProjectStore(root).add(asUri(primary));
    await fs.unlink(primary);
    const state = legacy(asUri(folder));
    const store = new SharedProjectStore(root, state);
    assert.deepEqual(await store.remove(asUri(primary)), { kind: 'removed', projects: [] });
    const after = await fs.readFile(file(root), 'utf8');
    for (let i = 0; i < 2; i++) {
      await assert.rejects(new SharedProjectStore(root, state).getProjects(), (error: unknown) => {
        assert.ok(error instanceof ProjectStoreError);
        assert.equal(error.code, 'identity-uncertain');
        assert.deepEqual(error.knownProjects, []);
        assert.ok(error.message.includes(asUri(folder)));
        assert.ok(error.message.includes(asUri(primary)));
        return true;
      });
    }
    assert.equal(await fs.readFile(file(root), 'utf8'), after);
    assert.equal(await fs.readFile(join(folder, 'keep'), 'utf8'), 'unchanged');
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: asUri(folder) }] });
    assert.equal(state.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('blocked migration is not ignored for missing targets or corrupt legacy state', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-remove-fallback-errors-'));
  try {
    const old = asUri(join(root, 'old'));
    const primary = asUri(root);
    const store = new SharedProjectStore(root);
    await store.add(primary);
    // Record an unavailable tombstone without changing project directories.
    const state = legacy(old);
    const initial = new SharedProjectStore(root, state);
    await initial.getProjects();
    await initial.remove(old);
    const blocked = new SharedProjectStore(root, legacy(asUri(join(root, 'other-missing'))));
    const before = await fs.readFile(file(root), 'utf8');
    await assert.rejects(blocked.remove(asUri(join(root, 'not-saved'))), hasCode('identity-uncertain'));
    await assert.rejects(new SharedProjectStore(root, new State({ invalid: true })).remove(primary), hasCode('corrupt-data'));
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing entries remain visible and removable, and block uncertain new additions', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-missing-'));
  try {
    const missing = asUri(join(root, 'gone'));
    const state = legacy(missing);
    const store = new SharedProjectStore(root, state);
    assert.deepEqual(await store.getProjects(), [{ uri: missing }]);
    await assert.rejects(store.add(asUri(root)), hasCode('identity-uncertain'));
    assert.equal((await store.remove(missing)).kind, 'removed');
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('corruption and failed legacy reads preserve confirmed and on-disk data', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-corrupt-'));
  try {
    const a = asUri(root);
    const state = legacy(a);
    const store = new SharedProjectStore(root, state);
    await store.getProjects();
    const original = await fs.readFile(file(root), 'utf8');
    state.readsFail = true;
    await assert.rejects(store.refresh(), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'read-failed');
      assert.deepEqual(error.knownProjects, [{ uri: a }]);
      return true;
    });
    assert.equal(await fs.readFile(file(root), 'utf8'), original);
    state.readsFail = false;
    await fs.writeFile(file(root), '{broken');
    await assert.rejects(store.refresh(), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'corrupt-data');
      assert.deepEqual(error.knownProjects, [{ uri: a }]);
      return true;
    });
    await assert.rejects(store.remove(a), hasCode('corrupt-data'));
    assert.equal(await fs.readFile(file(root), 'utf8'), '{broken');
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: a }] });
    await fs.writeFile(file(root), original);
    assert.deepEqual(await store.refresh(), [{ uri: a }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a shared file that disappears during a store instance is not treated as first use', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-disappeared-'));
  try {
    const a = asUri(root);
    const state = legacy(a);
    const store = new SharedProjectStore(root, state);
    await store.getProjects();
    const saved = await fs.readFile(file(root), 'utf8');
    await fs.unlink(file(root));
    await assert.rejects(store.refresh(), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'read-failed');
      assert.deepEqual(error.knownProjects, [{ uri: a }]);
      return true;
    });
    await assert.rejects(store.remove(a), hasCode('read-failed'));
    await assert.rejects(new SharedProjectStore(root, state).getProjects(), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'read-failed');
      assert.equal(error.knownProjects, undefined);
      return true;
    });
    await assert.rejects(fs.stat(file(root)), { code: 'ENOENT' });
    await fs.writeFile(file(root), saved, { mode: 0o600 });
    assert.deepEqual(await store.refresh(), [{ uri: a }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('uncertain replacement retains the last confirmed list and quarantines the instance', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-failure-'));
  try {
    const folder = join(root, 'folder');
    await fs.mkdir(folder);
    const a = asUri(folder);
    const state = legacy(a);
    const store = new SharedProjectStore(root, state);
    assert.deepEqual(await store.getProjects(), [{ uri: a }]);
    // Simulate an error after the kernel completed the atomic replacement.
    const nativeFs = require('node:fs/promises') as typeof fs;
    const originalRename = nativeFs.rename;
    const injected = mock.method(nativeFs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      await originalRename(from, to);
      throw new Error('injected uncertain rename');
    });
    try {
      await assert.rejects(store.remove(a), (error: unknown) => {
        assert.ok(error instanceof ProjectStoreError);
        assert.equal(error.code, 'write-failed');
        assert.deepEqual(error.knownProjects, [{ uri: a }]);
        return true;
      });
    } finally { injected.mock.restore(); }
    assert.deepEqual(await store.getProjects(), [{ uri: a }]);
    await assert.rejects(store.refresh(), hasCode('write-failed'));
    await assert.rejects(store.remove(a), hasCode('write-failed'));
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), []);
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: a }] });
    assert.equal(state.writes, 0);
  } finally { mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test('failed replacement before rename leaves the original bytes and legacy state intact', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-prerename-'));
  try {
    const folder = join(root, 'folder');
    await fs.mkdir(folder);
    const a = asUri(folder);
    const state = legacy(a);
    const store = new SharedProjectStore(root, state);
    await store.getProjects();
    const original = await fs.readFile(file(root), 'utf8');
    const nativeFs = require('node:fs/promises') as typeof fs;
    const injected = mock.method(nativeFs, 'rename', async () => { throw new Error('injected rename failure'); });
    try { await assert.rejects(store.remove(a), hasCode('write-failed')); }
    finally { injected.mock.restore(); }
    assert.equal(await fs.readFile(file(root), 'utf8'), original);
    assert.deepEqual(await store.getProjects(), [{ uri: a }]);
    assert.deepEqual(await new SharedProjectStore(root, state).getProjects(), [{ uri: a }]);
    assert.deepEqual(state.value, { version: 1, folders: [{ uri: a }] });
  } finally { mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test('an abandoned or ambiguous lock is not reclaimed automatically', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-lock-'));
  try {
    const store = new SharedProjectStore(root);
    await store.getProjects();
    const before = await fs.readFile(file(root), 'utf8');
    const lock = join(root, 'shared-projects-v1', 'write.lock');
    await fs.mkdir(lock, { mode: 0o700 });
    await fs.writeFile(join(lock, 'unknown-owner'), 'do not remove', { mode: 0o600 });
    await assert.rejects(store.add(asUri(root)), hasCode('write-failed'));
    assert.equal(await fs.readFile(file(root), 'utf8'), before);
    assert.equal(await fs.readFile(join(lock, 'unknown-owner'), 'utf8'), 'do not remove');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects oversized or invalid files and invalid legacy formats without overwriting them', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'shared-projects-invalid-'));
  try {
    const store = new SharedProjectStore(root);
    await store.getProjects();
    const huge = 'x'.repeat(1024 * 1024 + 1);
    await fs.writeFile(file(root), huge);
    await assert.rejects(store.refresh(), hasCode('corrupt-data'));
    assert.equal(await fs.readFile(file(root), 'utf8'), huge);
    await fs.writeFile(file(root), JSON.stringify({ version: 2, folders: [], tombstones: [] }));
    await assert.rejects(store.add(asUri(root)), hasCode('corrupt-data'));
    const unsupported = await fs.readFile(file(root), 'utf8');
    assert.equal(JSON.parse(unsupported).version, 2);
    await fs.writeFile(file(root), JSON.stringify({ version: 1, folders: [], tombstones: [] }));
    const bad = new State({ version: 1, folders: [{ uri: asUri(root), unknown: true }] });
    await assert.rejects(new SharedProjectStore(root, bad).getProjects(), hasCode('corrupt-data'));
    assert.equal(await fs.readFile(file(root), 'utf8'), JSON.stringify({ version: 1, folders: [], tombstones: [] }));
    assert.equal(bad.writes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
