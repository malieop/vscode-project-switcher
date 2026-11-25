import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CloseError, WindowRecord, WindowRegistry } from '../windowRegistry';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function setup(closeSelf?: () => Promise<void>): Promise<{ dir: string; a: WindowRegistry; b: WindowRegistry }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-switcher-close-'));
  const a = new WindowRegistry(dir, async () => undefined);
  const b = new WindowRegistry(dir, async () => undefined, closeSelf);
  await a.start([{ uri: 'file:///one', identity: '1:1' }]);
  await b.start([{ uri: 'file:///two', identity: '1:2' }]);
  return { dir, a, b };
}

async function cleanup(dir: string, ...registries: WindowRegistry[]): Promise<void> {
  await Promise.all(registries.map(registry => registry.dispose().catch(() => undefined)));
  await fs.rm(dir, { recursive: true, force: true });
}

/** A live-looking record with no extension behind it: nothing ever polls its inbox. */
async function plantGhost(registry: WindowRegistry, updatedAt = Date.now()): Promise<WindowRecord> {
  const ghost: WindowRecord = { version: 1, id: randomUUID(), pid: process.pid, updatedAt,
    folders: [{ uri: 'file:///ghost', identity: '9:9' }] };
  await fs.writeFile(path.join(registry.root, 'sessions', `${ghost.id}.json`), JSON.stringify(ghost));
  await fs.mkdir(path.join(registry.root, 'inboxes', ghost.id), { recursive: true });
  return ghost;
}

test('closes the target window and confirms by record removal', async () => {
  let closed = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-switcher-close-'));
  const a = new WindowRegistry(dir, async () => undefined);
  let b!: WindowRegistry;
  b = new WindowRegistry(dir, async () => undefined, async () => { closed++; await b.dispose(); });
  await a.start([{ uri: 'file:///one', identity: '1:1' }]);
  await b.start([{ uri: 'file:///two', identity: '1:2' }]);
  try {
    const target = await a.find('1:2');
    assert.equal(await a.close(target!), 'closed');
    assert.equal(closed, 1);
  } finally { await cleanup(dir, a, b); }
});

test('reports still-open when the close is rejected after the reply', async () => {
  let closed = 0;
  const { dir, a, b } = await setup(async () => { closed++; throw new Error('command unavailable'); });
  try {
    const target = await a.find('1:2');
    assert.equal(await a.close(target!, { goneMs: 1_000 }), 'still-open');
    assert.equal(closed, 1);
  } finally { await cleanup(dir, a, b); }
});

test('reports closed when the target dies before replying', async () => {
  const { dir, a, b } = await setup();
  try {
    const ghost = await plantGhost(a);
    const outcome = a.close(ghost, { replyMs: 2_000 });
    await wait(400);
    await fs.rm(path.join(a.root, 'sessions', `${ghost.id}.json`), { force: true });
    assert.equal(await outcome, 'closed');
  } finally { await cleanup(dir, a, b); }
});

test('fails with no-response when the target never replies and stays', async () => {
  const { dir, a, b } = await setup();
  try {
    const ghost = await plantGhost(a);
    await assert.rejects(a.close(ghost, { replyMs: 1_000 }), (error: unknown) => {
      assert.ok(error instanceof CloseError && error.reason === 'no-response');
      return true;
    });
  } finally { await cleanup(dir, a, b); }
});

test('refuses stale and missing targets before sending anything', async () => {
  const { dir, a, b } = await setup();
  try {
    const stale = await plantGhost(a, 0);
    await assert.rejects(a.close(stale), (error: unknown) => {
      assert.ok(error instanceof CloseError && error.reason === 'unavailable');
      return true;
    });
    await assert.rejects(a.close({ ...stale, id: randomUUID() }), (error: unknown) => {
      assert.ok(error instanceof CloseError && error.reason === 'unavailable');
      return true;
    });
  } finally { await cleanup(dir, a, b); }
});

test('deletes expired, misaddressed, and unknown-version requests without closing', async () => {
  let closed = 0;
  const { dir, a, b } = await setup(async () => { closed++; });
  try {
    const requests = [
      { version: 3, id: randomUUID(), sender: a.sessionId, target: b.sessionId, expiresAt: 0 },
      { version: 3, id: randomUUID(), sender: a.sessionId, target: a.sessionId, expiresAt: Date.now() + 2_000 },
      { version: 9, id: randomUUID(), sender: a.sessionId, target: b.sessionId, expiresAt: Date.now() + 2_000 }
    ];
    for (const request of requests) {
      await fs.writeFile(path.join(a.root, 'inboxes', b.sessionId, `${request.id}.json`), JSON.stringify(request));
    }
    await wait(700);
    assert.equal(closed, 0);
  } finally { await cleanup(dir, a, b); }
});

test('refuses to close its own session through a request', async () => {
  const { dir, a, b } = await setup();
  try {
    const own = await a.find('1:1');
    await assert.rejects(a.close(own!), /directly/);
  } finally { await cleanup(dir, a, b); }
});

test('writes the reply before executing the close', async () => {
  let replyExisted = false;
  const { dir, a, b } = await setup(async () => {
    replyExisted = (await fs.readdir(path.join(dir, 'window-registry-v1', 'replies'))).some(name => name.endsWith('.json'));
  });
  try {
    const target = await a.find('1:2');
    assert.equal(await a.close(target!, { goneMs: 800 }), 'still-open');
    assert.equal(replyExisted, true);
  } finally { await cleanup(dir, a, b); }
});
