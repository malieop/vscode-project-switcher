import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_SNAPSHOT, OpenCodeSnapshot, SessionSnapshot, attentionFor, folderPath } from '../opencodeStatus';

const NOW = 1_800_000_000_000;
const FOLDER = '/repo/one';

function session(id: string, directory: string, touched: number, archived = false): SessionSnapshot {
  return { id, directory, touched, archived };
}

function snapshot(partial: Partial<OpenCodeSnapshot>): OpenCodeSnapshot {
  return { sessions: [], active: new Set(), pending: new Set(), ...partial };
}

const uris = ['file:///repo/one'];

test('no sessions mapped to the window means no badge', () => {
  const snap = snapshot({ sessions: [session('s1', '/repo/other', NOW)] });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), undefined);
});

test('waiting wins when a pending request maps to the window', () => {
  const snap = snapshot({
    sessions: [session('s1', FOLDER, NOW - 1_000)],
    pending: new Set(['s1']),
  });
  assert.equal(attentionFor(uris, NOW, snap), 'waiting');
});

test('finished when a mapped session went idle after the window lost focus', () => {
  const snap = snapshot({ sessions: [session('s1', FOLDER, NOW - 5_000)] });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), 'finished');
});

test('no finished marker when the window was focused after the activity', () => {
  const snap = snapshot({ sessions: [session('s1', FOLDER, NOW - 60_000)] });
  assert.equal(attentionFor(uris, NOW - 5_000, snap), undefined);
});

test('a missing lastFocusedAt suppresses finished but keeps waiting', () => {
  const idle = snapshot({ sessions: [session('s1', FOLDER, NOW)] });
  assert.equal(attentionFor(uris, undefined, idle), undefined);
  const pending = snapshot({ sessions: [session('s1', FOLDER, NOW)], pending: new Set(['s1']) });
  assert.equal(attentionFor(uris, undefined, pending), 'waiting');
});

test('a session started in a subdirectory maps to the window folder', () => {
  const snap = snapshot({ sessions: [session('s1', '/repo/one/packages/app', NOW)] });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), 'finished');
});

test('a similarly-prefixed sibling directory does not map', () => {
  const snap = snapshot({ sessions: [session('s1', '/repo/one-two', NOW)] });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), undefined);
});

test('archived sessions are ignored', () => {
  const snap = snapshot({ sessions: [session('s1', FOLDER, NOW, true)] });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), undefined);
});

test('an active session is not finished', () => {
  const snap = snapshot({ sessions: [session('s1', FOLDER, NOW - 1_000)], active: new Set(['s1']) });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), undefined);
});

test('waiting beats finished when both apply', () => {
  const snap = snapshot({
    sessions: [session('s1', FOLDER, NOW - 1_000), session('s2', FOLDER, NOW)],
    pending: new Set(['s2']),
  });
  assert.equal(attentionFor(uris, NOW - 60_000, snap), 'waiting');
});

test('empty snapshot never badges', () => {
  assert.equal(attentionFor(uris, NOW - 60_000, EMPTY_SNAPSHOT), undefined);
});

test('non-file folder uris never badge', () => {
  const snap = snapshot({ sessions: [session('s1', FOLDER, NOW)] });
  assert.equal(attentionFor(['untitled:one'], NOW - 60_000, snap), undefined);
});

test('folderPath converts file uris and rejects others', () => {
  assert.equal(folderPath('file:///repo/one'), '/repo/one');
  assert.equal(folderPath('untitled:one'), undefined);
});
