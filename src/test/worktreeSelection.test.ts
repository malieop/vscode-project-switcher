import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { defaultRemote, sortStartingBranches, verifiedRemoteBranches } from '../worktreeSelection';

test('chooses a sole remote and leaves multiple remotes for the user to select', () => {
  assert.equal(defaultRemote([]), undefined);
  assert.equal(defaultRemote(['upstream']), 'upstream');
  assert.equal(defaultRemote(['upstream', 'origin']), undefined);
  assert.equal(defaultRemote(['upstream', 'fork']), undefined);
});

test('does not prioritize deleted or out-of-date tracking branches as fresh', () => {
  const branches = [
    { ref: 'refs/remotes/origin/main', oid: 'old' },
    { ref: 'refs/remotes/origin/master', oid: 'current' },
    { ref: 'refs/heads/local', oid: 'local' }
  ];
  const verified = verifiedRemoteBranches(branches, 'origin', [{ ref: 'refs/heads/master', oid: 'current' }]);
  assert.deepEqual([...verified], ['refs/remotes/origin/master']);
  assert.deepEqual(sortStartingBranches(branches, 'origin', verified).map(branch => branch.ref), [
    'refs/remotes/origin/master', 'refs/remotes/origin/main', 'refs/heads/local'
  ]);
});

test('suggests remote main then master while preserving every other choice', () => {
  const refs = ['refs/heads/local', 'refs/remotes/origin/master', 'refs/remotes/upstream/main',
    'refs/remotes/origin/main'].map(ref => ({ ref }));
  assert.deepEqual(sortStartingBranches(refs, 'origin').map(branch => branch.ref), [
    'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/local', 'refs/remotes/upstream/main'
  ]);
  assert.deepEqual(sortStartingBranches(refs).map(branch => branch.ref), refs.map(branch => branch.ref));
});
