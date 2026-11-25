import { realpath } from 'node:fs/promises';
import { CHECKOUT_TIMEOUT, decode, GitWorktreeError, localAbsolutePath, projectDirectory, runGit,
  SHORT_TIMEOUT, verifyProjectIdentity } from './gitExec';

/** What destroying this worktree would discard. */
export interface WorktreeLosses {
  readonly uncommittedChanges: boolean;
  readonly untrackedFiles: boolean;
  readonly unmergedCommits: boolean;
}

/** The tip to test for unmerged commits: a branch name, or a detached HEAD oid. */
export interface WorktreeTip {
  readonly branch?: string;
  readonly head?: string;
}

const STATUS_CODE = /^([MADRCUT?! ]{2}) /;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parse `git status --porcelain=v1 -z`; rename continuations never match the status prefix. */
function parseStatus(output: string): { uncommittedChanges: boolean; untrackedFiles: boolean } {
  let uncommittedChanges = false;
  let untrackedFiles = false;
  for (const entry of output.split('\0')) {
    if (entry === '') continue;
    const match = STATUS_CODE.exec(entry);
    if (!match) throw new Error('Invalid Git status output.');
    if (match[1] === '??') untrackedFiles = true;
    else uncommittedChanges = true;
    if (uncommittedChanges && untrackedFiles) break;
  }
  return { uncommittedChanges, untrackedFiles };
}

async function validateBranchName(cwd: string, branchName: string, signal?: AbortSignal,
                                  expectedProjectIdentity?: string): Promise<string> {
  if (typeof branchName !== 'string' || !branchName || branchName.startsWith('-') || branchName.includes('\0')) {
    throw new Error('Invalid branch name.');
  }
  const checked = decode(await runGit(cwd, 'validate', ['check-ref-format', '--branch', branchName], SHORT_TIMEOUT, signal, expectedProjectIdentity));
  if (checked !== `${branchName}\n`) throw new Error('Invalid branch name.');
  return `refs/heads/${branchName}`;
}

/**
 * Detect what destroying the worktree would lose: uncommitted changes, untracked
 * files, and commits not reachable from the main checkout's HEAD or the branch's
 * upstream. Runs one status in the worktree and rev-list in the main checkout.
 */
export async function inspectWorktreeLosses(projectPath: string, worktreePath: string, tip: WorktreeTip,
                                            signal?: AbortSignal, expectedProjectIdentity?: string,
                                            expectedWorktreeIdentity?: string): Promise<WorktreeLosses> {
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  if (!localAbsolutePath(worktreePath)) throw new Error('Worktree path must be a local absolute directory.');
  await verifyProjectIdentity(worktreePath, expectedWorktreeIdentity);
  const status = decode(await runGit(worktreePath, 'status',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'], SHORT_TIMEOUT, signal));
  const losses = parseStatus(status);

  let tipRef: string;
  let upstream: string | undefined;
  if (tip.branch !== undefined) {
    tipRef = await validateBranchName(cwd, tip.branch, signal, expectedProjectIdentity);
    const configured = decode(await runGit(cwd, 'merged',
      ['for-each-ref', '--format=%(upstream)', '--', tipRef], SHORT_TIMEOUT, signal, expectedProjectIdentity));
    if (configured !== '') {
      if (!configured.endsWith('\n')) throw new Error('Invalid Git upstream output.');
      const candidate = configured.slice(0, -1);
      // Include the upstream only when it still resolves locally.
      const resolved = decode(await runGit(cwd, 'merged',
        ['for-each-ref', '--format=%(refname)', '--', candidate], SHORT_TIMEOUT, signal, expectedProjectIdentity));
      if (resolved === `${candidate}\n`) upstream = candidate;
    }
  } else if (tip.head !== undefined && OID.test(tip.head)) {
    tipRef = tip.head;
  } else {
    throw new Error('A branch or a detached HEAD oid is required.');
  }
  const unmerged = decode(await runGit(cwd, 'merged',
    ['rev-list', tipRef, '--not', 'HEAD', ...(upstream ? [upstream] : [])], SHORT_TIMEOUT, signal, expectedProjectIdentity));
  return { ...losses, unmergedCommits: unmerged.trim() !== '' };
}

/**
 * Remove a linked worktree. The primary checkout is refused here as a backstop;
 * a dirty worktree needs force (locked worktrees are refused by the caller and
 * never receive the double force Git would demand).
 */
export async function removeWorktree(projectPath: string, worktreePath: string, force: boolean,
                                     signal?: AbortSignal, expectedProjectIdentity?: string): Promise<void> {
  if (signal?.aborted) throw new GitWorktreeError('remove', 'cancelled');
  if (process.platform === 'win32') throw new GitWorktreeError('remove', 'unavailable');
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  if (!localAbsolutePath(worktreePath)) throw new Error('Worktree path must be a local absolute directory.');
  if (await realpath(worktreePath) === cwd) throw new Error('The primary checkout can never be destroyed.');
  await runGit(cwd, 'remove', ['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktreePath],
    CHECKOUT_TIMEOUT, signal, expectedProjectIdentity);
}

/** Delete a branch after its worktree is gone. `-d` refuses unmerged branches; `-D` forces. */
export async function deleteBranch(projectPath: string, branchName: string, force: boolean,
                                   signal?: AbortSignal, expectedProjectIdentity?: string): Promise<void> {
  if (signal?.aborted) throw new GitWorktreeError('branch', 'cancelled');
  if (process.platform === 'win32') throw new GitWorktreeError('branch', 'unavailable');
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  await validateBranchName(cwd, branchName, signal, expectedProjectIdentity);
  await runGit(cwd, 'branch', ['branch', force ? '-D' : '-d', '--', branchName], SHORT_TIMEOUT, signal, expectedProjectIdentity);
}
