import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { folderIdentity } from './folderIdentity';
import { buildCheckoutModel, validatePrimaryCheckout } from './checkoutModel';
import { listWorktrees } from './gitDiscovery';
import { createBranchWorktree, fetchRemoteBranches, GitBranchRef, GitRemoteHead, GitWorktreeError, initializeRepository, listBranchRefs,
  ProjectIdentityError, listRemoteNames, suggestWorktreeDirectory, validateNewBranchName } from './gitWorktreeCreate';
import { deleteBranch, inspectWorktreeLosses, removeWorktree } from './gitWorktreeRemove';
import { ProjectRecord, ProjectStore, ProjectStoreError } from './projectStore';
import { CheckoutEntry, CheckoutItem, ProjectEntry, ProjectItem, ProjectsView } from './projectsView';
import { hasGitEntry } from './projectKind';
import { OpenChoice, switchProject, SwitchError, SwitchResult } from './switchProject';
import { listWindowRows } from './windowList';
import { CloseError, STALE_AFTER_MS, WindowFolder, WindowRecord, WindowRegistry } from './windowRegistry';
import { WindowItem } from './windowsView';
import { destinationExists, inspectProjectDirectory, validDirectoryComponent, worktreeDestination } from './worktreeDestination';
import { defaultRemote, sortStartingBranches, verifiedRemoteBranches } from './worktreeSelection';

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function identityForUri(uri: vscode.Uri): Promise<string> {
  const result = await folderIdentity(uri.toString());
  if (result.kind !== 'directory') throw new Error(`Folder identity unavailable: ${result.kind}`);
  return `${result.identity.device.toString()}:${result.identity.inode.toString()}`;
}

export async function currentWindowFolders(): Promise<WindowFolder[]> {
  const result: WindowFolder[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') throw new Error('Remote folders are not supported');
    result.push({ uri: folder.uri.toString(), identity: await identityForUri(folder.uri) });
  }
  return result;
}

interface ProjectQuickPick extends vscode.QuickPickItem {
  uri: vscode.Uri;
  project?: ProjectEntry;
}

interface WindowQuickPick extends vscode.QuickPickItem {
  window: WindowRecord;
  identity: string;
}

interface BranchQuickPick extends vscode.QuickPickItem {
  branch: GitBranchRef;
}

interface WorktreeQuickPick extends vscode.QuickPickItem {
  checkout: CheckoutEntry;
}

export class ProjectCommands {
  private lastAutomaticWarning: string | undefined;

  constructor(
    private readonly store: Pick<ProjectStore, 'getProjects' | 'refresh' | 'add' | 'remove'>,
    private readonly view: ProjectsView,
    private readonly registry: () => Promise<WindowRegistry>
  ) {}

  async entries(): Promise<ProjectEntry[]> {
    let records: readonly ProjectRecord[];
    try { records = await this.store.getProjects(); }
    catch (error) {
      await this.reportAutomaticStoreError(error);
      if (!(error instanceof ProjectStoreError) || error.knownProjects === undefined) throw error;
      records = error.knownProjects;
    }
    const workspace = vscode.workspace.workspaceFolders;
    let current: string | undefined;
    if (workspace?.length === 1 && workspace[0].uri.scheme === 'file') {
      try { current = await identityForUri(workspace[0].uri); } catch { /* The folder may have disappeared. */ }
    }
    return Promise.all(records.map(async record => {
      const uri = vscode.Uri.parse(record.uri);
      const result = await folderIdentity(record.uri);
      const identity = result.kind === 'directory'
        ? `${result.identity.device.toString()}:${result.identity.inode.toString()}` : undefined;
      const git = result.kind === 'directory' && await hasGitEntry(uri.fsPath);
      return { uri, available: result.kind === 'directory', current: identity !== undefined && identity === current, git };
    }));
  }

  async checkouts(project: ProjectEntry): Promise<CheckoutEntry[]> {
    const worktrees = await listWorktrees(project.uri.fsPath);
    const workspace = vscode.workspace.workspaceFolders;
    const current = workspace?.length === 1 && workspace[0].uri.scheme === 'file'
      ? workspace[0].uri.toString() : undefined;
    const rows = await buildCheckoutModel(project.uri.toString(), current, worktrees);
    return rows.map(row => ({ ...row, uri: vscode.Uri.parse(row.uri), projectUri: project.uri }));
  }

  async add(): Promise<void> {
    const selections = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: true,
      openLabel: 'Add Project', title: 'Select Existing Project Folders'
    });
    if (!selections) return;
    for (const uri of selections) {
      try {
        if (uri.scheme !== 'file') throw new Error('Only local project folders are supported.');
        // A folder with a `.git` entry keeps the existing Git validation; any
        // other existing local folder saves directly without running Git.
        if (await hasGitEntry(uri.fsPath)) {
          const worktrees = await listWorktrees(uri.fsPath);
          await validatePrimaryCheckout(uri.toString(), worktrees);
        }
        await this.store.add(uri.toString());
        this.view.refresh();
      } catch (error) {
        await this.reportStoreError(error);
        break;
      }
    }
  }

  async newProject(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Trust this VS Code workspace before creating a project.', 'Close');
      return;
    }
    // The configured root must already exist; it is never created implicitly.
    const root = vscode.workspace.getConfiguration('projectSwitcher').get<string>('projectsDirectory') ?? '';
    if (!root || !path.isAbsolute(root) || root.includes('\0')) {
      void vscode.window.showErrorMessage(
        `Set an absolute path in the projectSwitcher.projectsDirectory setting before creating a project. Current value: ${root || '(empty)'}`,
        'Close');
      return;
    }
    const rootStat = await fs.stat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) {
      void vscode.window.showErrorMessage(
        `The projectSwitcher.projectsDirectory setting does not point to an existing directory: ${root}`, 'Close');
      return;
    }

    let name = '';
    let destination = '';
    for (;;) {
      const input = await vscode.window.showInputBox({
        title: 'Name the new project', value: name,
        prompt: `The project folder will be created inside ${root}.`,
        validateInput: value => validDirectoryComponent(value) ? undefined : 'Enter a safe single directory name.'
      });
      if (input === undefined) return;
      name = input;
      if (!validDirectoryComponent(name)) {
        void vscode.window.showWarningMessage(
          'Enter a safe single directory name: no path separators, leading or trailing dots or spaces, or special characters.', 'Close');
        continue;
      }
      destination = path.join(root, name);
      // Anything at the destination — directory, file, or link — is left untouched.
      if (await destinationExists(destination)) {
        void vscode.window.showWarningMessage(
          `"${name}" already exists in ${root} and will not be adopted or overwritten. Choose another name.`, 'Close');
        continue;
      }
      break;
    }

    try {
      await fs.mkdir(destination);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `The project folder could not be created: ${error instanceof Error ? error.message : 'An unexpected error occurred.'}`, 'Close');
      return;
    }
    const created = await fs.lstat(destination, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink() || created.ino === 0n) {
      void vscode.window.showErrorMessage('The new project folder changed during creation. Try again.', 'Close');
      return;
    }
    const identity = `${created.dev.toString()}:${created.ino.toString()}`;

    // "No" is the default and canceling counts as "No"; the flow continues either way.
    const initialize = await vscode.window.showInformationMessage('Initialize a Git repository?', { modal: true }, 'No', 'Yes');
    if (initialize === 'Yes') {
      try {
        await initializeRepository(destination, undefined, identity);
      } catch (error) {
        void vscode.window.showWarningMessage(
          `The folder was created at ${destination}, but Git initialization failed: ${error instanceof Error ? error.message : 'An unexpected error occurred.'}\nIt will be saved as a plain project.`,
          'Close');
      }
    }

    try {
      await this.store.add(vscode.Uri.file(destination).toString());
    } catch (error) {
      // B-08: keep the created folder, show the known paths, and do not open.
      await this.reportStoreError(error);
      this.view.refresh();
      return;
    }
    this.view.refresh();
    await this.select(vscode.Uri.file(destination));
  }

  async remove(item?: ProjectItem): Promise<void> {
    let uri = item?.project.uri;
    if (!uri) uri = (await this.pickProject('Select a project to remove'))?.uri;
    if (!uri) return;
    try {
      await this.store.remove(uri.toString());
      this.view.refresh();
    } catch (error) { await this.reportStoreError(error); }
  }

  async createWorktree(item?: ProjectItem): Promise<void> {
    const entry = item?.project ?? (await this.pickProject('Select a project for the new worktree'))?.project;
    if (!entry) return;
    if (!entry.git) {
      void vscode.window.showInformationMessage(
        `Worktrees require a Git repository. ${path.basename(entry.uri.fsPath) || entry.uri.fsPath} is a plain project folder without Git.`,
        'Close');
      return;
    }
    const project = entry.uri;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Trust this VS Code workspace before creating worktrees.', 'Close');
      return;
    }
    if (process.platform === 'win32') {
      void vscode.window.showWarningMessage('Worktree creation is not supported on Windows yet.', 'Close');
      return;
    }
    let destination: string | undefined;
    let creationStarted = false;
    try {
      const identity = await identityForUri(project);
      const confirmed = await vscode.window.showWarningMessage(
        `Trust this project before running Git? Git can use its configuration, checkout filters, and credentials.\n\n${project.fsPath}`,
        { modal: true }, 'Trust and Continue'
      );
      if (confirmed !== 'Trust and Continue') return;
      await this.assertProjectUnchanged(project, identity);

      const remotes = await this.withCancellableProgress('Reading project remotes', signal => listRemoteNames(project.fsPath, signal, identity));
      let remote = defaultRemote(remotes);
      if (!remote && remotes.length > 1) {
        const orderedRemotes = [...remotes].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
        remote = await vscode.window.showQuickPick(orderedRemotes, { title: 'Choose a remote to fetch' });
        if (!remote) return;
      }
      let fetched = false;
      let advertised: readonly GitRemoteHead[] = [];
      if (remote) {
        await this.assertProjectUnchanged(project, identity);
        try {
          advertised = await this.withCancellableProgress('Fetching project branches', signal => fetchRemoteBranches(project.fsPath, remote!, signal, identity));
          fetched = true;
        } catch (error) {
          if (this.isCancelled(error)) return;
          if (error instanceof ProjectIdentityError) throw error;
          await this.assertProjectUnchanged(project, identity);
          void vscode.window.showWarningMessage('Fetch failed or remote branches could not be verified. Choose from local branches instead.', 'Close');
        }
      } else {
        void vscode.window.showInformationMessage('No remote is configured. Choose from local branches.', 'Close');
      }
      await this.assertProjectUnchanged(project, identity);
      const branches = await this.withCancellableProgress('Reading starting branches', signal => listBranchRefs(project.fsPath, fetched, signal, identity));
      const verified = fetched && remote ? verifiedRemoteBranches(branches, remote, advertised) : undefined;
      const ordered = sortStartingBranches(branches, fetched ? remote : undefined, verified);
      if (!ordered.length) {
        void vscode.window.showErrorMessage('No starting branches are available for this project.', 'Close');
        return;
      }
      const selected = await vscode.window.showQuickPick<BranchQuickPick>(ordered.map(branch => ({
        label: branch.name,
        description: branch.kind === 'local' ? 'Local branch' : 'Remote-tracking branch',
        detail: branch.kind === 'remote' && !verified?.has(branch.ref)
          ? 'Locally cached; not confirmed by the latest fetch' : branch.ref,
        branch
      })), { title: 'Choose the starting branch', matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;

      let branchName = '';
      for (;;) {
        const name = await vscode.window.showInputBox({
          title: 'Name the new branch', value: branchName,
          validateInput: value => value ? undefined : 'Enter a new branch name.'
        });
        if (name === undefined) return;
        branchName = name;
        try {
          await this.assertProjectUnchanged(project, identity);
          await validateNewBranchName(project.fsPath, branchName, identity);
          break;
        }
        catch (error) {
          if (error instanceof ProjectIdentityError) throw error;
          await this.assertProjectUnchanged(project, identity);
          if (error instanceof GitWorktreeError && error.reason !== 'failed') throw error;
          const message = error instanceof Error ? error.message : 'Invalid branch name.';
          void vscode.window.showWarningMessage(`Choose a valid new branch name. ${message}`, 'Close');
        }
      }

      const root = vscode.workspace.getConfiguration('projectSwitcher').get<string>('worktreesDirectory') ?? '';
      const projectName = suggestWorktreeDirectory(path.basename(project.fsPath));
      const group = path.dirname(worktreeDestination(root, projectName, 'worktree'));
      const initialGroup = await inspectProjectDirectory(root, projectName);
      if (initialGroup.groupIdentity) {
        const useExisting = await vscode.window.showWarningMessage(
          `This directory already exists and may belong to another project. Use it as the worktree parent? Existing files will not be overwritten.\n\n${group}`,
          { modal: true }, 'Use Directory'
        );
        if (useExisting !== 'Use Directory') return;
      }
      let directoryName = suggestWorktreeDirectory(branchName);
      for (;;) {
        const name = await vscode.window.showInputBox({
          title: 'Choose the worktree directory name', value: directoryName,
          prompt: `The directory will be created inside ${group}.`,
          validateInput: value => validDirectoryComponent(value) ? undefined : 'Enter a safe single directory name.'
        });
        if (name === undefined) return;
        directoryName = name;
        destination = worktreeDestination(root, projectName, directoryName);
        if (!await destinationExists(destination)) break;
        void vscode.window.showWarningMessage('That worktree destination already exists. Choose another name.', 'Close');
      }
      const create = await vscode.window.showInformationMessage(
        `Create branch ${branchName} from ${selected.branch.name}?\n\nWorktree: ${destination}`,
        { modal: true }, 'Create Worktree'
      );
      if (create !== 'Create Worktree') return;
      await this.assertProjectUnchanged(project, identity);
      const currentGroup = await inspectProjectDirectory(root, projectName);
      if (currentGroup.rootIdentity !== initialGroup.rootIdentity || currentGroup.groupIdentity !== initialGroup.groupIdentity) {
        throw new Error('The worktree parent changed during confirmation. Try again.');
      }
      if (!initialGroup.groupIdentity) await fs.mkdir(group, { mode: 0o700 });
      const verifiedGroup = await inspectProjectDirectory(root, projectName);
      if (verifiedGroup.rootIdentity !== initialGroup.rootIdentity || !verifiedGroup.groupIdentity ||
          (initialGroup.groupIdentity && verifiedGroup.groupIdentity !== initialGroup.groupIdentity)) {
        throw new Error('The worktree parent changed during creation. Try again.');
      }
      creationStarted = true;
      const created = await this.withCancellableProgress('Creating worktree', signal =>
        createBranchWorktree(project.fsPath, branchName, selected.branch.ref, destination!, signal, verifiedGroup.groupIdentity, identity));
      this.view.refresh();
      const result = await this.select(vscode.Uri.file(created), 'new');
      if (!result || result === 'cancelled') {
        void vscode.window.showWarningMessage(`Worktree created at ${created}, but its window could not be confirmed.`, 'Close');
      }
    } catch (error) {
      this.view.refresh();
      if (creationStarted && destination) {
        const reason = error instanceof Error ? error.message : 'An unexpected error occurred.';
        void vscode.window.showWarningMessage(`Worktree creation did not finish: ${reason}\nInspect ${destination}; no files were deleted.`, 'Close');
      } else if (!this.isCancelled(error)) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'The worktree could not be created.', 'Close');
      }
    }
  }

  private async assertProjectUnchanged(project: vscode.Uri, identity: string): Promise<void> {
    if (!vscode.workspace.isTrusted || await identityForUri(project) !== identity) {
      throw new Error('The project or workspace trust changed. Try again.');
    }
  }

  async destroyWorktree(item?: CheckoutItem): Promise<void> {
    const checkout = item?.checkout ?? (await this.pickLinkedWorktree())?.checkout;
    if (!checkout) return;
    if (checkout.primary) {
      void vscode.window.showWarningMessage('The primary checkout can never be destroyed.', 'Close');
      return;
    }
    const project = checkout.projectUri;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Trust this VS Code workspace before destroying worktrees.', 'Close');
      return;
    }
    if (process.platform === 'win32') {
      void vscode.window.showWarningMessage('Destroying worktrees is not supported on Windows yet.', 'Close');
      return;
    }
    try {
      const identity = await identityForUri(project);
      const confirmed = await vscode.window.showWarningMessage(
        `Trust this project before running Git? Git can use its configuration, checkout filters, and credentials.\n\n${project.fsPath}`,
        { modal: true }, 'Trust and Continue'
      );
      if (confirmed !== 'Trust and Continue') return;
      await this.assertProjectUnchanged(project, identity);

      // Re-validate the target against a fresh Git listing before acting.
      const worktrees = await listWorktrees(project.fsPath);
      const index = worktrees.findIndex(worktree => worktree.path === checkout.uri.fsPath);
      if (index < 0) {
        void vscode.window.showInformationMessage(
          'This worktree is no longer registered in Git. It may have been removed outside the extension; nothing was changed.', 'Close');
        return;
      }
      const record = worktrees[index];
      if (index === 0) {
        void vscode.window.showWarningMessage('The primary checkout can never be destroyed.', 'Close');
        return;
      }
      if (record.locked) {
        void vscode.window.showWarningMessage(
          'This worktree is locked in Git. Unlock it manually (git worktree unlock) and try again; nothing was changed.', 'Close');
        return;
      }
      if (record.prunable) {
        void vscode.window.showWarningMessage(
          `Git considers this worktree prunable (its folder is missing or stale). Run git worktree prune in ${project.fsPath} to clean up; nothing was changed.`, 'Close');
        return;
      }
      let worktreeIdentity: string;
      try { worktreeIdentity = await identityForUri(checkout.uri); }
      catch {
        void vscode.window.showWarningMessage('The worktree folder is unavailable; nothing was changed.', 'Close');
        return;
      }
      const registry = await this.registry();
      const destroyed = await registry.guard(worktreeIdentity, async () => {
        // Close a participating window holding the worktree before any Git mutation.
        const holder = await registry.find(worktreeIdentity);
        if (holder && holder.id === registry.sessionId) {
          void vscode.window.showWarningMessage(
            'This worktree is open in this window. Run Destroy Worktree from another window; nothing was changed.', 'Close');
          return false;
        }
        if (holder && holder.folders.length > 1) {
          void vscode.window.showWarningMessage(
            'This worktree is one folder of a multi-root window. Remove the folder from that workspace first; nothing was changed.', 'Close');
          return false;
        }
        if (holder) {
          let outcome;
          try { outcome = await registry.close(holder); }
          catch (error) {
            void vscode.window.showErrorMessage(
              `The window holding the worktree could not be closed: ${error instanceof Error ? error.message : 'An unexpected error occurred.'} Nothing was removed.`, 'Close');
            return false;
          }
          if (outcome !== 'closed') {
            void vscode.window.showWarningMessage(
              'The window holding the worktree is still open. Its close may have been canceled; nothing was removed.', 'Close');
            return false;
          }
        }
        await this.assertProjectUnchanged(project, identity);
        // Pre-flight runs after the close step: the user may have edited files meanwhile.
        const losses = await this.withCancellableProgress('Checking the worktree', signal =>
          inspectWorktreeLosses(project.fsPath, record.path, { branch: record.branch, head: record.head },
            signal, identity, worktreeIdentity));
        const categories: string[] = [];
        if (losses.uncommittedChanges) categories.push('Uncommitted changes');
        if (losses.untrackedFiles) categories.push('Untracked files');
        if (losses.unmergedCommits) {
          categories.push(record.branch
            ? `Commits on branch ${record.branch} not merged into the main checkout or its upstream`
            : 'Checked-out commits not reachable from the main checkout');
        }
        let forced = false;
        if (categories.length) {
          const choice = await vscode.window.showWarningMessage(
            `Destroying this worktree discards:\n${categories.map(category => `• ${category}`).join('\n')}\n\nWorktree: ${record.path}`,
            { modal: true }, 'Destroy Anyway');
          if (choice !== 'Destroy Anyway') return false;
          forced = true;
        } else {
          const choice = await vscode.window.showInformationMessage(
            `Destroy this worktree${record.branch ? ' and delete its branch' : ''}?\n\nProject: ${project.fsPath}\nWorktree: ${record.path}${record.branch ? `\nBranch: ${record.branch}` : ''}`,
            { modal: true }, 'Destroy Worktree');
          if (choice !== 'Destroy Worktree') return false;
        }
        await this.assertProjectUnchanged(project, identity);
        try {
          await this.withCancellableProgress('Removing the worktree', signal =>
            removeWorktree(project.fsPath, record.path, forced, signal, identity));
        } catch (error) {
          if (this.isCancelled(error)) return false;
          void vscode.window.showErrorMessage(
            `The worktree could not be removed: ${error instanceof Error ? error.message : 'An unexpected error occurred.'}\nNothing was removed${record.branch ? `; branch ${record.branch} was not touched` : ''}.`, 'Close');
          return false;
        }
        if (record.branch) {
          try {
            await this.withCancellableProgress('Deleting the branch', signal =>
              deleteBranch(project.fsPath, record.branch!, forced, signal, identity));
          } catch (error) {
            const reason = this.isCancelled(error) ? 'the deletion was canceled'
              : error instanceof Error ? error.message : 'An unexpected error occurred.';
            void vscode.window.showWarningMessage(
              `The worktree was removed, but branch ${record.branch} could not be deleted: ${reason}.\nThe branch still exists.`, 'Close');
            return true;
          }
          void vscode.window.showInformationMessage(`The worktree was destroyed and branch ${record.branch} was deleted.`, 'Close');
        } else {
          void vscode.window.showInformationMessage('The worktree was destroyed.', 'Close');
        }
        return true;
      });
      if (destroyed === undefined) {
        void vscode.window.showWarningMessage(
          'This worktree is busy: another window is already destroying it. Nothing was changed.', 'Close');
        return;
      }
      this.view.refresh();
    } catch (error) {
      this.view.refresh();
      if (!this.isCancelled(error)) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'The worktree could not be destroyed.', 'Close');
      }
    }
  }

  private isCancelled(error: unknown): boolean {
    return error instanceof GitWorktreeError && error.reason === 'cancelled';
  }

  private async withCancellableProgress<T>(title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_, token) => {
      const controller = new AbortController();
      if (token.isCancellationRequested) controller.abort();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try { return await operation(controller.signal); }
      finally { subscription.dispose(); }
    });
  }

  async pickAndSwitch(): Promise<void> {
    const selected = await this.pickCheckout('Select a project or worktree');
    if (selected) await this.select(selected.uri);
  }

  async openWithChoice(choice: OpenChoice, item?: ProjectItem | CheckoutItem): Promise<void> {
    const itemUri = item instanceof ProjectItem ? item.project.uri
      : item instanceof CheckoutItem ? item.checkout.uri : undefined;
    const uri = itemUri ?? (await this.pickCheckout('Select a project or worktree'))?.uri;
    if (uri) await this.select(uri, choice);
  }

  async select(uri: vscode.Uri, preferredChoice?: OpenChoice): Promise<SwitchResult | undefined> {
    try {
      return await switchProject({
        identify: () => identityForUri(uri),
        isCurrent: async identity => {
          const folders = vscode.workspace.workspaceFolders;
          if (folders?.length !== 1 || folders[0].uri.scheme !== 'file') return false;
          try { return await identityForUri(folders[0].uri) === identity; } catch { return false; }
        },
        find: async identity => (await this.registry()).find(identity),
        focus: async (target, identity) => (await this.registry()).focus(target, identity),
        choose: async () => {
          const chosen = await vscode.window.showQuickPick([
            { label: 'Current Window', choice: 'current' as const },
            { label: 'New Window', choice: 'new' as const }
          ], { title: `Open ${path.basename(uri.fsPath) || uri.fsPath}`, placeHolder: 'Choose where to open the project' });
          return chosen?.choice;
        },
        claim: async identity => (await this.registry()).claim(identity),
        releaseUnstartedClaim: async (identity, token) => (await this.registry()).releaseUnstartedClaim(identity, token),
        revalidate: async identity => await identityForUri(uri) === identity,
        open: async choice => {
          await vscode.commands.executeCommand('vscode.openFolder', uri, {
            forceReuseWindow: choice === 'current', forceNewWindow: choice === 'new'
          });
        },
        waitForRegistration: async identity => {
          const end = Date.now() + 8_000;
          while (Date.now() < end) {
            if (await (await this.registry()).find(identity)) return true;
            await delay(250);
          }
          return false;
        }
      }, preferredChoice);
    } catch (error) {
      if (error instanceof SwitchError && ['discovery', 'focus', 'busy', 'unconfirmed'].includes(error.stage)) {
        await this.windowFailure(error.message);
      } else {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'The project could not be opened.', 'Close');
      }
      return undefined;
    }
  }

  async openWindows(): Promise<void> {
    try {
      const registry = await this.registry();
      const records = (await registry.list()).filter(record => Date.now() - record.updatedAt <= STALE_AFTER_MS);
      const choices: WindowQuickPick[] = [];
      for (const record of records) {
        for (const folder of record.folders) {
          const uri = vscode.Uri.parse(folder.uri);
          choices.push({
            label: path.basename(uri.fsPath) || uri.fsPath,
            description: `${uri.fsPath}${record.id === registry.sessionId ? ' · Current window' : ''}`,
            detail: `Window ${record.id.slice(0, 8)}`,
            window: record,
            identity: folder.identity
          });
        }
      }
      if (!choices.length) {
        await vscode.window.showInformationMessage('No participating project windows were found.', 'Close');
        return;
      }
      const selected = await vscode.window.showQuickPick(choices, {
        title: 'Open Project Windows', placeHolder: 'Select a window to focus', matchOnDescription: true
      });
      if (selected) await registry.focus(selected.window, selected.identity);
    } catch { await this.windowFailure('The project window could not be found or focused.'); }
  }

  async focusWindow(record: WindowRecord, identity: string): Promise<void> {
    try { await (await this.registry()).focus(record, identity); }
    catch { await this.windowFailure('The project window could not be found or focused.'); }
  }

  async closeWindow(item?: WindowItem): Promise<void> {
    let registry: WindowRegistry;
    try { registry = await this.registry(); }
    catch { await vscode.window.showErrorMessage('Open windows are unavailable; check the window registry.', 'Close'); return; }
    let record = item?.row.record;
    if (!record) {
      const result = await listWindowRows(registry);
      if (!result.ok) { await vscode.window.showErrorMessage('Open windows are unavailable; check the window registry.', 'Close'); return; }
      if (!result.rows.length) {
        await vscode.window.showInformationMessage('No participating project windows were found.', 'Close');
        return;
      }
      const picked = await vscode.window.showQuickPick(result.rows.map(row => {
        const first = vscode.Uri.parse(row.record.folders[0].uri);
        return {
          label: path.basename(first.fsPath) || first.fsPath,
          description: `${path.dirname(first.fsPath)}${row.current ? ' · Current window' : ''}`,
          detail: `Window ${row.record.id.slice(0, 8)}`,
          row
        };
      }), { title: 'Close Window', placeHolder: 'Select a window to close', matchOnDescription: true });
      if (!picked) return;
      record = picked.row.record;
    }
    // Self-close runs the native command directly; no request is written.
    if (record.id === registry.sessionId) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
      return;
    }
    try {
      const outcome = await registry.close(record);
      if (outcome === 'closed') void vscode.window.showInformationMessage('The window was closed.');
      else void vscode.window.showWarningMessage('The window is still open. Its close may have been canceled.', 'Close');
    } catch (error) {
      if (error instanceof CloseError && error.reason === 'no-response') {
        const selection = await vscode.window.showErrorMessage(
          'The selected window did not respond. No other window was closed.', 'Switch Window', 'Close');
        if (selection === 'Switch Window') {
          try { await vscode.commands.executeCommand('workbench.action.switchWindow'); }
          catch { await vscode.window.showErrorMessage('VS Code could not open its window picker.', 'Close'); }
        }
        return;
      }
      await vscode.window.showErrorMessage(
        `${error instanceof Error ? error.message : 'The window could not be closed.'} No other window was closed.`, 'Close');
    }
  }

  async refresh(): Promise<void> {
    try { await this.store.refresh(); this.lastAutomaticWarning = undefined; }
    catch (error) { await this.reportAutomaticStoreError(error); }
    this.view.refresh();
  }

  private async pickProject(placeHolder: string): Promise<ProjectQuickPick | undefined> {
    let projects: ProjectEntry[];
    try { projects = await this.entries(); } catch { return undefined; }
    return vscode.window.showQuickPick(projects.map(project => ({
      label: path.basename(project.uri.fsPath) || project.uri.fsPath,
      description: project.uri.fsPath,
      detail: project.available ? (project.current ? 'Current project' : undefined) : 'Unavailable',
      uri: project.uri,
      project
    })), { placeHolder, matchOnDescription: true });
  }

  private async pickLinkedWorktree(): Promise<WorktreeQuickPick | undefined> {
    let projects: ProjectEntry[];
    try { projects = await this.entries(); } catch { return undefined; }
    const choices: WorktreeQuickPick[] = [];
    const failures: string[] = [];
    for (const project of projects) {
      if (!project.git) continue;
      let checkouts: CheckoutEntry[];
      try { checkouts = await this.checkouts(project); }
      catch { failures.push(project.uri.fsPath); continue; }
      const projectName = path.basename(project.uri.fsPath) || project.uri.fsPath;
      for (const checkout of checkouts) {
        if (checkout.primary) continue;
        choices.push({
          label: `${projectName} · ${path.basename(checkout.uri.fsPath) || checkout.uri.fsPath}`,
          description: checkout.uri.fsPath,
          detail: [checkout.branch, checkout.available ? undefined : 'Unavailable'].filter(Boolean).join(' · '),
          checkout
        });
      }
    }
    if (failures.length) {
      void vscode.window.showWarningMessage(`Worktrees could not be loaded for: ${failures.join(', ')}.`, 'Close');
    }
    if (!choices.length) {
      void vscode.window.showInformationMessage('No linked worktrees were found.', 'Close');
      return undefined;
    }
    return vscode.window.showQuickPick(choices, {
      title: 'Destroy Worktree', placeHolder: 'Select a worktree to destroy', matchOnDescription: true, matchOnDetail: true
    });
  }

  private async pickCheckout(placeHolder: string): Promise<ProjectQuickPick | undefined> {
    let projects: ProjectEntry[];
    try { projects = await this.entries(); } catch { return undefined; }
    const choices: ProjectQuickPick[] = [];
    const failures: string[] = [];
    for (const project of projects) {
      const projectName = path.basename(project.uri.fsPath) || project.uri.fsPath;
      if (!project.git) {
        // A plain project is its own single row; no Git process runs for it.
        choices.push({
          label: projectName,
          description: project.uri.fsPath,
          detail: project.available ? (project.current ? 'Current' : undefined) : 'Unavailable',
          uri: project.uri
        });
        continue;
      }
      let checkouts: CheckoutEntry[];
      try { checkouts = await this.checkouts(project); }
      catch {
        failures.push(project.uri.fsPath);
        checkouts = [{ ...project, projectUri: project.uri, primary: true }];
      }
      for (const checkout of checkouts) {
        const name = checkout.primary ? 'Primary checkout' : path.basename(checkout.uri.fsPath) || checkout.uri.fsPath;
        choices.push({
          label: `${projectName} · ${name}`,
          description: checkout.uri.fsPath,
          detail: [checkout.branch, checkout.available ? (checkout.current ? 'Current' : undefined) : 'Unavailable'].filter(Boolean).join(' · '),
          uri: checkout.uri
        });
      }
    }
    if (failures.length) {
      void vscode.window.showWarningMessage(`Worktrees could not be loaded for: ${failures.join(', ')}. Primary checkouts remain available.`, 'Close');
    }
    return vscode.window.showQuickPick(choices, { placeHolder, matchOnDescription: true, matchOnDetail: true });
  }

  private async reportStoreError(error: unknown): Promise<void> {
    if (error instanceof ProjectStoreError) {
      const paths = error.knownProjects?.map(project => vscode.Uri.parse(project.uri).fsPath);
      const list = paths === undefined ? 'No reliable saved list is available.'
        : paths.length ? `Last confirmed projects:\n${paths.join('\n')}` : 'The last confirmed list is empty.';
      await vscode.window.showWarningMessage(`${error.message}\n\n${list}`, { modal: true }, 'Close');
      return;
    }
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'The project list could not be updated.', 'Close');
  }

  private async reportAutomaticStoreError(error: unknown): Promise<void> {
    const key = error instanceof ProjectStoreError ? `${error.code}:${JSON.stringify(error.knownProjects)}` : String(error);
    if (key === this.lastAutomaticWarning) return;
    this.lastAutomaticWarning = key;
    await this.reportStoreError(error);
  }

  private async windowFailure(message: string): Promise<void> {
    const selection = await vscode.window.showErrorMessage(`${message} No additional window will be opened automatically.`, 'Switch Window', 'Close');
    if (selection === 'Switch Window') {
      try { await vscode.commands.executeCommand('workbench.action.switchWindow'); }
      catch { await vscode.window.showErrorMessage('VS Code could not open its window picker.', 'Close'); }
    }
  }
}
