import { STALE_AFTER_MS, WindowRecord } from './windowRegistry';
import { OpenCodeAttention, OpenCodeSnapshot, attentionFor } from './opencodeStatus';

export interface WindowRow {
  record: WindowRecord;
  current: boolean;
  attention?: OpenCodeAttention;
}

export interface WindowRowSource {
  readonly sessionId: string;
  list(): Promise<WindowRecord[]>;
}

export type WindowRowsResult = { ok: true; rows: WindowRow[] } | { ok: false };

/**
 * Live-window rows for the Open Windows view. Kept free of vscode imports so the
 * filtering, current-window marking, and ordering stay covered by plain node tests.
 */
export async function listWindowRows(source: WindowRowSource, now = Date.now(),
  snapshot?: OpenCodeSnapshot): Promise<WindowRowsResult> {
  let records: WindowRecord[];
  try { records = await source.list(); }
  catch { return { ok: false }; }
  const rows = records
    .filter(record => now - record.updatedAt <= STALE_AFTER_MS && record.folders.length > 0)
    .map(record => ({ record, current: record.id === source.sessionId,
      attention: snapshot
        ? attentionFor(record.folders.map(folder => folder.uri), record.lastFocusedAt, snapshot)
        : undefined }));
  rows.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return firstFolderUri(left.record).localeCompare(firstFolderUri(right.record));
  });
  return { ok: true, rows };
}

function firstFolderUri(record: WindowRecord): string {
  return record.folders[0]?.uri ?? '';
}

/**
 * Icon selection for the Open Windows view. Returns a theme color id instead of
 * a ThemeColor so this module stays free of vscode imports.
 */
export function windowIcon(row: WindowRow): { id: string; colorId?: string } {
  return row.current ? { id: 'window', colorId: 'charts.green' } : { id: 'window' };
}
