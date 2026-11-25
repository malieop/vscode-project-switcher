import { strict as assert } from 'node:assert';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectStoreError } from '../projectStore';

interface FakeUri { readonly scheme: string; readonly fsPath: string; toString(): string }
function fileUri(value: string): FakeUri {
  return { scheme: 'file', fsPath: value, toString: () => pathToFileURL(value).href };
}

let configuredRoot: string | undefined;
let answers: (string | undefined)[] = [];
let gitAnswer: string | undefined;
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
    getConfiguration: (section: string) => ({
      get: (key: string) => section === 'projectSwitcher' && key === 'projectsDirectory' ? configuredRoot : undefined
    })
  },
  window: {
    showQuickPick: async (items: unknown[]) => items[0],
    showInputBox: async () => answers.shift(),
    showWarningMessage: async (message: string) => { messages.push(message); return undefined; },
    showErrorMessage: async (message: string) => { messages.push(message); return undefined; },
    showInformationMessage: async (message: string) => {
      messages.push(message);
      return message === 'Initialize a Git repository?' ? gitAnswer : undefined;
    },
    withProgress: async (_options: unknown, run: (_progress: unknown, token: unknown) => Promise<unknown>) =>
      run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
  }
};

// Node's test runner does not provide the VS Code extension-host module.
const loader = require('node:module') as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, isMain) => name === 'vscode' ? fakeVscode : originalLoad(name, parent, isMain);
const { ProjectCommands } = require('../projectCommands') as typeof import('../projectCommands');
loader._load = originalLoad;

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'switcher-new-'));
  try {
    configuredRoot = root;
    answers = [];
    gitAnswer = undefined;
    messages.length = 0;
    fakeVscode.workspace.isTrusted = true;
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function storeStub(failWith?: ProjectStoreError) {
  const added: string[] = [];
  return {
    added,
    getProjects: async () => [] as { uri: string }[],
    refresh: async () => [] as { uri: string }[],
    add: async (uri: string) => {
      if (failWith) throw failWith;
      added.push(uri);
      return { kind: 'added', projects: [{ uri }] };
    },
    remove: async () => { throw new Error('Unexpected remove'); }
  };
}

const noRegistry = async (): Promise<never> => { throw new Error('Unexpected registry access'); };

function commandsFor(store: ReturnType<typeof storeStub>) {
  const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
  const opened: { path: string; choice?: string }[] = [];
  commands.select = async (uri, choice) => { opened.push({ path: uri.fsPath, choice }); return 'opened'; };
  return { commands, opened };
}

test('a valid name creates the folder, saves it, and runs the open flow', async () => {
  await fixture(async root => {
    answers = ['my-project'];
    const store = storeStub();
    const { commands, opened } = commandsFor(store);
    await commands.newProject();
    const destination = join(root, 'my-project');
    await access(destination);
    await assert.rejects(access(join(destination, '.git')), 'no Git repository when the prompt is canceled');
    assert.deepEqual(store.added, [pathToFileURL(destination).href]);
    assert.deepEqual(opened, [{ path: destination, choice: undefined }], 'the standard open flow runs without a preset choice');
    assert.ok(messages.includes('Initialize a Git repository?'));
  });
});

test('answering "No" at the Git prompt saves a plain project', async () => {
  await fixture(async root => {
    answers = ['plain'];
    gitAnswer = 'No';
    const store = storeStub();
    const { commands, opened } = commandsFor(store);
    await commands.newProject();
    await assert.rejects(access(join(root, 'plain', '.git')));
    assert.deepEqual(store.added, [pathToFileURL(join(root, 'plain')).href]);
    assert.equal(opened.length, 1);
  });
});

test('answering "Yes" at the Git prompt initializes a repository', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    answers = ['repo'];
    gitAnswer = 'Yes';
    const store = storeStub();
    const { commands, opened } = commandsFor(store);
    await commands.newProject();
    const destination = join(root, 'repo');
    await access(join(destination, '.git', 'HEAD'));
    assert.deepEqual(store.added, [pathToFileURL(destination).href]);
    assert.equal(opened.length, 1);
    assert.ok(!messages.some(message => message.includes('Git initialization failed')));
  });
});

test('a failed Git init keeps the folder, reports the stage, and saves the project as plain', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    answers = ['unlucky'];
    gitAnswer = 'Yes';
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    const store = storeStub();
    const { commands, opened } = commandsFor(store);
    try {
      await commands.newProject();
    } finally {
      process.env.PATH = previousPath;
    }
    const destination = join(root, 'unlucky');
    await access(destination);
    await assert.rejects(access(join(destination, '.git')));
    assert.ok(messages.some(message => message.includes('Git initialization failed')),
      `expected a Git-stage failure report, got: ${messages.join(' | ')}`);
    assert.deepEqual(store.added, [pathToFileURL(destination).href]);
    assert.equal(opened.length, 1, 'the flow continues to the open stage as a plain project');
  });
});

test('an invalid name is rejected with guidance and nothing is created for it', async () => {
  await fixture(async root => {
    answers = ['bad/name', 'good'];
    const store = storeStub();
    const { commands } = commandsFor(store);
    await commands.newProject();
    assert.ok(messages.some(message => message.includes('safe single directory name')),
      `expected naming guidance, got: ${messages.join(' | ')}`);
    await assert.rejects(access(join(root, 'bad')));
    await access(join(root, 'good'));
    assert.deepEqual(store.added, [pathToFileURL(join(root, 'good')).href]);
  });
});

test('an existing name is left untouched and another name is requested', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'taken'), 'do not touch');
    answers = ['taken', 'free'];
    const store = storeStub();
    const { commands } = commandsFor(store);
    await commands.newProject();
    assert.equal(await readFile(join(root, 'taken'), 'utf8'), 'do not touch');
    assert.ok(messages.some(message => message.includes('already exists')),
      `expected a collision warning, got: ${messages.join(' | ')}`);
    await access(join(root, 'free'));
    assert.deepEqual(store.added, [pathToFileURL(join(root, 'free')).href]);
  });
});

test('canceling the name prompt creates and saves nothing', async () => {
  await fixture(async root => {
    answers = [undefined];
    const store = storeStub();
    const { commands, opened } = commandsFor(store);
    await commands.newProject();
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(store.added, []);
    assert.deepEqual(opened, []);
    assert.deepEqual(messages, []);
  });
});

test('an unset or non-absolute root is rejected naming the setting', async () => {
  await fixture(async root => {
    for (const value of ['', 'relative/path']) {
      configuredRoot = value;
      answers = ['name'];
      const store = storeStub();
      const { commands, opened } = commandsFor(store);
      await commands.newProject();
      assert.ok(messages.some(message => message.includes('projectSwitcher.projectsDirectory')),
        `expected the setting name for root ${JSON.stringify(value)}, got: ${messages.join(' | ')}`);
      assert.deepEqual(store.added, []);
      assert.deepEqual(opened, []);
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test('a missing or non-directory root is rejected naming the setting', async () => {
  await fixture(async root => {
    const fileRoot = join(root, 'a-file');
    await writeFile(fileRoot, 'not a directory');
    for (const value of [join(root, 'missing'), fileRoot]) {
      configuredRoot = value;
      answers = ['name'];
      const store = storeStub();
      const { commands } = commandsFor(store);
      await commands.newProject();
      assert.ok(messages.some(message => message.includes('projectSwitcher.projectsDirectory')),
        `expected the setting name for root ${value}, got: ${messages.join(' | ')}`);
      assert.deepEqual(store.added, []);
    }
    await assert.rejects(access(join(root, 'missing')));
    assert.deepEqual(await readdir(root), ['a-file'], 'nothing was created');
  });
});

test('an untrusted workspace blocks creation with the trust explanation', async () => {
  await fixture(async root => {
    fakeVscode.workspace.isTrusted = false;
    answers = ['name'];
    const store = storeStub();
    const { commands } = commandsFor(store);
    await commands.newProject();
    assert.ok(messages.some(message => message.includes('Trust this VS Code workspace')));
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(store.added, []);
  });
});

test('a store failure shows the known paths and keeps the created folder', async () => {
  await fixture(async root => {
    answers = ['kept'];
    const failure = new ProjectStoreError('write-failed', 'Unable to save projects; the last confirmed list is unchanged.',
      [{ uri: pathToFileURL('/known/path').href }]);
    const store = storeStub(failure);
    const { commands, opened } = commandsFor(store);
    await commands.newProject();
    const warning = messages.find(message => message.includes('Unable to save projects'));
    assert.ok(warning, `expected the B-08 warning, got: ${messages.join(' | ')}`);
    assert.ok(warning.includes('/known/path'), 'the warning lists the known project paths');
    await access(join(root, 'kept'));
    assert.deepEqual(opened, [], 'the unsaved project is not opened');
  });
});

test('canceling the window choice after saving leaves the entry in the list', async () => {
  await fixture(async root => {
    answers = ['saved'];
    const store = storeStub();
    const commands = new ProjectCommands(store as never, { refresh() {} } as never, noRegistry as never);
    commands.select = async () => 'cancelled';
    await commands.newProject();
    assert.deepEqual(store.added, [pathToFileURL(join(root, 'saved')).href]);
    await access(join(root, 'saved'));
    assert.ok(!messages.some(message => !message.includes('Initialize a Git repository')),
      `no failure is reported for a canceled window choice, got: ${messages.join(' | ')}`);
  });
});
