import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { listWindowRows, WindowRowSource, windowIcon } from '../windowList';
import { STALE_AFTER_MS, WindowRecord } from '../windowRegistry';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function record(id: string, updatedAt: number, uris: string[]): WindowRecord {
  return { version: 1, id, pid: 4242, updatedAt,
    folders: uris.map((uri, index) => ({ uri, identity: `1:${index + 1}` })) };
}

function source(sessionId: string, records: WindowRecord[]): WindowRowSource {
  return { sessionId, list: async () => records };
}

test('keeps fresh records and drops stale ones', async () => {
  const now = Date.now();
  const fresh = record(OTHER, now - STALE_AFTER_MS + 1_000, ['file:///two']);
  const stale = record('33333333-3333-4333-8333-333333333333', now - STALE_AFTER_MS - 1_000, ['file:///three']);
  const result = await listWindowRows(source(SELF, [fresh, stale]), now);
  assert.ok(result.ok);
  assert.deepEqual(result.rows.map(row => row.record.id), [OTHER]);
});

test('marks the current window and sorts it first', async () => {
  const now = Date.now();
  const own = record(SELF, now, ['file:///zzz-self']);
  const other = record(OTHER, now, ['file:///aaa-other']);
  const result = await listWindowRows(source(SELF, [other, own]), now);
  assert.ok(result.ok);
  assert.deepEqual(result.rows.map(row => row.current), [true, false]);
  assert.equal(result.rows[0].record.id, SELF);
});

test('sorts other windows by first folder path', async () => {
  const now = Date.now();
  const b = record(OTHER, now, ['file:///bbb']);
  const a = record('33333333-3333-4333-8333-333333333333', now, ['file:///aaa']);
  const result = await listWindowRows(source(SELF, [b, a]), now);
  assert.ok(result.ok);
  assert.deepEqual(result.rows.map(row => firstUri(row.record)), ['file:///aaa', 'file:///bbb']);
});

test('keeps every folder of a multi-root window on its row', async () => {
  const now = Date.now();
  const multi = record(OTHER, now, ['file:///one', 'file:///two']);
  const result = await listWindowRows(source(SELF, [multi]), now);
  assert.ok(result.ok);
  assert.deepEqual(result.rows[0].record.folders.map(folder => folder.uri), ['file:///one', 'file:///two']);
});

test('drops windows without folders, matching picker behavior', async () => {
  const now = Date.now();
  const empty = record(OTHER, now, []);
  const result = await listWindowRows(source(SELF, [empty]), now);
  assert.ok(result.ok);
  assert.equal(result.rows.length, 0);
});

test('reports failure when the registry cannot be read', async () => {
  const failing: WindowRowSource = { sessionId: SELF, list: async () => { throw new Error('registry down'); } };
  const result = await listWindowRows(failing);
  assert.equal(result.ok, false);
});

test('colors the current window icon green', async () => {
  const now = Date.now();
  const own = record(SELF, now, ['file:///self']);
  const result = await listWindowRows(source(SELF, [own]), now);
  assert.ok(result.ok);
  assert.deepEqual(windowIcon(result.rows[0]), { id: 'window', colorId: 'charts.green' });
});

test('leaves other window icons untinted', async () => {
  const now = Date.now();
  const other = record(OTHER, now, ['file:///other']);
  const result = await listWindowRows(source(SELF, [other]), now);
  assert.ok(result.ok);
  assert.deepEqual(windowIcon(result.rows[0]), { id: 'window' });
});

test('rows carry attention when a snapshot is provided', async () => {
  const now = Date.now();
  const other = { ...record(OTHER, now, ['file:///other']), lastFocusedAt: now - 60_000 };
  const snapshot = {
    sessions: [{ id: 's1', directory: '/other', touched: now - 1_000, archived: false }],
    active: new Set<string>(), pending: new Set<string>(),
  };
  const withStatus = await listWindowRows(source(SELF, [other]), now, snapshot);
  assert.ok(withStatus.ok);
  assert.equal(withStatus.rows[0].attention, 'finished');
  const without = await listWindowRows(source(SELF, [other]), now);
  assert.ok(without.ok);
  assert.equal(without.rows[0].attention, undefined);
});

function firstUri(entry: WindowRecord): string {
  return entry.folders[0].uri;
}
