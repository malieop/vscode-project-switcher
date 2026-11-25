import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, parse, sep } from 'node:path';
import { CHECKOUT_TIMEOUT, decode, FETCH_TIMEOUT, GitWorktreeError, localAbsolutePath, projectDirectory, runGit,
  SHORT_TIMEOUT, verifyProjectIdentity } from './gitExec';

// Re-exported for existing callers; the implementations live in gitExec.
export { GitWorktreeError, ProjectIdentityError } from './gitExec';
export type { GitWorktreeFailure, GitWorktreeOperation } from './gitExec';

/** A concrete branch ref, not a symbolic ref such as origin/HEAD. */
export interface GitBranchRef {
  readonly ref: string;
  /** Local branch name, or remote/name for a remote-tracking branch. */
  readonly name: string;
  readonly kind: 'local' | 'remote';
  readonly oid: string;
}

export interface GitRemoteHead {
  readonly ref: string;
  readonly oid: string;
}

/** Names only. A caller must choose a remote and explicitly invoke fetchRemoteBranches. */
export async function listRemoteNames(projectPath: string, signal?: AbortSignal,
                                      expectedProjectIdentity?: string): Promise<readonly string[]> {
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  const output = decode(await runGit(cwd, 'remotes', ['remote'], SHORT_TIMEOUT, signal, expectedProjectIdentity));
  if (output === '') return [];
  if (!output.endsWith('\n') || output.includes('\0')) throw new Error('Invalid Git remote output.');
  return output.slice(0, -1).split('\n');
}

/** Fetch only remote heads into this remote's tracking namespace. Never called implicitly. */
export async function fetchRemoteBranches(projectPath: string, remote: string, signal?: AbortSignal,
                                          expectedProjectIdentity?: string): Promise<readonly GitRemoteHead[]> {
  if (signal?.aborted) throw new GitWorktreeError('fetch', 'cancelled');
  // Node cannot reliably terminate a spawned Git helper's entire process tree on Windows.
  if (process.platform === 'win32') throw new GitWorktreeError('fetch', 'unavailable');
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  // Limit names to a conservative, unambiguous subset, then verify both config and ref syntax.
  if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) ||
      !(await listRemoteNames(cwd, signal, expectedProjectIdentity)).includes(remote)) throw new Error('Invalid or unconfigured remote name.');
  await runGit(cwd, 'validate', ['check-ref-format', `refs/remotes/${remote}/branch`], SHORT_TIMEOUT, signal, expectedProjectIdentity);
  await runGit(cwd, 'fetch', ['-c', 'fetch.prune=false', '-c', 'fetch.pruneTags=false',
    '-c', 'fetch.writeCommitGraph=false', '-c', 'protocol.allow=never', '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always',
    '-c', 'protocol.http.allow=always', '-c', 'protocol.git.allow=always', 'fetch', '--upload-pack=git-upload-pack',
    '--atomic', '--no-prune', '--no-prune-tags', '--no-tags',
    '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph',
    '--refmap=', '--', remote, `refs/heads/*:refs/remotes/${remote}/*`], FETCH_TIMEOUT, signal, expectedProjectIdentity);
  // Fetch preserves stale tracking refs. Verify which heads the remote still advertises.
  const advertised = decode(await runGit(cwd, 'fetch', ['-c', 'protocol.allow=never', '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always',
    '-c', 'protocol.http.allow=always', '-c', 'protocol.git.allow=always', 'ls-remote', '--heads',
    '--upload-pack=git-upload-pack', '--', remote], FETCH_TIMEOUT, signal, expectedProjectIdentity));
  if (!advertised) return [];
  if (!advertised.endsWith('\n')) throw new Error('Invalid remote branch output.');
  const heads: GitRemoteHead[] = [];
  for (const line of advertised.slice(0, -1).split('\n')) {
    const fields = line.split('\t');
    if (fields.length !== 2 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[0]) ||
        !fields[1].startsWith('refs/heads/') || fields[1].length === 'refs/heads/'.length ||
        fields[1].includes('\0') || heads.some(head => head.ref === fields[1])) {
      throw new Error('Invalid remote branch output.');
    }
    heads.push({ ref: fields[1], oid: fields[0] });
  }
  return heads;
}

type ResolvedBranch = GitBranchRef;

async function branches(cwd: string, includeRemote: boolean, signal?: AbortSignal,
                        expectedProjectIdentity?: string): Promise<readonly ResolvedBranch[]> {
  const args = ['for-each-ref', '--format=%(refname)%00%(symref)%00%(objecttype)%00%(objectname)', 'refs/heads/'];
  if (includeRemote) args.push('refs/remotes/');
  const output = decode(await runGit(cwd, 'branches', args, SHORT_TIMEOUT, signal, expectedProjectIdentity));
  if (!output) return [];
  if (!output.endsWith('\n')) throw new Error('Invalid Git branch output.');
  const result: ResolvedBranch[] = [];
  for (const line of output.slice(0, -1).split('\n')) {
    const fields = line.split('\0');
    if (fields.length !== 4 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[3])) {
      throw new Error('Invalid Git branch output.');
    }
    const [ref, symref, type, oid] = fields;
    const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : undefined;
    if (!kind) throw new Error('Invalid Git branch output.');
    if (symref || type !== 'commit') continue;
    const name = ref.slice(kind === 'local' ? 'refs/heads/'.length : 'refs/remotes/'.length);
    if (!name) throw new Error('Invalid Git branch output.');
    result.push({ ref, name, kind, oid });
  }
  return result;
}

/** Return concrete local branches and, when requested, remote-tracking branches. */
export async function listBranchRefs(projectPath: string, includeRemote = false, signal?: AbortSignal,
                                     expectedProjectIdentity?: string): Promise<readonly GitBranchRef[]> {
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  return branches(cwd, includeRemote, signal, expectedProjectIdentity);
}

/**
 * Initialize a new Git repository in an existing, caller-created directory.
 * The user's configured default branch applies; none is imposed. The hardened
 * environment strips Git redirects and credential prompts. On failure the
 * directory is left in place for the caller to keep or report.
 */
export async function initializeRepository(projectPath: string, signal?: AbortSignal,
                                           expectedProjectIdentity?: string): Promise<void> {
  if (signal?.aborted) throw new GitWorktreeError('init', 'cancelled');
  // Node cannot reliably terminate a spawned Git helper's entire process tree on Windows.
  if (process.platform === 'win32') throw new GitWorktreeError('init', 'unavailable');
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  await runGit(cwd, 'init', ['init'], SHORT_TIMEOUT, signal, expectedProjectIdentity);
}

/** Produce a portable, non-special single directory component; not a uniqueness guarantee. */
export function suggestWorktreeDirectory(branchName: string): string {
  if (typeof branchName !== 'string') throw new Error('Branch name must be a string.');
  const result = branchName.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result)) return `worktree-${result || 'branch'}`;
  return result;
}

async function validateBranchName(cwd: string, branchName: string, signal?: AbortSignal,
                                  expectedProjectIdentity?: string): Promise<void> {
  if (typeof branchName !== 'string' || !branchName || branchName.startsWith('-') || branchName.includes('\0')) {
    throw new Error('Invalid new branch name.');
  }
  const checked = decode(await runGit(cwd, 'validate', ['check-ref-format', '--branch', branchName], SHORT_TIMEOUT, signal, expectedProjectIdentity));
  if (checked !== `${branchName}\n`) throw new Error('Invalid new branch name.');
  // Include symbolic and non-commit refs: Git still treats those names as occupied.
  const output = decode(await runGit(cwd, 'validate', ['for-each-ref', '--format=%(refname)', 'refs/heads/'], SHORT_TIMEOUT, signal, expectedProjectIdentity));
  if (output && !output.endsWith('\n')) throw new Error('Invalid Git branch output.');
  if (output.split('\n').includes(`refs/heads/${branchName}`)) throw new Error('New branch already exists.');
}

/** Validate a new branch name without creating anything. Creation repeats this check. */
export async function validateNewBranchName(projectPath: string, branchName: string, expectedProjectIdentity?: string): Promise<void> {
  await validateBranchName(await projectDirectory(projectPath, expectedProjectIdentity), branchName, undefined, expectedProjectIdentity);
}

/**
 * Create a NEW branch and worktree from a concrete full branch ref. Parent must exist.
 * The destination is exclusively reserved; no cleanup is attempted after any failure.
 * Returns the canonical absolute path. Git checkout filters can run and require trust.
 */
export async function createBranchWorktree(projectPath: string, branchName: string, startingRef: string,
                                           destination: string, signal?: AbortSignal,
                                           expectedParentIdentity?: string, expectedProjectIdentity?: string): Promise<string> {
  if (signal?.aborted) throw new GitWorktreeError('create', 'cancelled');
  if (process.platform === 'win32') throw new GitWorktreeError('create', 'unavailable');
  const cwd = await projectDirectory(projectPath, expectedProjectIdentity);
  await validateBranchName(cwd, branchName, signal, expectedProjectIdentity);
  if (typeof startingRef !== 'string' || (!startingRef.startsWith('refs/heads/') && !startingRef.startsWith('refs/remotes/')) || startingRef.includes('\0')) {
    throw new Error('Starting ref must be a fully qualified branch ref.');
  }
  await runGit(cwd, 'validate', ['check-ref-format', startingRef], SHORT_TIMEOUT, signal, expectedProjectIdentity);
  const available = await branches(cwd, true, signal, expectedProjectIdentity);
  const selected = available.find(branch => branch.ref === startingRef);
  if (!selected) throw new Error('Starting branch does not exist or is symbolic.');

  if (!localAbsolutePath(destination) || normalize(destination) !== destination || destination === parse(destination).root ||
      destination.endsWith(sep) || basename(destination) === '.' || basename(destination) === '..') {
    throw new Error('Destination must be a normalized local absolute path.');
  }
  const parent = await realpath(dirname(destination));
  const parentStat = await stat(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.ino === 0n) throw new Error('Destination parent must be an identifiable directory.');
  if (expectedParentIdentity && `${parentStat.dev}:${parentStat.ino}` !== expectedParentIdentity) {
    throw new Error('The destination parent changed after confirmation.');
  }
  const target = join(parent, basename(destination));
  if (signal?.aborted) throw new GitWorktreeError('create', 'cancelled');
  // mkdir is atomic and refuses directories, files and dangling symlinks alike.
  try { await mkdir(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Destination already exists.');
    throw error;
  }
  // Refuse replacement between reservation and Git invocation, including a symlink.
  const reserved = await lstat(target);
  if (!reserved.isDirectory() || reserved.isSymbolicLink()) throw new Error('Destination changed after reservation.');
  await runGit(cwd, 'create', ['worktree', 'add', '--no-checkout', '--no-track', '-b', branchName, '--', target, selected.oid], CHECKOUT_TIMEOUT, signal, expectedProjectIdentity);
  const current = await lstat(target);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== reserved.dev || current.ino !== reserved.ino) {
    throw new Error('Destination changed during worktree creation.');
  }
  await verifyProjectIdentity(cwd, expectedProjectIdentity);
  await runGit(target, 'checkout', [`--work-tree=${target}`, 'read-tree', 'HEAD'], CHECKOUT_TIMEOUT, signal);
  // Without --force, checkout-index does not overwrite existing files.
  await verifyProjectIdentity(cwd, expectedProjectIdentity);
  await runGit(target, 'checkout', [`--work-tree=${target}`, 'checkout-index', '--all'], CHECKOUT_TIMEOUT, signal);
  return target;
}
