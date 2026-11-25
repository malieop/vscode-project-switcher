import * as path from 'node:path';
import * as vscode from 'vscode';
import { WindowFolder, WindowRecord } from './windowRegistry';
import { WindowRow, WindowRowsResult, windowIcon } from './windowList';
import { windowUri } from './windowDecorations';
import { OpenCodeAttention } from './opencodeStatus';

const ATTENTION_TEXT: Record<OpenCodeAttention, string> = {
  waiting: 'OpenCode waiting',
  finished: 'OpenCode finished',
};

export class WindowItem extends vscode.TreeItem {
  constructor(readonly row: WindowRow) {
    const record = row.record;
    const first = vscode.Uri.parse(record.folders[0].uri);
    const name = path.basename(first.fsPath) || first.fsPath;
    super(name, record.folders.length > 1
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = JSON.stringify(['window', record.id]);
    this.contextValue = row.current ? 'windowCurrent' : 'windowOther';
    const attention = row.attention ? ATTENTION_TEXT[row.attention] : undefined;
    const parts: string[] = [];
    if (row.current) parts.push('Current window');
    if (attention) parts.push(attention);
    this.description = parts.join(' · ');
    this.tooltip = record.folders.map(folder => vscode.Uri.parse(folder.uri).fsPath).join('\n');
    const icon = windowIcon(row);
    this.iconPath = new vscode.ThemeIcon(icon.id, icon.colorId ? new vscode.ThemeColor(icon.colorId) : undefined);
    this.resourceUri = windowUri(record.id);
    this.command = { command: 'projectSwitcher.focusWindow', title: 'Focus Window',
      arguments: [record, record.folders[0].identity] };
    this.accessibilityInformation = {
      label: `${name}, window, ${first.fsPath}${row.current ? ', current window' : ''}${attention ? `, ${attention}` : ''}`
    };
  }
}

export class FolderItem extends vscode.TreeItem {
  constructor(readonly record: WindowRecord, readonly folder: WindowFolder) {
    const uri = vscode.Uri.parse(folder.uri);
    const name = path.basename(uri.fsPath) || uri.fsPath;
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = JSON.stringify(['window-folder', record.id, folder.uri]);
    this.contextValue = 'windowFolder';
    this.description = path.dirname(uri.fsPath);
    this.tooltip = uri.fsPath;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.command = { command: 'projectSwitcher.focusWindow', title: 'Focus Window',
      arguments: [record, folder.identity] };
    this.accessibilityInformation = { label: `${name}, folder, ${uri.fsPath}` };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon('warning');
  }
}

type TreeEntry = WindowItem | FolderItem | MessageItem;

export class WindowsView implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<TreeEntry | undefined>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly load: () => Promise<WindowRowsResult>) {}

  refresh(): void { this.change.fire(undefined); }
  getTreeItem(item: TreeEntry): vscode.TreeItem { return item; }
  async getChildren(item?: TreeEntry): Promise<TreeEntry[]> {
    if (item instanceof WindowItem) {
      return item.row.record.folders.map(folder => new FolderItem(item.row.record, folder));
    }
    if (item) return [];
    const result = await this.load();
    if (!result.ok) return [new MessageItem('Open windows are unavailable; check the window registry')];
    return result.rows.map(row => new WindowItem(row));
  }
  dispose(): void { this.change.dispose(); }
}
