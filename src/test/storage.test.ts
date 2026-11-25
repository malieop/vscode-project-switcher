import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ProjectStore, ProjectStoreError, PROJECT_STORE_KEY } from '../projectStore';
import type { ProjectMemento } from '../projectStore';

class MemoryState implements ProjectMemento {
  value: unknown;
  failRead = false;
  failWrite = false;
  failAfterWrite = false;
  writes = 0;
  get<T>(_key: string): T | undefined {
    if (this.failRead) throw new Error('read failed');
    return this.value as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    assert.equal(key, PROJECT_STORE_KEY);
    this.writes++;
    if (this.failWrite) throw new Error('write failed');
    this.value = value;
    if (this.failAfterWrite) throw new Error('write outcome unknown');
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof ProjectStoreError && error.code === code;
}

test('persists, deduplicates aliases and removes metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-store-'));
  try {
    const folder = join(root, 'folder');
    const alias = join(root, 'alias');
    await mkdir(folder);
    await writeFile(join(folder, 'data'), 'keep');
    await symlink(folder, alias, 'dir');
    const uri = pathToFileURL(folder).href;
    const state = new MemoryState();
    const store = new ProjectStore(state);
    assert.equal((await store.add(uri)).kind, 'added');
    assert.equal((await store.add(pathToFileURL(alias).href)).kind, 'duplicate');
    assert.equal(state.writes, 1);
    assert.deepEqual(await new ProjectStore(state).getProjects(), [{ uri }]);
    assert.equal((await store.remove(uri)).kind, 'removed');
    assert.equal((await store.remove(uri)).kind, 'not-found');
    assert.equal(await readFile(join(folder, 'data'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed writes keep the confirmed list and quarantine further writes and refreshes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-failure-'));
  try {
    const first = pathToFileURL(root).href;
    const other = join(root, 'other');
    await mkdir(other);
    const state = new MemoryState();
    const store = new ProjectStore(state);
    await store.add(first);
    state.failWrite = true;
    await assert.rejects(store.add(pathToFileURL(other).href), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'write-failed');
      assert.deepEqual(error.knownProjects, [{ uri: first }]);
      return true;
    });
    await assert.rejects(store.remove(first), hasCode('write-failed'));
    assert.deepEqual(await store.getProjects(), [{ uri: first }]);
    assert.deepEqual(await new ProjectStore(state).getProjects(), [{ uri: first }]);
    state.failWrite = false;
    await assert.rejects(store.refresh(), hasCode('write-failed'));
    await assert.rejects(store.remove(first), hasCode('write-failed'));
    assert.equal((await new ProjectStore(state).remove(first)).kind, 'removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejected write that changed the memento cannot be promoted by refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-ambiguous-'));
  try {
    const state = new MemoryState();
    const store = new ProjectStore(state);
    const uri = pathToFileURL(root).href;
    assert.deepEqual(await store.getProjects(), []);
    state.failAfterWrite = true;
    await assert.rejects(store.add(uri), hasCode('write-failed'));
    await assert.rejects(store.refresh(), hasCode('write-failed'));
    assert.deepEqual(await store.getProjects(), []);
    assert.deepEqual(state.value, { version: 1, folders: [{ uri }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt and unreadable data block writes without discarding the last known list', async () => {
  const state = new MemoryState();
  const uri = pathToFileURL(tmpdir()).href;
  state.value = { version: 1, folders: [{ uri }] };
  const store = new ProjectStore(state);
  assert.deepEqual(await store.getProjects(), [{ uri }]);
  for (const value of [null, { version: 2, folders: [] }, { version: 1, folders: [{ uri: 1 }] },
    { version: 1, folders: [{ uri, future: true }] }, { version: 1, folders: [], future: true }]) {
    state.value = value;
    await assert.rejects(store.refresh(), (error: unknown) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'corrupt-data');
      assert.deepEqual(error.knownProjects, [{ uri }]);
      return true;
    });
    await assert.rejects(store.remove(uri), hasCode('corrupt-data'));
    assert.equal(state.value, value);
  }
  state.failRead = true;
  await assert.rejects(store.refresh(), hasCode('read-failed'));
  await assert.rejects(store.remove(uri), hasCode('read-failed'));
  assert.equal(state.writes, 0);
  const fresh = new ProjectStore(state);
  await assert.rejects(fresh.getProjects(), (error: unknown) => {
    assert.ok(error instanceof ProjectStoreError);
    assert.equal(error.knownProjects, undefined);
    return true;
  });
});

test('unavailable entries remain removable but block uncertain additions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-missing-'));
  try {
    const missing = pathToFileURL(join(root, 'missing')).href;
    const state = new MemoryState();
    state.value = { version: 1, folders: [{ uri: missing }] };
    const store = new ProjectStore(state);
    await assert.rejects(store.add(pathToFileURL(root).href), hasCode('identity-uncertain'));
    assert.deepEqual(await store.getProjects(), [{ uri: missing }]);
    assert.equal((await store.remove(missing)).kind, 'removed');
    assert.equal((await store.add(pathToFileURL(root).href)).kind, 'added');
    await assert.rejects(store.add(missing), hasCode('invalid-folder'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('simultaneous mutations are serialized and returned lists cannot change the store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-queue-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const a = pathToFileURL(first).href;
    const b = pathToFileURL(second).href;
    const state = new MemoryState();
    const store = new ProjectStore(state);
    const [one, two] = await Promise.all([store.add(a), store.add(b)]);
    assert.equal(one.kind, 'added');
    assert.deepEqual(two.projects, [{ uri: a }, { uri: b }]);
    const list = await store.getProjects();
    (list as { uri: string }[])[0].uri = 'changed';
    assert.deepEqual(await store.getProjects(), [{ uri: a }, { uri: b }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejected operation does not poison the operation queue', async () => {
  const state = new MemoryState();
  const store = new ProjectStore(state);
  const valid = pathToFileURL(tmpdir()).href;
  const [rejected, added] = await Promise.allSettled([
    store.add('https://example.com/remote'),
    store.add(valid)
  ]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(added.status, 'fulfilled');
  if (added.status === 'fulfilled') assert.equal(added.value.kind, 'added');
  assert.deepEqual(await store.getProjects(), [{ uri: valid }]);
});
