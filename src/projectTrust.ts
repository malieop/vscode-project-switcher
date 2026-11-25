import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

declare const projectTrustBrand: unique symbol;
/** Opaque, process-local proof of the checkout and Git directories observed at capture. */
export interface ProjectTrustToken { readonly [projectTrustBrand]: true; }

interface NodeIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly uid: string;
  readonly gid: string;
  readonly birthtimeNs: string;
}

interface PathIdentity {
  readonly path: string;
  readonly resolved: string;
  readonly entry: NodeIdentity;
  readonly linkHash?: string;
  readonly target: NodeIdentity;
}

interface ProjectFiles {
  readonly project: PathIdentity;
  readonly dotGit: PathIdentity;
  readonly gitFile?: { readonly hash: string; readonly size: string; readonly mtimeNs: string; readonly ctimeNs: string };
}

interface GitDirectories {
  readonly admin: PathIdentity;
  readonly common: PathIdentity;
  readonly topLevel: string;
}

interface Snapshot { readonly files: ProjectFiles; readonly git: GitDirectories; }
interface SavedTrust { readonly projectPath: string; readonly snapshot: Snapshot; }

const tokens = new WeakMap<ProjectTrustToken, SavedTrust>();
const MAX_GIT_FILE = 64 * 1024;
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 10_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

function identity(value: BigIntStats): NodeIdentity {
  if (value.ino === 0n || value.birthtimeNs === 0n) throw new Error('Unidentifiable filesystem entry.');
  return { dev: String(value.dev), ino: String(value.ino), mode: String(value.mode), uid: String(value.uid),
    gid: String(value.gid), birthtimeNs: String(value.birthtimeNs) };
}

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Record the entry itself as well as the resolved target, including symlink text. */
async function pathIdentity(path: string, expected: 'directory' | 'git-entry'): Promise<PathIdentity> {
  const entryStat = await lstat(path, { bigint: true });
  if (!entryStat.isDirectory() && !entryStat.isFile() && !entryStat.isSymbolicLink()) throw new Error('Invalid filesystem entry.');
  const linkHash = entryStat.isSymbolicLink() ? hash(await readlink(path, { encoding: 'buffer' })) : undefined;
  const resolved = await realpath(path);
  const targetStat = await stat(resolved, { bigint: true });
  if (expected === 'directory' ? !targetStat.isDirectory() : !targetStat.isDirectory() && !targetStat.isFile()) {
    throw new Error('Invalid filesystem target.');
  }
  return { path, resolved, entry: identity(entryStat), ...(linkHash === undefined ? {} : { linkHash }), target: identity(targetStat) };
}

async function gitFileSnapshot(path: string, expected: NodeIdentity): Promise<NonNullable<ProjectFiles['gitFile']>> {
  // Open the already-resolved final component without following a replacement symlink.
  // NONBLOCK also prevents a substituted FIFO from hanging open before fstat rejects it.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || JSON.stringify(identity(before)) !== JSON.stringify(expected) || before.size > BigInt(MAX_GIT_FILE)) {
      throw new Error('Invalid gitdir file.');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(8192, MAX_GIT_FILE + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_GIT_FILE) throw new Error('Gitdir file is too large.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after)) || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(total) !== after.size) {
      throw new Error('Gitdir file changed while reading.');
    }
    return { hash: hash(Buffer.concat(chunks)), size: String(after.size), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs) };
  } finally { await handle.close(); }
}

async function projectFiles(projectPath: string): Promise<ProjectFiles> {
  const project = await pathIdentity(projectPath, 'directory');
  const dotGit = await pathIdentity(join(project.resolved, '.git'), 'git-entry');
  const target = await stat(dotGit.resolved, { bigint: true });
  if (JSON.stringify(identity(target)) !== JSON.stringify(dotGit.target)) throw new Error('Git entry changed.');
  const gitFile = target.isFile() ? await gitFileSnapshot(dotGit.resolved, dotGit.target) : undefined;
  return { project, dotGit, ...(gitFile === undefined ? {} : { gitFile }) };
}

function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_CEILING_DIRECTORIES = dirname(cwd);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function gitDirectoriesOutput(cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
      'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], {
      cwd, env: gitEnvironment(cwd), detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ok) resolve(Buffer.concat(output)); else reject(new Error('Git inspection failed.'));
    };
    const stop = (): void => {
      if (done) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    };
    const timer = setTimeout(stop, TIMEOUT_MS);
    const collect = (bytes: Buffer, stdout: boolean): void => {
      size += bytes.length;
      if (size > MAX_OUTPUT) return stop();
      if (stdout) output.push(bytes);
    };
    child.stdout.on('data', (bytes: Buffer) => collect(bytes, true));
    child.stderr.on('data', (bytes: Buffer) => collect(bytes, false));
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
  });
}

async function gitDirectories(cwd: string): Promise<GitDirectories> {
  const text = decoder.decode(await gitDirectoriesOutput(cwd));
  if (!text.endsWith('\n')) throw new Error('Invalid Git directory output.');
  const lines = text.slice(0, -1).split('\n');
  // Newlines or other control characters in paths cannot be disambiguated in this output.
  if (lines.length !== 3 || lines.some(line => !isAbsolute(line) || /[\x00-\x1f\x7f]/.test(line))) {
    throw new Error('Ambiguous Git directory output.');
  }
  const [admin, common, topLevel] = await Promise.all([
    pathIdentity(lines[0], 'directory'), pathIdentity(lines[1], 'directory'), realpath(lines[2])
  ]);
  if (topLevel !== cwd) throw new Error('Project is not the Git checkout root.');
  return { admin, common, topLevel };
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

async function snapshot(projectPath: string): Promise<Snapshot> {
  const first = await projectFiles(projectPath);
  const gitFirst = await gitDirectories(first.project.resolved);
  const middle = await projectFiles(projectPath);
  const gitLast = await gitDirectories(middle.project.resolved);
  const last = await projectFiles(projectPath);
  if (!same(first, middle) || !same(middle, last) || !same(gitFirst, gitLast)) {
    throw new Error('Project changed during inspection.');
  }
  return { files: last, git: gitLast };
}

/** Capture before asking for confirmation; use the resulting token only after confirmation. */
export async function captureProjectTrust(projectPath: string): Promise<ProjectTrustToken> {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath) || projectPath.includes('\0') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(projectPath))) {
    throw new Error('Project trust requires a local absolute checkout path.');
  }
  try {
    const state = await snapshot(projectPath);
    const token = Object.freeze({}) as ProjectTrustToken;
    tokens.set(token, { projectPath, snapshot: state });
    return token;
  } catch { throw new Error('Unable to verify project trust.'); }
}

/** Revalidate immediately before each Git operation; rejects on changes or inspection failures. */
export async function revalidateProjectTrust(token: ProjectTrustToken): Promise<void> {
  const saved = token && typeof token === 'object' ? tokens.get(token) : undefined;
  if (!saved) throw new Error('Invalid project trust token.');
  try {
    if (!same(saved.snapshot, await snapshot(saved.projectPath))) throw new Error('Project changed.');
    if (tokens.get(token) !== saved) throw new Error('Project trust was revoked.');
  } catch {
    tokens.delete(token);
    throw new Error('Project trust could not be revalidated.');
  }
}
