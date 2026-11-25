import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function isLocalAbsolutePath(path: string): boolean {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  // On Windows, reject UNC shares and drive-relative/root-relative paths.
  return process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(path) || /^\\\\\?\\[a-z]:\\/i.test(path);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Do not let a caller's repository overrides redirect discovery elsewhere.
  const overrides = new Set([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'
  ]);
  for (const key of Object.keys(env)) {
    if (overrides.has(key.toUpperCase())) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function runGit(projectPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: projectPath,
      env: gitEnvironment(),
      encoding: 'buffer',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      killSignal: 'SIGKILL',
      windowsHide: true
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function malformed(): never {
  throw new Error('Invalid git worktree porcelain output.');
}

function parseWorktrees(output: Buffer): GitWorktree[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    return malformed();
  }
  // Each record ends with an empty NUL-terminated field, including the last.
  if (!text.endsWith('\0\0')) return malformed();
  const records = text.slice(0, -2).split('\0\0');
  if (records.length === 0 || records[0] === '') return malformed();

  return records.map(record => {
    const fields = record.split('\0');
    const first = fields.shift();
    if (first === undefined || !first.startsWith('worktree ')) return malformed();
    const path = first.slice('worktree '.length);
    if (!isLocalAbsolutePath(path)) return malformed();

    let head: string | undefined;
    let branch: string | undefined;
    let detached = false;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const field of fields) {
      if (field.startsWith('HEAD ')) {
        const value = field.slice(5);
        if (head !== undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) return malformed();
        head = value;
      } else if (field.startsWith('branch ')) {
        const value = field.slice(7);
        if (branch !== undefined || !value.startsWith('refs/heads/') || value.length === 11) return malformed();
        branch = value.slice('refs/heads/'.length);
      } else if (field === 'detached' && !detached) {
        detached = true;
      } else if (field === 'bare' && !bare) {
        bare = true;
      } else if ((field === 'locked' || field.startsWith('locked ')) && !locked) {
        locked = true;
      } else if ((field === 'prunable' || field.startsWith('prunable ')) && !prunable) {
        prunable = true;
      } else {
        return malformed();
      }
    }
    if (bare ? head !== undefined || branch !== undefined || detached :
      head === undefined || (detached === (branch !== undefined))) return malformed();
    return { path, ...(head === undefined ? {} : { head }), ...(branch === undefined ? {} : { branch }),
      detached, bare, locked, prunable };
  });
}

/** Discover Git-linked worktrees for an existing local worktree root or bare repository. */
export async function listWorktrees(projectPath: string): Promise<readonly GitWorktree[]> {
  if (typeof projectPath !== 'string' || !isLocalAbsolutePath(projectPath)) {
    throw new Error('Project path must be a local absolute directory path.');
  }
  const projectStat = await stat(projectPath, { bigint: true });
  if (!projectStat.isDirectory() || projectStat.ino === 0n) throw new Error('Project directory identity is unavailable.');
  const worktrees = parseWorktrees(await runGit(projectPath));

  // Git also discovers a repository when invoked from an arbitrary subdirectory.
  // Resolve aliases without requiring stale/prunable worktrees to exist.
  let matchesRoot = false;
  for (const worktree of worktrees) {
    try {
      const worktreeStat = await stat(worktree.path, { bigint: true });
      if (worktreeStat.isDirectory() && worktreeStat.ino !== 0n &&
          worktreeStat.dev === projectStat.dev && worktreeStat.ino === projectStat.ino) {
        matchesRoot = true;
        break;
      }
    } catch {
      // Other linked worktrees may have disappeared or be inaccessible.
    }
  }
  if (!matchesRoot) throw new Error('Project directory is not a Git worktree root.');
  return worktrees;
}
