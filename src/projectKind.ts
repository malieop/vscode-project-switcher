import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A `.git` entry at the folder root — directory, file, or symlink — marks a Git
 * project. Detection is derived on every load and refresh, never stored, and
 * never throws: unavailable folders and folders without `.git` are plain.
 * A symlink counts because Git itself follows it; a broken one classifies as
 * Git so discovery surfaces the Git error instead of silently treating the
 * folder as plain.
 */
export async function hasGitEntry(folderPath: string): Promise<boolean> {
  try {
    const info = await lstat(join(folderPath, '.git'));
    return info.isDirectory() || info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}
