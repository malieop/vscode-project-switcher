import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { switchProject, SwitchDependencies, SwitchError } from '../switchProject';
import type { WindowRecord } from '../windowRegistry';

const window: WindowRecord = { version: 1, id: 'target', pid: 1, updatedAt: 1, folders: [] };

function fixture(): { deps: SwitchDependencies; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      identify: async () => { calls.push('identify'); return 'id'; },
      isCurrent: async () => { calls.push('current'); return false; },
      find: async () => { calls.push('find'); return undefined; },
      focus: async () => { calls.push('focus'); },
      choose: async () => { calls.push('choose'); return 'new'; },
      claim: async () => { calls.push('claim'); return 'token'; },
      releaseUnstartedClaim: async () => { calls.push('release'); },
      revalidate: async () => { calls.push('revalidate'); return true; },
      open: async choice => { calls.push(`open:${choice}`); },
      waitForRegistration: async () => { calls.push('confirm'); return true; }
    }
  };
}

test('current project does not prompt or reopen', async () => {
  const f = fixture(); f.deps.isCurrent = async () => true;
  assert.equal(await switchProject(f.deps), 'current');
  assert.deepEqual(f.calls, ['identify']);
});

test('an already-open project is focused without opening', async () => {
  const f = fixture(); f.deps.find = async () => window;
  assert.equal(await switchProject(f.deps), 'focused');
  assert.deepEqual(f.calls, ['identify', 'current', 'focus']);
});

test('cancel leaves the project unchanged', async () => {
  const f = fixture(); f.deps.choose = async () => undefined;
  assert.equal(await switchProject(f.deps), 'cancelled');
  assert.deepEqual(f.calls, ['identify', 'current', 'find']);
});

test('direct window actions skip the window choice prompt', async () => {
  for (const choice of ['current', 'new'] as const) {
    const f = fixture();
    assert.equal(await switchProject(f.deps, choice), 'opened');
    assert.ok(!f.calls.includes('choose'));
    assert.ok(f.calls.includes(`open:${choice}`));
  }
});

test('direct window actions still focus an already-open project', async () => {
  for (const choice of ['current', 'new'] as const) {
    const f = fixture();
    f.deps.find = async () => window;
    assert.equal(await switchProject(f.deps, choice), 'focused');
    assert.ok(f.calls.includes('focus'));
    assert.ok(!f.calls.includes('choose'));
    assert.ok(!f.calls.some(call => call.startsWith('open:')));
  }
});

test('direct new-window action does not reopen the current project', async () => {
  const f = fixture();
  f.deps.isCurrent = async () => true;
  assert.equal(await switchProject(f.deps, 'new'), 'current');
  assert.ok(!f.calls.includes('choose'));
  assert.ok(!f.calls.some(call => call.startsWith('open:')));
});

test('direct window actions recheck for a window opened during the request', async () => {
  const f = fixture();
  let checks = 0;
  f.deps.find = async () => ++checks === 2 ? window : undefined;
  assert.equal(await switchProject(f.deps, 'new'), 'focused');
  assert.ok(!f.calls.includes('choose'));
  assert.ok(f.calls.includes('focus'));
  assert.ok(f.calls.includes('release'));
  assert.ok(!f.calls.some(call => call.startsWith('open:')));
});

test('checks again after claiming before opening the chosen window', async () => {
  const f = fixture();
  assert.equal(await switchProject(f.deps), 'opened');
  assert.deepEqual(f.calls, ['identify', 'current', 'find', 'choose', 'claim', 'find', 'revalidate', 'open:new', 'confirm']);
});

test('focuses a project opened during selection and releases its unused claim', async () => {
  const f = fixture(); let checks = 0;
  f.deps.find = async () => ++checks === 2 ? window : undefined;
  assert.equal(await switchProject(f.deps), 'focused');
  assert.deepEqual(f.calls, ['identify', 'current', 'choose', 'claim', 'focus', 'release']);
});

test('refuses a concurrent or unresolved claim', async () => {
  const f = fixture(); f.deps.claim = async () => undefined;
  await assert.rejects(switchProject(f.deps), (error: unknown) => error instanceof SwitchError && error.stage === 'busy');
  assert.ok(!f.calls.some(call => call.startsWith('open:')));
});

test('does not release an uncertain claim after dispatch', async () => {
  const f = fixture(); f.deps.waitForRegistration = async () => false;
  await assert.rejects(switchProject(f.deps), (error: unknown) => error instanceof SwitchError && error.stage === 'unconfirmed');
  assert.ok(!f.calls.includes('release'));
});

test('unavailable discovery does not open a window', async () => {
  const f = fixture(); f.deps.find = async () => { throw new Error('offline'); };
  await assert.rejects(switchProject(f.deps), (error: unknown) => error instanceof SwitchError && error.stage === 'discovery');
  assert.ok(!f.calls.includes('open:new'));
});

test('a folder changed during selection is not opened and its claim is released', async () => {
  const f = fixture(); f.deps.revalidate = async () => false;
  await assert.rejects(switchProject(f.deps), (error: unknown) => error instanceof SwitchError && error.stage === 'identity');
  assert.ok(f.calls.includes('release'));
  assert.ok(!f.calls.includes('open:new'));
});
