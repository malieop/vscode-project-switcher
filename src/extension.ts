import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProjectCommands, currentWindowFolders } from './projectCommands';
import { CheckoutItem, ProjectsView } from './projectsView';
import { SharedProjectStore } from './sharedProjectStore';
import { listWindowRows } from './windowList';
import { WindowRecord, WindowRegistry } from './windowRegistry';
import { WindowItem, WindowsView } from './windowsView';
import { WindowDecorations } from './windowDecorations';
import { EMPTY_SNAPSHOT, OpenCodeSnapshot, folderPath } from './opencodeStatus';
import { OpenCodeStatus } from './opencodeClient';

let liveRegistry: WindowRegistry | undefined;
let pendingRegistryUpdate: Promise<void> = Promise.resolve();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Shared home-dir root: saved projects and the live-window registry are
  // visible across VS Code profiles (B-11, cross-profile-windows P-01).
  const sharedRoot = path.join(os.homedir(), '.vscode-project-switcher');
  const store = new SharedProjectStore(sharedRoot, context.globalState);
  const registry = new WindowRegistry(sharedRoot, async identity => {
    const folders = await currentWindowFolders();
    if (!folders.some(folder => folder.identity === identity)) throw new Error('The selected window no longer has the project.');
    await vscode.commands.executeCommand('workbench.action.focusWindow');
  }, async () => {
    // Fixed close action for validated close requests; VS Code owns unsaved changes.
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  });
  liveRegistry = registry;
  let registryError: unknown;
  let registryStarted = false;

  function updateRegistry(): Promise<void> {
    const update = pendingRegistryUpdate.then(async () => {
      try {
        const folders = await currentWindowFolders();
        if (registryStarted) await registry.setFolders(folders);
        else { await registry.start(folders); registryStarted = true; }
        registryError = undefined;
      } catch (error) { registryError = error; }
    });
    pendingRegistryUpdate = update;
    return update;
  }
  void updateRegistry();

  const getRegistry = async (): Promise<WindowRegistry> => {
    await pendingRegistryUpdate;
    if (registryError) throw registryError;
    return registry;
  };

  let commands: ProjectCommands;
  const view = new ProjectsView(() => commands.entries(), project => commands.checkouts(project));
  commands = new ProjectCommands(store, view, getRegistry);
  const status = new OpenCodeStatus();
  const decorations = new WindowDecorations();
  let latestSnapshot: OpenCodeSnapshot = EMPTY_SNAPSHOT;
  const windowsView = new WindowsView(async () => {
    try { return await listWindowRows(await getRegistry(), undefined, latestSnapshot); }
    catch { return { ok: false as const }; }
  });
  context.subscriptions.push(view);
  context.subscriptions.push(windowsView);
  context.subscriptions.push(decorations);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('projectSwitcher.projects', view));
  const windowsTree = vscode.window.createTreeView('projectSwitcher.windows', { treeDataProvider: windowsView });
  context.subscriptions.push(windowsTree);

  // Poll OpenCode through the shared background service. Failures are silent:
  // the previous snapshot stays in place and badges simply go stale (R2).
  const pollStatus = async (): Promise<void> => {
    try {
      const registry = await getRegistry();
      const records = await registry.list();
      const directories = [...new Set(records.flatMap(record => record.folders
        .map(folder => folderPath(folder.uri)).filter((p): p is string => p !== undefined)))];
      latestSnapshot = await status.poll(directories);
      const rows = await listWindowRows(registry, undefined, latestSnapshot);
      if (rows.ok) {
        decorations.update(new Map(rows.rows.flatMap(row => row.attention
          ? [[row.record.id, row.attention]] as const : [])));
      }
      windowsView.refresh();
    } catch { /* registry unavailable: keep the previous snapshot */ }
  };

  // Poll the registry only while the Open Windows view is visible; the registry
  // heartbeats every 3s, so faster polling adds nothing. OpenCode status polls
  // on a slower 5s cadence under the same visibility gate.
  let windowsTimer: NodeJS.Timeout | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  const updateWindowsTimer = (visible: boolean): void => {
    if (visible && !windowsTimer) {
      windowsTimer = setInterval(() => windowsView.refresh(), 3_000);
      windowsTimer.unref();
      statusTimer = setInterval(() => void pollStatus(), 5_000);
      statusTimer.unref();
      void pollStatus();
    } else if (!visible && windowsTimer) {
      clearInterval(windowsTimer);
      windowsTimer = undefined;
      if (statusTimer) { clearInterval(statusTimer); statusTimer = undefined; }
    }
  };
  context.subscriptions.push(windowsTree.onDidChangeVisibility(event => updateWindowsTimer(event.visible)));
  context.subscriptions.push(new vscode.Disposable(() => {
    if (windowsTimer) clearInterval(windowsTimer);
    if (statusTimer) clearInterval(statusTimer);
  }));
  updateWindowsTimer(windowsTree.visible);
  context.subscriptions.push(
    vscode.commands.registerCommand('projectSwitcher.add', () => commands.add()),
    vscode.commands.registerCommand('projectSwitcher.newProject', () => commands.newProject()),
    vscode.commands.registerCommand('projectSwitcher.remove', item => commands.remove(item)),
    vscode.commands.registerCommand('projectSwitcher.createWorktree', item => commands.createWorktree(item)),
    vscode.commands.registerCommand('projectSwitcher.destroyWorktree', (item?: CheckoutItem) => commands.destroyWorktree(item)),
    vscode.commands.registerCommand('projectSwitcher.switch', () => commands.pickAndSwitch()),
    vscode.commands.registerCommand('projectSwitcher.select', uri => commands.select(uri)),
    vscode.commands.registerCommand('projectSwitcher.openHere', item => commands.openWithChoice('current', item)),
    vscode.commands.registerCommand('projectSwitcher.openNewWindow', item => commands.openWithChoice('new', item)),
    vscode.commands.registerCommand('projectSwitcher.openWindows', () => commands.openWindows()),
    vscode.commands.registerCommand('projectSwitcher.focusWindow',
      (record: WindowRecord, identity: string) => commands.focusWindow(record, identity)),
    vscode.commands.registerCommand('projectSwitcher.closeWindow', (item?: WindowItem) => commands.closeWindow(item)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void updateRegistry(); }),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        registry.noteFocused(Date.now());
        void updateRegistry();
        void commands.refresh();
        windowsView.refresh();
      }
    })
  );
  if (vscode.window.state.focused) registry.noteFocused(Date.now());
  void commands.refresh();

}

export async function deactivate(): Promise<void> {
  const registry = liveRegistry;
  liveRegistry = undefined;
  await pendingRegistryUpdate.catch(() => undefined);
  if (registry) await registry.dispose().catch(() => undefined);
}
