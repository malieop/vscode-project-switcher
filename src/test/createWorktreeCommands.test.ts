import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectStoreError } from '../projectStore';

interface FakeUri { readonly scheme: string; readonly fsPath: string; toString(): string }
function fileUri(value: string): FakeUri {
  return { scheme: 'file', fsPath: value, toString: () => pathToFileURL(value).href };
}

let worktreesRoot = '';
let answers: string[] = [];
let trustGranted = true;
let creationConfirmed = true;
let beforeRemoteChoice: (() => Promise<void>) | undefined;
const messages: string[] = [];
const fakeVscode = {
  TreeItem: class { constructor(..._args: unknown[]) {} },
  EventEmitter: class { readonly event = () => ({ dispose() {} }); fire(): void {} dispose(): void {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(..._args: unknown[]) {} },
  Uri: { file: fileUri, parse: (value: string) => fileUri(fileURLToPath(value)) },
  ProgressLocation: { Notification: 15 },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => worktreesRoot })
  },
  window: {
    showQuickPick: async (items: unknown[]) => {
      if (typeof items[0] === 'string' && beforeRemoteChoice) await beforeRemoteChoice();
      return items[0];
    },
    showInputBox: async () => answers.shift(),
    showWarningMessage: async (message: string) => {
      messages.push(message);
      if (message.startsWith('Trust this project')) return trustGranted ? 'Trust and Continue' : undefined;
      return message.startsWith('This directory already exists') ? 'Use Directory' : undefined;
    },
    showErrorMessage: async (message: string) => { messages.push(message); return undefined; },
    showInformationMessage: async (_message: string, options?: unknown) =>
      typeof options === 'object' && options !== null && creationConfirmed ? 'Create Worktree' : undefined,
    withProgress: async (_options: unknown, run: (_progress: unknown, token: unknown) => Promise<unknown>) =>
      run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
  }
};

// Node's test runner does not provide the VS Code extension-host module.
const loader = require('node:module') as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, isMain) => name === 'vscode' ? fakeVscode : originalLoad(name, parent, isMain);
const { ProjectCommands } = require('../projectCommands') as typeof import('../projectCommands');
const { ProjectsView } = require('../projectsView') as typeof import('../projectsView');
loader._load = originalLoad;

function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function fixture(run: (project: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'switcher-command-'));
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const project = join(root, 'project');
    worktreesRoot = join(root, 'worktrees');
    await mkdir(project);
    await mkdir(worktreesRoot);
    await git(project, root, 'init', '-b', 'main', '--template=');
    await writeFile(join(project, 'file.txt'), 'original\n');
    await git(project, root, 'add', 'file.txt');
    await git(project, root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
    messages.length = 0;
    answers = [];
    trustGranted = true;
    creationConfirmed = true;
    beforeRemoteChoice = undefined;
    fakeVscode.workspace.isTrusted = true;
    await run(project, root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function commandsFor(project: string): InstanceType<typeof ProjectCommands> {
  const uri = pathToFileURL(project).href;
  const store = { getProjects: async () => [{ uri }] };
  const view = { refresh() {} };
  return new ProjectCommands(store as never, view as never, async () => { throw new Error('Unexpected registry access'); });
}

test('creates a new branch worktree and requests a new window', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (project, root) => {
    answers = ['feature/new', 'feature-new'];
    const commands = commandsFor(project);
    let opened: { path: string; choice: string | undefined } | undefined;
    commands.select = async (uri, choice) => { opened = { path: uri.fsPath, choice }; return 'opened'; };
    await commands.createWorktree();
    const destination = join(worktreesRoot, 'project', 'feature-new');
    assert.equal(await readFile(join(destination, 'file.txt'), 'utf8'), 'original\n');
    assert.equal((await git(destination, root, 'branch', '--show-current')).trim(), 'feature/new');
    assert.deepEqual(opened, { path: await realpath(destination), choice: 'new' });
    assert.ok(messages.some(message => message.startsWith('Trust this project')));
  });
});

test('denied project trust prevents worktree creation', { skip: process.platform === 'win32' }, async () => {
  await fixture(async project => {
    trustGranted = false;
    const commands = commandsFor(project);
    await commands.createWorktree();
    await assert.rejects(access(join(worktreesRoot, 'project')));
    assert.ok(messages.some(message => message.startsWith('Trust this project')));
  });
});

test('a restricted workspace prevents project Git mutations', async () => {
  await fixture(async project => {
    fakeVscode.workspace.isTrusted = false;
    const commands = commandsFor(project);
    await commands.createWorktree();
    await assert.rejects(access(join(worktreesRoot, 'project')));
    assert.ok(messages.some(message => message.includes('Trust this VS Code workspace')));
    assert.ok(!messages.some(message => message.startsWith('Trust this project')));
  });
});

test('a failed fetch offers local branches and creates the worktree', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (project, root) => {
    await git(project, root, 'remote', 'add', 'origin', join(root, 'missing-remote'));
    answers = ['feature/offline', 'feature-offline'];
    const commands = commandsFor(project);
    commands.select = async () => 'opened';
    await commands.createWorktree();
    const destination = join(worktreesRoot, 'project', 'feature-offline');
    assert.equal((await git(destination, root, 'branch', '--show-current')).trim(), 'feature/offline');
    assert.ok(messages.some(message => message.includes('Fetch failed')));
  });
});

test('a conflicting destination is preserved and the user can choose another name', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (project, root) => {
    const group = join(worktreesRoot, 'project');
    const existing = join(group, 'occupied');
    await mkdir(group);
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'do not overwrite');
    answers = ['feature/new', 'occupied', 'feature-new'];
    const commands = commandsFor(project);
    commands.select = async () => 'opened';
    await commands.createWorktree();
    assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'do not overwrite');
    assert.equal((await git(join(group, 'feature-new'), root, 'branch', '--show-current')).trim(), 'feature/new');
    assert.ok(messages.some(message => message.includes('destination already exists')));
  });
});

test('canceling the destination preview creates no project directory', { skip: process.platform === 'win32' }, async () => {
  await fixture(async project => {
    creationConfirmed = false;
    answers = ['feature/new', 'feature-new'];
    const commands = commandsFor(project);
    await commands.createWorktree();
    await assert.rejects(access(join(worktreesRoot, 'project')));
  });
});

test('a project replaced during remote selection is not fetched or used', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (project, root) => {
    await git(project, root, 'remote', 'add', 'fork', join(root, 'first-remote'));
    await git(project, root, 'remote', 'add', 'upstream', join(root, 'second-remote'));
    beforeRemoteChoice = async () => {
      await rename(project, join(root, 'original-project'));
      await mkdir(project);
      await git(project, root, 'init', '-b', 'main', '--template=');
    };
    await commandsFor(project).createWorktree();
    await assert.rejects(access(join(worktreesRoot, 'project')));
    assert.ok(messages.some(message => message.includes('project or workspace trust changed')));
    assert.ok(!messages.some(message => message.includes('Fetch failed')));
  });
});

test('an unreadable project list shows an error item instead of an empty list', async () => {
  messages.length = 0;
  let commands: InstanceType<typeof ProjectCommands>;
  const view = new ProjectsView(() => commands.entries(), async () => []);
  const store = { getProjects: async () => { throw new ProjectStoreError('read-failed', 'Cannot read projects.', undefined); } };
  commands = new ProjectCommands(store as never, view, async () => { throw new Error('Unexpected registry access'); });
  const rows = await view.getChildren();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contextValue, 'message');
  assert.ok(messages.some(message => message.includes('No reliable saved list is available')));
  assert.ok(!messages.some(message => message.includes('last confirmed list is empty')));
  view.dispose();
});
