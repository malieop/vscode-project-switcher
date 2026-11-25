import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Use single path components so a name cannot escape the configured parent. */
export function validDirectoryComponent(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' &&
    !/[\\/\x00-\x1f<>:"|?*]/.test(value) && !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 255;
}

export function worktreeDestination(root: string, projectName: string, worktreeName: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
    throw new Error('The worktrees directory must be an absolute local path.');
  }
  if (!validDirectoryComponent(projectName) || !validDirectoryComponent(worktreeName)) {
    throw new Error('Choose a safe project and worktree directory name.');
  }
  return path.join(root, projectName, worktreeName);
}

/** lstat also detects broken symlinks, which must never be treated as free paths. */
export async function destinationExists(destination: string): Promise<boolean> {
  try { await fs.lstat(destination); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface ProjectDirectoryState {
  readonly rootIdentity: string;
  readonly groupIdentity?: string;
}

/** Reject symlinked project groups and expose identities for revalidation after confirmation. */
export async function inspectProjectDirectory(root: string, projectName: string): Promise<ProjectDirectoryState> {
  const group = path.dirname(worktreeDestination(root, projectName, 'worktree'));
  const rootStat = await fs.stat(root, { bigint: true }).catch(() => {
    throw new Error('The configured worktrees directory is unavailable. Create it or change the setting.');
  });
  if (!rootStat.isDirectory() || rootStat.ino === 0n) throw new Error('The worktrees directory is unavailable.');
  const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
  try {
    const groupStat = await fs.lstat(group, { bigint: true });
    if (!groupStat.isDirectory() || groupStat.isSymbolicLink() || groupStat.ino === 0n) {
      throw new Error('The project worktrees directory must be a regular directory, not a symlink.');
    }
    return { rootIdentity, groupIdentity: `${groupStat.dev}:${groupStat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rootIdentity };
    throw error;
  }
}
