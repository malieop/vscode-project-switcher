import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An identity is meaningful only on the filesystem where it was obtained. */
export interface FolderIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export type FolderIdentityResult =
  | { readonly kind: 'directory'; readonly identity: FolderIdentity }
  | { readonly kind: 'invalid-uri' }
  | { readonly kind: 'not-directory' }
  | { readonly kind: 'unavailable'; readonly error?: unknown };

/** Convert a local file URI to a native absolute path, rejecting remote URIs. */
export function localFolderPath(uri: string): string | undefined {
  try {
    // URL accepts relative file: URLs; persisted records must be absolute URIs.
    if (!/^file:\/\//i.test(uri)) return undefined;
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.username || url.password || url.port ||
        (url.hostname && url.hostname.toLowerCase() !== 'localhost') ||
        url.search || url.hash) return undefined;
    const path = fileURLToPath(url);
    return isAbsolute(path) && !path.includes('\0') ? path : undefined;
  } catch {
    return undefined;
  }
}

/** stat follows symlinks and does not apply case normalization. */
export async function folderIdentity(uri: string): Promise<FolderIdentityResult> {
  const path = localFolderPath(uri);
  if (path === undefined) return { kind: 'invalid-uri' };
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isDirectory()) return { kind: 'not-directory' };
    // Some filesystems do not provide usable inode numbers; do not merge them.
    if (info.ino === 0n) return { kind: 'unavailable' };
    return { kind: 'directory', identity: { device: info.dev, inode: info.ino } };
  } catch (error: unknown) {
    return { kind: 'unavailable', error };
  }
}

export function sameFolderIdentity(a: FolderIdentity, b: FolderIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}
