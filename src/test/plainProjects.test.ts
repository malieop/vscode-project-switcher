import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface FakeUri { readonly scheme: string; readonly fsPath: string; toString(): string }
function fileUri(value: string): FakeUri {
  return { scheme: 'file', fsPath: value, toString: () => pathToFileURL(value).href };
}

let openDialogResult: FakeUri[] | undefined;
const messages: string[] = [];
const quickPickRows: unknown[][] = [];
const fakeVscode = {
  TreeItem: class {
    label: unknown;
    collapsibleState: unknown;
    constructor(label?: unknown, collapsibleState?: unknown) { this.label = label; this.collapsibleState = collapsibleState; }
  },
  EventEmitter: class { readonly event = () => ({ dispose() {} }); fire(): void {} dispose(): void {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(..._args: unknown[]) {} },
  Uri: { file: fileUri, parse: (value: string) => fileUri(fileURLToPath(value)) },
  ProgressLocation: { Notification: 15 },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => '' })
  },
  window: {
    showOpenDialog: async () => openDialogResult,
    showQuickPick: async (items: unknown[]) => { quickPickRows.push(items); return items[0]; },
    showInputBox: async () => undefined,
    showWarningMessage: async (message: string) => { messages.push(message); return undefined; },
    showErrorMessage: async (message: string) => { messages.push(message); return undefined; },
    showInformationMessage: async (message: string) => { messages.push(message); return undefined; },
    withProgress: async (_options: unknown, run: (_progress: unknown, token: unknown) => Promise<unknown>) =>
      run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
  }
};

// Node's test runner does not provide the VS Code extension-host module.
const loader = require('node:module') as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, isMain) => name === 'vscode' ? fakeVscode : originalLoad(name, parent, isMain);
const { ProjectCommands } = require('../projectCommands') as typeof import('../projectCommands');
const { ProjectsView, ProjectItem } = require('../projectsView') as typeof import('../projectsView');
loader._load = originalLoad;

function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function makeGitRepo(project: string, root: string): Promise<void> {
  await mkdir(project);
  await git(project, root, 'init', '-b', 'main', '--template=');
  await writeFile(join(project, 'file.txt'), 'original\n');
  await git(project, root, 'add', 'file.txt');
  await git(project, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'switcher-plain-'));
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  try {
    openDialogResult = undefined;
    messages.length = 0;
    quickPickRows.length = 0;
    fakeVscode.workspace.isTrusted = true;
    await run(root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function storeStub(initial: { uri: string }[]) {
  const records = [...initial];
  const added: string[] = [];
  return {
    added,
    records,
    getProjects: async () => [...records],
    refresh: async () => [...records],
    add: async (uri: string) => {
      added.push(uri);
      records.push({ uri });
      return { kind: 'added', projects: [...records] };
    },
    remove: async () => { throw new Error('Unexpected remove'); }
  };
}

const noRegistry = async (): Promise<never> => { throw new Error('Unexpected registry access'); };

test('a plain folder is saved directly without Git or errors', async () => {
  await fixture(async root => {
    const plain = join(root, 'notes');
    await mkdir(plain);
    openDialogResult = [fileUri(plain)];
    const store = storeStub([]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    await commands.add();
    assert.deepEqual(store.added, [pathToFileURL(plain).href]);
    assert.deepEqual(messages, []);
  });
});

test('a folder nested inside another Git repository saves as plain without a Git error', async () => {
  await fixture(async root => {
    const outer = join(root, 'outer');
    await makeGitRepo(outer, root);
    const inner = join(outer, 'inner');
    await mkdir(inner);
    openDialogResult = [fileUri(inner)];
    const store = storeStub([]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    await commands.add();
    assert.deepEqual(store.added, [pathToFileURL(inner).href]);
    assert.deepEqual(messages, []);
  });
});

test('a folder with a `.git` entry that Git cannot read shows the Git error and is not saved', async () => {
  await fixture(async root => {
    const broken = join(root, 'broken');
    await mkdir(join(broken, '.git'), { recursive: true });
    openDialogResult = [fileUri(broken)];
    const store = storeStub([]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    await commands.add();
    assert.deepEqual(store.added, []);
    assert.ok(messages.some(message => message.includes('git')), `expected a Git error, got: ${messages.join(' | ')}`);
  });
});

test('a Git main checkout is still saved', async () => {
  await fixture(async root => {
    const project = join(root, 'repo');
    await makeGitRepo(project, root);
    openDialogResult = [fileUri(project)];
    const store = storeStub([]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    await commands.add();
    assert.deepEqual(store.added, [pathToFileURL(project).href]);
    assert.deepEqual(messages, []);
  });
});

test('a linked worktree is declined with the main-checkout guidance', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    const project = join(root, 'repo');
    await makeGitRepo(project, root);
    const linked = join(root, 'linked');
    await git(project, root, 'worktree', 'add', linked, '-b', 'linked');
    openDialogResult = [fileUri(linked)];
    const store = storeStub([]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    await commands.add();
    assert.deepEqual(store.added, []);
    assert.ok(messages.some(message => message.includes('main Git checkout')),
      `expected main-checkout guidance, got: ${messages.join(' | ')}`);
  });
});

test('the sidebar distinguishes plain and Git projects and never expands a plain one', async () => {
  await fixture(async root => {
    const plain = join(root, 'plain');
    const repo = join(root, 'repo');
    await mkdir(plain);
    await mkdir(repo);
    let checkoutsLoaded = false;
    const view = new ProjectsView(async () => [
      { uri: fileUri(plain) as never, available: true, current: false, git: false },
      { uri: fileUri(repo) as never, available: true, current: false, git: true }
    ], async () => { checkoutsLoaded = true; return []; });
    const items = await view.getChildren();
    assert.equal(items.length, 2);
    const [plainItem, gitItem] = items as InstanceType<typeof ProjectItem>[];
    assert.equal(plainItem.collapsibleState, 0, 'plain project is not expandable');
    assert.equal(plainItem.contextValue, 'projectPlain');
    assert.ok(plainItem.command, 'plain project opens on click');
    assert.equal(gitItem.collapsibleState, 1, 'Git project stays expandable');
    assert.equal(gitItem.contextValue, 'projectGit');
    assert.equal((gitItem as unknown as { command?: unknown }).command, undefined);
    assert.deepEqual(await view.getChildren(plainItem), []);
    assert.equal(checkoutsLoaded, false, 'plain project never triggers checkout loading');
  });
});

test('Create Worktree from the palette on a plain project explains the Git requirement', async () => {
  await fixture(async root => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    const store = storeStub([{ uri: pathToFileURL(plain).href }]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    await commands.createWorktree();
    assert.ok(messages.some(message => message.includes('Worktrees require a Git repository')),
      `expected the Git-requirement explanation, got: ${messages.join(' | ')}`);
    assert.equal(messages.length, 1, 'no Git failure or further prompt follows the explanation');
  });
});

test('the quick picker shows a plain project as its own single row without a worktrees warning', async () => {
  await fixture(async root => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    const store = storeStub([{ uri: pathToFileURL(plain).href }]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    let selected: string | undefined;
    commands.select = async uri => { selected = uri.fsPath; return 'opened'; };
    await commands.pickAndSwitch();
    assert.equal(quickPickRows.length, 1);
    const rows = quickPickRows[0] as { label: string; uri: FakeUri }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'plain', 'a plain project row has no "Primary checkout" suffix');
    assert.equal(rows[0].uri.fsPath, plain);
    assert.ok(!messages.some(message => message.includes('Worktrees could not be loaded')));
    assert.equal(selected, plain);
  });
});

test('a plain project and a Git project appear together; the warning is reserved for Git failures', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    const repo = join(root, 'repo');
    await makeGitRepo(repo, root);
    const store = storeStub([{ uri: pathToFileURL(plain).href }, { uri: pathToFileURL(repo).href }]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    commands.select = async () => 'opened';
    await commands.pickAndSwitch();
    const rows = quickPickRows[0] as { label: string; detail?: string }[];
    assert.deepEqual(rows.map(row => row.label), ['plain', 'repo · Primary checkout']);
    assert.ok(rows[1].detail?.includes('main'));
    assert.ok(!messages.some(message => message.includes('Worktrees could not be loaded')));
  });
});

test('gaining or losing `.git` flips the project kind on the next load', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    const folder = join(root, 'project');
    await mkdir(folder);
    const store = storeStub([{ uri: pathToFileURL(folder).href }]);
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    assert.equal((await commands.entries())[0].git, false);
    await git(folder, root, 'init', '-b', 'main', '--template=');
    assert.equal((await commands.entries())[0].git, true);
    await rm(join(folder, '.git'), { recursive: true, force: true });
    assert.equal((await commands.entries())[0].git, false);
  });
});
