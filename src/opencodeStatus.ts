import { fileURLToPath } from 'node:url';

export type OpenCodeAttention = 'waiting' | 'finished';

export interface SessionSnapshot {
  id: string;
  directory: string;
  /** Last user-visible activity: idle time when present, else last update. */
  touched: number;
  archived: boolean;
}

export interface OpenCodeSnapshot {
  sessions: SessionSnapshot[];
  /** Session ids currently running. */
  active: ReadonlySet<string>;
  /** Session ids with a pending permission request or form. */
  pending: ReadonlySet<string>;
}

export const EMPTY_SNAPSHOT: OpenCodeSnapshot = {
  sessions: [], active: new Set(), pending: new Set(),
};

/** Convert a stored file: uri to a filesystem path without vscode. */
export function folderPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try { return fileURLToPath(uri); } catch { return undefined; }
}

function covers(folder: string, directory: string): boolean {
  return directory === folder || directory.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/**
 * Attention state for one window row. Waiting beats finished; a missing
 * lastFocusedAt (older extension versions) suppresses finished (P-04).
 */
export function attentionFor(folderUris: string[], lastFocusedAt: number | undefined,
  snapshot: OpenCodeSnapshot): OpenCodeAttention | undefined {
  const folders = folderUris.map(folderPath).filter((p): p is string => p !== undefined);
  if (!folders.length) return undefined;
  const sessions = snapshot.sessions.filter(session => !session.archived
    && folders.some(folder => covers(folder, session.directory)));
  if (!sessions.length) return undefined;
  if (sessions.some(session => snapshot.pending.has(session.id))) return 'waiting';
  if (lastFocusedAt === undefined) return undefined;
  return sessions.some(session => !snapshot.active.has(session.id) && session.touched > lastFocusedAt)
    ? 'finished' : undefined;
}
