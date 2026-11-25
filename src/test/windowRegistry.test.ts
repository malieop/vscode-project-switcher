import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WindowRegistry } from '../windowRegistry';
import { switchProject, SwitchDependencies, SwitchError } from '../switchProject';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function setup(): Promise<{ dir: string; a: WindowRegistry; b: WindowRegistry; focused: () => number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-switcher-registry-'));
  let count = 0;
  const a = new WindowRegistry(dir, async () => undefined);
  const b = new WindowRegistry(dir, async () => { count++; });
  await a.start([{ uri: 'file:///one', identity: '1:1' }]);
  await b.start([{ uri: 'file:///two', identity: '1:2' }]);
  return { dir, a, b, focused: () => count };
}

async function cleanup(dir: string, ...registries: WindowRegistry[]): Promise<void> {
  await Promise.all(registries.map(registry => registry.dispose()));
  await fs.rm(dir, { recursive: true, force: true });
}

test('discovers and routes focus to the selected session', async () => {
  const { dir, a, b, focused } = await setup();
  try {
    const target = await a.find('1:2');
    assert.equal(target?.id, b.sessionId);
    await a.focus(target!, '1:2');
    assert.equal(focused(), 1);
    assert.equal((await a.find('1:1'))?.id, a.sessionId);
  } finally { await cleanup(dir, a, b); }
});

test('does not focus a window after its selected folder changes', async () => {
  const { dir, a, b, focused } = await setup();
  try {
    const target = await a.find('1:2');
    assert.ok(target);
    await b.setFolders([{ uri: 'file:///replacement', identity: '1:3' }]);
    await assert.rejects(a.focus(target, '1:2'), /could not be focused/);
    assert.equal(focused(), 0);
  } finally { await cleanup(dir, a, b); }
});

test('ignores legacy focus requests without verified folder identity', async () => {
  const { dir, a, b, focused } = await setup();
  try {
    const id = randomUUID();
    await fs.writeFile(path.join(a.root, 'inboxes', b.sessionId, `${id}.json`), JSON.stringify({
      version: 1, id, sender: a.sessionId, target: b.sessionId, expiresAt: Date.now() + 2_000
    }));
    await wait(600);
    assert.equal(focused(), 0);
  } finally { await cleanup(dir, a, b); }
});

test('simultaneous claims admit one opener and registration releases the claim', async () => {
  const { dir, a, b } = await setup();
  try {
    const results = await Promise.all([a.claim('3:4'), b.claim('3:4')]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await a.claim('3:4'), undefined);
    await b.setFolders([{ uri: 'file:///three', identity: '3:4' }]);
    assert.equal((await a.find('3:4'))?.id, b.sessionId);
    assert.equal(typeof await a.claim('3:4'), 'string');
  } finally { await cleanup(dir, a, b); }
});

test('stale matching sessions and invalid records fail closed', async () => {
  const { dir, a, b } = await setup();
  try {
    const file = path.join(a.root, 'sessions', `${b.sessionId}.json`);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as { updatedAt: number };
    record.updatedAt = 0;
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(a.find('1:2'), /could not be verified/);
    assert.equal(await a.find('unknown'), undefined);
    await fs.writeFile(file, '{invalid');
    await assert.rejects(a.list());
  } finally { await cleanup(dir, a, b); }
});

test('composes its root under the given storage path', () => {
  const registry = new WindowRegistry('/tmp/shared-root', async () => undefined);
  assert.equal(registry.root, path.join('/tmp/shared-root', 'window-registry-v1'));
});

test('removes stale session records whose process is dead', async () => {
  const { dir, a, b } = await setup();
  try {
    const ghost = { version: 1, id: randomUUID(), pid: 2 ** 30, updatedAt: 0,
      folders: [{ uri: 'file:///gone', identity: '6:7' }] };
    const file = path.join(a.root, 'sessions', `${ghost.id}.json`);
    await fs.writeFile(file, JSON.stringify(ghost));
    assert.equal(await a.find('6:7'), undefined);
    assert.equal(await fs.stat(file).then(() => true, () => false), false);
  } finally { await cleanup(dir, a, b); }
});

test('reclaims an abandoned claim after its ttl', async () => {
  const { dir, a, b } = await setup();
  try {
    assert.ok(await a.claim('7:8'));
    assert.equal(await b.claim('7:8'), undefined);
    const lock = path.join(a.root, 'claims', `${createHash('sha256').update('7:8').digest('hex')}.json`);
    const past = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lock, past, past);
    assert.ok(await b.claim('7:8'));
    assert.equal(await a.claim('7:8'), undefined);
  } finally { await cleanup(dir, a, b); }
});

test('start sweeps invalid records, expired claims, and stale guards', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-switcher-registry-'));
  const seed = new WindowRegistry(dir, async () => undefined);
  await seed.start([{ uri: 'file:///seed', identity: '1:9' }]);
  assert.ok(await seed.claim('1:10'));
  const key = createHash('sha256').update('1:10').digest('hex');
  const root = path.join(dir, 'window-registry-v1');
  const lock = path.join(root, 'claims', `${key}.json`);
  const guard = path.join(root, 'claims', `${key}.guard`);
  await fs.writeFile(path.join(root, 'sessions', 'not-a-uuid.json'), '{}');
  await fs.mkdir(guard);
  const past = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lock, past, past);
  await fs.utimes(guard, past, past);
  await seed.dispose();
  const fresh = new WindowRegistry(dir, async () => undefined);
  try {
    await fresh.start([{ uri: 'file:///fresh', identity: '1:11' }]);
    assert.ok(await fresh.list());
    assert.ok(await fresh.claim('1:10'));
  } finally { await cleanup(dir, fresh); }
});

test('only the owner can release an unstarted open claim', async () => {
  const { dir, a, b } = await setup();
  try {
    const claim = await a.claim('5:6');
    assert.ok(claim);
    await b.releaseUnstartedClaim('5:6', randomUUID());
    assert.equal(await b.claim('5:6'), undefined);
    await a.releaseUnstartedClaim('5:6', claim);
    assert.ok(await b.claim('5:6'));
  } finally { await cleanup(dir, a, b); }
});

test('rejects expired or misaddressed focus requests', async () => {
  const { dir, a, b, focused } = await setup();
  try {
    for (const [target, expiresAt] of [[b.sessionId, 0], [a.sessionId, Date.now() + 2_000]] as const) {
      const id = randomUUID();
      await fs.writeFile(path.join(a.root, 'inboxes', b.sessionId, `${id}.json`), JSON.stringify({
        version: 2, id, sender: a.sessionId, target, identity: '1:2', expiresAt
      }));
    }
    await wait(600);
    assert.equal(focused(), 0);
  } finally { await cleanup(dir, a, b); }
});

test('does not silently succeed when target session is unavailable', async () => {
  const { dir, a, b } = await setup();
  try {
    const target = await a.find('1:2');
    await b.dispose();
    await assert.rejects(a.focus(target!, '1:2'));
  } finally { await cleanup(dir, a, b); }
});

test('concurrent switch handlers issue at most one open for the same folder', async () => {
  const { dir, a, b } = await setup();
  const targets: WindowRegistry[] = [];
  try {
    for (let trial = 0; trial < 10; trial++) {
      const identity = `9:${trial}`;
      let opens = 0;
      const dependencies = (registry: WindowRegistry): SwitchDependencies => ({
        identify: async () => identity,
        isCurrent: async () => false,
        find: id => registry.find(id),
        focus: (record, identity) => registry.focus(record, identity),
        choose: async () => 'new',
        claim: id => registry.claim(id),
        releaseUnstartedClaim: (id, token) => registry.releaseUnstartedClaim(id, token),
        revalidate: async () => true,
        open: async () => {
          opens++;
          const target = new WindowRegistry(dir, async () => undefined);
          targets.push(target);
          await target.start([{ uri: `file:///target-${trial}`, identity }]);
        },
        waitForRegistration: async id => Boolean(await registry.find(id))
      });
      const outcomes = await Promise.allSettled([switchProject(dependencies(a)), switchProject(dependencies(b))]);
      assert.equal(opens, 1);
      assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled' && outcome.value === 'opened'));
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof SwitchError && outcome.reason.stage === 'busy');
      }
    }
  } finally { await cleanup(dir, a, b, ...targets); }
});

test('opens a project whose previous window process is dead', async () => {
  const { dir, a, b } = await setup();
  const targets: WindowRegistry[] = [];
  try {
    const ghost = { version: 1, id: randomUUID(), pid: 2 ** 30, updatedAt: 0,
      folders: [{ uri: 'file:///gone', identity: '8:8' }] };
    await fs.writeFile(path.join(a.root, 'sessions', `${ghost.id}.json`), JSON.stringify(ghost));
    const dependencies: SwitchDependencies = {
      identify: async () => '8:8',
      isCurrent: async () => false,
      find: id => a.find(id),
      focus: (record, identity) => a.focus(record, identity),
      choose: async () => 'new',
      claim: id => a.claim(id),
      releaseUnstartedClaim: (id, token) => a.releaseUnstartedClaim(id, token),
      revalidate: async () => true,
      open: async () => {
        const target = new WindowRegistry(dir, async () => undefined);
        targets.push(target);
        await target.start([{ uri: 'file:///gone', identity: '8:8' }]);
      },
      waitForRegistration: async id => Boolean(await a.find(id))
    };
    assert.equal(await switchProject(dependencies), 'opened');
  } finally { await cleanup(dir, a, b, ...targets); }
});
