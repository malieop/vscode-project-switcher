import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

export type GitWorktreeOperation = 'remotes' | 'fetch' | 'branches' | 'validate' | 'create' | 'checkout' | 'init'
  | 'status' | 'merged' | 'remove' | 'branch';
export type GitWorktreeFailure = 'failed' | 'timeout' | 'output-limit' | 'unavailable' | 'cancelled';

/** Intentionally does not include Git output, command arguments, or credential-bearing URLs. */
export class GitWorktreeError extends Error {
  constructor(readonly operation: GitWorktreeOperation, readonly reason: GitWorktreeFailure) {
    super(`Git ${operation} ${reason}.`);
    this.name = 'GitWorktreeError';
  }
}

export class ProjectIdentityError extends Error {
  constructor() {
    super('The selected project changed after trust was confirmed.');
    this.name = 'ProjectIdentityError';
  }
}

export const MAX_OUTPUT = 4 * 1024 * 1024;
export const SHORT_TIMEOUT = 15_000;
export const FETCH_TIMEOUT = 60_000;
export const CHECKOUT_TIMEOUT = 120_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function localAbsolutePath(path: string): boolean {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0') &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(path));
}

export async function verifyProjectIdentity(cwd: string, expected?: string): Promise<void> {
  if (!expected) return;
  try {
    const info = await stat(cwd, { bigint: true });
    if (!info.isDirectory() || info.ino === 0n || `${info.dev}:${info.ino}` !== expected) throw new ProjectIdentityError();
  } catch (error) {
    if (error instanceof ProjectIdentityError) throw error;
    throw new ProjectIdentityError();
  }
}

export async function projectDirectory(path: string, expected?: string): Promise<string> {
  if (!localAbsolutePath(path)) throw new Error('Project path must be a local absolute directory.');
  await verifyProjectIdentity(path, expected);
  if (!(await stat(path)).isDirectory()) throw new Error('Project path must be a directory.');
  const resolved = await realpath(path);
  await verifyProjectIdentity(resolved, expected);
  return resolved;
}

function environment(cwd: string): NodeJS.ProcessEnv {
  // Repository and config injection environment variables must not redirect commands.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  // Never fall back to a parent repository if a worktree's .git disappears.
  env.GIT_CEILING_DIRECTORIES = dirname(cwd);
  // Constant command, never interpolated with input. SSH itself is placed in batch mode.
  env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  env.SSH_ASKPASS_REQUIRE = 'never';
  return env;
}

export async function runGit(cwd: string, operation: GitWorktreeOperation, args: readonly string[], timeout = SHORT_TIMEOUT,
                      signal?: AbortSignal, expectedProjectIdentity?: string): Promise<Buffer> {
  await verifyProjectIdentity(cwd, expectedProjectIdentity);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new GitWorktreeError(operation, 'cancelled')); return; }
    const child = spawn('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'core.askPass=', '-c', 'credential.interactive=never',
      '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
      cwd, env: environment(cwd), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (reason?: GitWorktreeFailure): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reason) reject(new GitWorktreeError(operation, reason));
      else resolve(Buffer.concat(stdout));
    };
    const stop = (reason: GitWorktreeFailure): void => {
      if (finished) return;
      // Kill Git and its helpers as a process group where the OS supports it.
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(reason);
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const abort = (): void => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stop('cancelled');
    const collect = (chunk: Buffer, isStdout: boolean): void => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) return stop('output-limit');
      if (isStdout) stdout.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' ? 'unavailable' : 'failed'));
    child.on('close', code => finish(code === 0 ? undefined : 'failed'));
  });
}

export function decode(output: Buffer): string {
  try { return utf8.decode(output); } catch { throw new Error('Invalid Git output.'); }
}
