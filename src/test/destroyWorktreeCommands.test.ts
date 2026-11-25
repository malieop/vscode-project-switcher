import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface FakeUri { readonly scheme: string; readonly fsPath: string; toString(): string }
function fileUri(value: string): FakeUri {
  return { scheme: 'file', fsPath: value, toString: () => pathToFileURL(value).href };
}

interface FakeHolder { id: string; folders: { uri: string; identity: string }[] }

const messages: string[] = [];
let trustGranted = true;
let destroyConfirmed = true;
let destroyAnyway: string | undefined;
let quickPickCapture: unknown[][] = [];
let quickPickChoice: ((items: unknown[]) => unknown) | undefined;
const registry = {
  sessionId: 'self-session',
  holder: undefined as FakeHolder | undefined,
  closeOutcome: 'closed' as 'closed' | 'still-open',
  closeError: undefined as Error | undefined,
  closeCalls: 0,
  busy: false,
  async find(_identity: string): Promise<FakeHolder | undefined> { return this.holder; },
  async close(_record: FakeHolder): Promise<string> {
    this.closeCalls++;
    if (this.closeError) throw this.closeError;
    return this.closeOutcome;
  },
  async guard<T>(_identity: string, action: () => Promise<T>): Promise<T | undefined> {
    return this.busy ? undefined : action();
  }
};
const fakeVscode = {
  TreeItem: class { constructor(..._args: unknown[]) {} },
  EventEmitter: class { readonly event = () => ({ dispose() {} }); fire(): void {} dispose(): void {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(..._args: unknown[]) {} },
  Uri: { file: fileUri, parse: (value: string) => fileUri(new URL(value).pathname) },
  ProgressLocation: { Notification: 15 },
  workspace: { isTrusted: true, workspaceFolders: undefined },
  window: {
    showQuickPick: async (items: unknown[]) => {
      quickPickCapture.push(items);
      return quickPickChoice ? quickPickChoice(items) : undefined;
    },
    showWarningMessage: async (message: string) => {
      messages.push(message);
      if (message.startsWith('Trust this project')) return trustGranted ? 'Trust and Continue' : undefined;
      if (message.startsWith('Destroying this worktree discards')) return destroyAnyway;
      return undefined;
    },
    showInformationMessage: async (message: string, options?: unknown) => {
      messages.push(message);
      if (typeof options === 'object' && options !== null) return destroyConfirmed ? 'Destroy Worktree' : undefined;
      return undefined;
    },
    showErrorMessage: async (message: string) => { messages.push(message); return undefined; },
    withProgress: async (_options: unknown, run: (_progress: unknown, token: unknown) => Promise<unknown>) =>
      run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
  }
};

// Node's test runner does not provide the VS Code extension-host module.
const loader = require('node:module') as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
let deleteBranchOverride: (() => Promise<never>) | undefined;
loader._load = (name, parent, isMain) => {
  if (name === 'vscode') return fakeVscode;
  if (name === './gitWorktreeRemove') {
    const real = originalLoad(name, parent, isMain) as typeof import('../gitWorktreeRemove');
    return {
      ...real,
      deleteBranch: (...args: Parameters<typeof real.deleteBranch>) =>
        deleteBranchOverride ? deleteBranchOverride() : real.deleteBranch(...args)
    };
  }
  return originalLoad(name, parent, isMain);
};
const { ProjectCommands } = require('../projectCommands') as typeof import('../projectCommands');
loader._load = originalLoad;

function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

interface Fixture { root: string; project: string; worktree: string }

async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'switcher-destroy-'));
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const project = join(root, 'project');
    await mkdir(project);
    await git(project, root, 'init', '-b', 'main', '--template=');
    await writeFile(join(project, 'file.txt'), 'original\n');
    await git(project, root, 'add', 'file.txt');
    await git(project, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
    await mkdir(join(root, 'worktrees'));
    await git(project, root, 'worktree', 'add', '-b', 'feature', join(root, 'worktrees', 'wt'));
    messages.length = 0;
    quickPickCapture = [];
    trustGranted = true;
    destroyConfirmed = true;
    destroyAnyway = undefined;
    quickPickChoice = undefined;
    deleteBranchOverride = undefined;
    fakeVscode.workspace.isTrusted = true;
    registry.holder = undefined;
    registry.closeOutcome = 'closed';
    registry.closeError = undefined;
    registry.closeCalls = 0;
    registry.busy = false;
    await run({ root, project: await realpath(project), worktree: await realpath(join(root, 'worktrees', 'wt')) });
  } finally {
    process.env.HOME = previous.HOME;
    process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    await rm(root, { recursive: true, force: true });
  }
}

function commandsFor(project: string): InstanceType<typeof ProjectCommands> {
  const uri = pathToFileURL(project).href;
  const store = { getProjects: async () => [{ uri }] };
  const view = { refresh() {} };
  return new ProjectCommands(store as never, view as never, async () => registry as never);
}

function itemFor(fixture: Fixture, primary = false): never {
  return {
    checkout: {
      uri: fileUri(primary ? fixture.project : fixture.worktree),
      projectUri: fileUri(fixture.project),
      primary,
      available: true,
      current: false,
      branch: primary ? 'main' : 'feature'
    }
  } as never;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function branchExists(fixture: Fixture, name: string): Promise<boolean> {
  return (await git(fixture.project, fixture.root, 'branch', '--list', name)).trim() !== '';
}

async function dirty(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.worktree, 'file.txt'), 'dirty\n');
}

async function commitOnWorktree(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.worktree, 'file.txt'), 'work\n');
  await git(fixture.worktree, fixture.root, 'add', 'file.txt');
  await git(fixture.worktree, fixture.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'work');
}

test('a clean worktree is destroyed with its branch after one confirmation', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(await exists(fixture.worktree), false);
    assert.equal(await branchExists(fixture, 'feature'), false);
    assert.ok(messages.some(message => message.includes('destroyed') && message.includes('feature')));
    assert.ok(messages.some(message => message.startsWith('Trust this project')));
  });
});

test('denied project trust changes nothing', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    trustGranted = false;
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(await exists(fixture.worktree), true);
    assert.equal(await branchExists(fixture, 'feature'), true);
  });
});

test('an untrusted workspace stops before the project trust prompt', async () => {
  await fixture(async fixture => {
    fakeVscode.workspace.isTrusted = false;
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(await exists(fixture.worktree), true);
    assert.ok(messages.some(message => message.includes('Trust this VS Code workspace')));
    assert.ok(!messages.some(message => message.startsWith('Trust this project')));
  });
});

test('losses are listed and require Destroy Anyway', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await commitOnWorktree(fixture);
    await dirty(fixture);
    await writeFile(join(fixture.worktree, 'untracked.txt'), 'new\n');
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    const warning = messages.find(message => message.startsWith('Destroying this worktree discards'));
    assert.ok(warning?.includes('Uncommitted changes'));
    assert.ok(warning?.includes('Untracked files'));
    assert.ok(warning?.includes('not merged'));
    assert.equal(await exists(fixture.worktree), true);
    assert.equal(await branchExists(fixture, 'feature'), true);
  });
});

test('Destroy Anyway forces removal and branch deletion', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await dirty(fixture);
    await commitOnWorktree(fixture);
    destroyAnyway = 'Destroy Anyway';
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(await exists(fixture.worktree), false);
    assert.equal(await branchExists(fixture, 'feature'), false);
  });
});

test('canceling the clean confirmation changes nothing', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    destroyConfirmed = false;
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(await exists(fixture.worktree), true);
    assert.equal(await branchExists(fixture, 'feature'), true);
  });
});

test('a locked worktree is reported and left untouched', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await git(fixture.project, fixture.root, 'worktree', 'lock', fixture.worktree);
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('locked')));
    assert.equal(await exists(fixture.worktree), true);
    assert.equal(await branchExists(fixture, 'feature'), true);
  });
});

test('a prunable registration is reported with a prune hint', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await rm(fixture.worktree, { recursive: true, force: true });
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('prunable') && message.includes('git worktree prune')));
    assert.equal(await branchExists(fixture, 'feature'), true);
  });
});

test('the primary checkout is refused even as an explicit item', async () => {
  await fixture(async fixture => {
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture, true));
    assert.ok(messages.some(message => message.includes('primary checkout')));
    assert.equal(await exists(fixture.project), true);
  });
});

test('a worktree open in this window is refused', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    registry.holder = { id: registry.sessionId, folders: [{ uri: 'file:///wt', identity: '1:1' }] };
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('another window')));
    assert.equal(registry.closeCalls, 0);
    assert.equal(await exists(fixture.worktree), true);
  });
});

test('a worktree in a multi-root window is refused', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    registry.holder = { id: 'other', folders: [{ uri: 'file:///wt', identity: '1:1' }, { uri: 'file:///other', identity: '2:2' }] };
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('multi-root')));
    assert.equal(registry.closeCalls, 0);
    assert.equal(await exists(fixture.worktree), true);
  });
});

test('the holding window is closed before removal', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    registry.holder = { id: 'other', folders: [{ uri: 'file:///wt', identity: '1:1' }] };
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(registry.closeCalls, 1);
    assert.equal(await exists(fixture.worktree), false);
  });
});

test('a failed close aborts the destroy', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    registry.holder = { id: 'other', folders: [{ uri: 'file:///wt', identity: '1:1' }] };
    registry.closeError = new Error('did not respond');
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('could not be closed') && message.includes('Nothing was removed')));
    assert.equal(await exists(fixture.worktree), true);
  });
});

test('a still-open window aborts the destroy', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    registry.holder = { id: 'other', folders: [{ uri: 'file:///wt', identity: '1:1' }] };
    registry.closeOutcome = 'still-open';
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('still open') && message.includes('nothing was removed')));
    assert.equal(await exists(fixture.worktree), true);
  });
});

test('a busy guard reports the worktree is busy and changes nothing', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    registry.busy = true;
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.ok(messages.some(message => message.includes('busy')));
    assert.equal(await exists(fixture.worktree), true);
  });
});

test('a detached worktree is removed without a branch step', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await git(fixture.project, fixture.root, 'worktree', 'add', '--detach', join(fixture.root, 'worktrees', 'det'));
    const detached = await realpath(join(fixture.root, 'worktrees', 'det'));
    const item = { checkout: { uri: fileUri(detached), projectUri: fileUri(fixture.project), primary: false,
      available: true, current: false, branch: 'Detached HEAD' } } as never;
    await commandsFor(fixture.project).destroyWorktree(item);
    assert.equal(await exists(detached), false);
    assert.equal(await branchExists(fixture, 'feature'), true);
    assert.ok(messages.some(message => message.includes('destroyed') && !message.includes('branch')));
  });
});

test('a failed branch deletion names the stage and keeps the branch', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    deleteBranchOverride = async () => { throw new Error('simulated branch failure'); };
    await commandsFor(fixture.project).destroyWorktree(itemFor(fixture));
    assert.equal(await exists(fixture.worktree), false);
    assert.equal(await branchExists(fixture, 'feature'), true);
    assert.ok(messages.some(message => message.includes('could not be deleted') && message.includes('still exists')));
  });
});

test('the palette picker lists linked worktrees only', { skip: process.platform === 'win32' }, async () => {
  await fixture(async fixture => {
    await commandsFor(fixture.project).destroyWorktree();
    assert.equal(quickPickCapture.length, 1);
    const items = quickPickCapture[0] as { label: string; checkout: { primary: boolean } }[];
    assert.equal(items.length, 1);
    assert.equal(items[0].checkout.primary, false);
    assert.ok(items[0].label.includes('wt'));
  });
});
