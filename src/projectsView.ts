import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ProjectEntry {
  uri: vscode.Uri;
  available: boolean;
  current: boolean;
  /** Derived from a `.git` entry at the folder root on every load; never stored. */
  git: boolean;
}

export interface CheckoutEntry {
  uri: vscode.Uri;
  projectUri: vscode.Uri;
  primary: boolean;
  available: boolean;
  current: boolean;
  branch?: string;
}

export class ProjectItem extends vscode.TreeItem {
  constructor(readonly project: ProjectEntry) {
    super(path.basename(project.uri.fsPath) || project.uri.fsPath,
      project.git ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = project.uri.toString();
    this.contextValue = project.git ? 'projectGit' : 'projectPlain';
    this.description = `${path.dirname(project.uri.fsPath)}${project.current ? ' · Current' : ''}${project.available ? '' : ' · Unavailable'}`;
    this.tooltip = project.uri.fsPath;
    this.iconPath = new vscode.ThemeIcon(project.available ? 'folder' : 'warning');
    if (!project.git) {
      this.command = { command: 'projectSwitcher.select', title: 'Open Project', arguments: [project.uri] };
    }
    this.accessibilityInformation = {
      label: `${this.label}, ${project.git ? 'Git project' : 'project'}, ${project.uri.fsPath}${project.current ? ', current project' : ''}${project.available ? '' : ', unavailable'}`
    };
  }
}

export class CheckoutItem extends vscode.TreeItem {
  constructor(readonly checkout: CheckoutEntry) {
    const name = checkout.primary ? 'Primary checkout' : path.basename(checkout.uri.fsPath) || checkout.uri.fsPath;
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = JSON.stringify(['checkout', checkout.projectUri.toString(), checkout.uri.toString()]);
    this.contextValue = checkout.primary ? 'checkoutPrimary' : 'checkoutLinked';
    this.description = [checkout.branch, checkout.current ? 'Current' : undefined,
      checkout.available ? undefined : 'Unavailable'].filter(Boolean).join(' · ');
    this.tooltip = checkout.uri.fsPath;
    this.iconPath = new vscode.ThemeIcon(checkout.available ? 'git-branch' : 'warning');
    this.command = { command: 'projectSwitcher.select', title: 'Open Checkout', arguments: [checkout.uri] };
    this.accessibilityInformation = {
      label: `${name}, ${checkout.branch ?? 'branch unavailable'}, ${checkout.uri.fsPath}${checkout.current ? ', current' : ''}${checkout.available ? '' : ', unavailable'}`
    };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon('warning');
  }
}

type TreeEntry = ProjectItem | CheckoutItem | MessageItem;

export class ProjectsView implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<TreeEntry | undefined>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly load: () => Promise<ProjectEntry[]>,
              private readonly loadCheckouts: (project: ProjectEntry) => Promise<CheckoutEntry[]>) {}

  refresh(): void { this.change.fire(undefined); }
  getTreeItem(item: TreeEntry): vscode.TreeItem { return item; }
  async getChildren(item?: TreeEntry): Promise<TreeEntry[]> {
    if (!item) {
      try { return (await this.load()).map(project => new ProjectItem(project)); }
      catch { return [new MessageItem('Saved projects are unavailable; check the warning')]; }
    }
    if (!(item instanceof ProjectItem)) return [];
    // A plain project is not expandable; never run Git discovery for it.
    if (!item.project.git) return [];
    try { return (await this.loadCheckouts(item.project)).map(checkout => new CheckoutItem(checkout)); }
    catch {
      return [new CheckoutItem({ ...item.project, projectUri: item.project.uri, primary: true }),
        new MessageItem(item.project.available ? 'Worktrees unavailable: check Git and the project checkout' : 'Project folder unavailable')];
    }
  }
  dispose(): void { this.change.dispose(); }
}
