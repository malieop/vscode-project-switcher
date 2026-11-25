import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { createBranchWorktree, fetchRemoteBranches, GitWorktreeError, listBranchRefs, listRemoteNames, ProjectIdentityError,
  suggestWorktreeDirectory, validateNewBranchName } from '../gitWorktreeCreate';

function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

interface Fixture { root: string; project: string; source: string; remote: string; }
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'worktree-create-'));
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const project = join(root, 'project');
    const source = join(root, 'source');
    const remote = join(root, 'remote.git');
    await mkdir(project);
    await mkdir(source);
    await git(root, root, 'init', '--bare', '-b', 'main', '--template=', remote);
    for (const dir of [project, source]) {
      await git(dir, root, 'init', '-b', 'main', '--template=');
      await git(dir, root, 'config', 'user.name', 'Test');
      await git(dir, root, 'config', 'user.email', 'test@example.invalid');
      await git(dir, root, 'config', 'commit.gpgsign', 'false');
    }
    await writeFile(join(source, 'content.txt'), 'remote contents\n');
    await git(source, root, 'add', 'content.txt');
    await git(source, root, 'commit', '-m', 'remote initial');
    await git(source, root, 'branch', 'feature/source');
    await git(source, root, 'tag', 'remote-tag');
    await git(source, root, 'remote', 'add', 'origin', remote);
    await git(source, root, 'push', 'origin', 'main', 'feature/source', 'remote-tag');
    await writeFile(join(project, 'local.txt'), 'local contents\n');
    await git(project, root, 'add', 'local.txt');
    await git(project, root, 'commit', '-m', 'local initial');
    await git(project, root, 'remote', 'add', 'origin', remote);
    await run({ root, project, source, remote });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('fetch explicitly updates only tracking heads, without pruning, tags, FETCH_HEAD, or configured extra mappings', async () => {
  await fixture(async ({ root, project }) => {
    assert.deepEqual(await listRemoteNames(project), ['origin']);
    const initial = (await git(project, root, 'rev-parse', 'HEAD')).trim();
    assert.deepEqual(await listBranchRefs(project, true), [{ ref: 'refs/heads/main', name: 'main', kind: 'local', oid: initial }]);
    await git(project, root, 'update-ref', 'refs/remotes/origin/stale', initial);
    await git(project, root, 'config', 'fetch.prune', 'true');
    await git(project, root, 'config', 'fetch.pruneTags', 'true');
    await git(project, root, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/heads/unwanted/*');
    await git(project, root, 'config', 'remote.origin.tagOpt', '--tags');
    await git(project, root, 'config', 'remote.origin.uploadpack', `touch ${join(root, 'uploadpack-ran')}`);
    const fetchHead = join(project, '.git', 'FETCH_HEAD');
    await writeFile(fetchHead, 'must remain unchanged\n');
    await fetchRemoteBranches(project, 'origin');
    await assert.rejects(access(join(root, 'uploadpack-ran')));
    assert.equal(await readFile(fetchHead, 'utf8'), 'must remain unchanged\n');
    const refs = await listBranchRefs(project, true);
    assert.deepEqual(refs.map(ref => ref.ref).sort(), [
      'refs/heads/main', 'refs/remotes/origin/feature/source', 'refs/remotes/origin/main', 'refs/remotes/origin/stale'
    ]);
    assert.deepEqual((await listBranchRefs(project)).map(ref => ref.ref), ['refs/heads/main']);
    assert.equal(await git(project, root, 'tag', '--list'), '');
    await git(project, root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    assert.equal((await listBranchRefs(project, true)).some(ref => ref.ref.endsWith('/HEAD')), false);
  });
});

test('fetch rejects unsafe/unconfigured names, does not force-update, and redacts failed remote output', async () => {
  await fixture(async ({ root, project }) => {
    for (const name of ['', '--all', 'missing', 'origin/other', 'origin\nother', 'origin;touch x', 'a..b']) {
      await assert.rejects(fetchRemoteBranches(project, name));
    }
    const localHead = (await git(project, root, 'rev-parse', 'HEAD')).trim();
    await git(project, root, 'update-ref', 'refs/remotes/origin/main', localHead);
    await assert.rejects(fetchRemoteBranches(project, 'origin'), (e: unknown) => e instanceof GitWorktreeError && e.operation === 'fetch');
    assert.equal((await git(project, root, 'rev-parse', 'refs/remotes/origin/main')).trim(), localHead);
    const missing = join(root, 'missing-secret-repository');
    await git(project, root, 'remote', 'add', 'offline', missing);
    await assert.rejects(fetchRemoteBranches(project, 'offline'), (e: unknown) =>
      e instanceof GitWorktreeError && e.operation === 'fetch' && !e.message.includes(missing) && !String(e).includes('secret'));
    await git(project, root, 'remote', 'add', 'unsafe', `ext::touch ${join(root, 'transport-ran')}`);
    await git(project, root, 'config', 'protocol.ext.allow', 'always');
    await assert.rejects(fetchRemoteBranches(project, 'unsafe'), (e: unknown) => e instanceof GitWorktreeError && e.operation === 'fetch');
    await assert.rejects(access(join(root, 'transport-ran')));
    assert.ok((await listBranchRefs(project)).some(ref => ref.ref === 'refs/heads/main'));
  });
});

test('remote verification distinguishes deleted branches from retained tracking refs', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project, remote }) => {
    const first = await fetchRemoteBranches(project, 'origin');
    assert.ok(first.some(head => head.ref === 'refs/heads/main'));
    await git(remote, root, 'update-ref', '-d', 'refs/heads/main');
    const second = await fetchRemoteBranches(project, 'origin');
    assert.ok(!second.some(head => head.ref === 'refs/heads/main'));
    assert.ok(second.some(head => head.ref === 'refs/heads/feature/source'));
    assert.ok((await listBranchRefs(project, true)).some(branch => branch.ref === 'refs/remotes/origin/main'));
  });
});

test('fetch cannot update local branches through a symbolic remote-tracking ref', async () => {
  await fixture(async ({ root, project, source }) => {
    await fetchRemoteBranches(project, 'origin');
    const old = (await git(project, root, 'rev-parse', 'refs/remotes/origin/main')).trim();
    await git(project, root, 'update-ref', 'refs/heads/victim', old);
    await git(project, root, 'symbolic-ref', 'refs/remotes/origin/evil', 'refs/heads/victim');
    await git(source, root, 'commit', '--allow-empty', '-m', 'new commit');
    await git(source, root, 'push', 'origin', 'main:refs/heads/evil');
    try { await fetchRemoteBranches(project, 'origin'); } catch { /* failing closed is acceptable */ }
    assert.equal((await git(project, root, 'rev-parse', 'refs/heads/victim')).trim(), old);
  });
});

test('creates only a new branch at a new destination, checked out from a selected full ref', async () => {
  await fixture(async ({ root, project, source }) => {
    await fetchRemoteBranches(project, 'origin');
    const destination = join(root, 'worktree with spaces');
    const path = await createBranchWorktree(project, 'topic/my-work', 'refs/remotes/origin/feature/source', destination);
    assert.equal(path, join(await realpath(root), 'worktree with spaces'));
    assert.equal(await readFile(join(path, 'content.txt'), 'utf8'), 'remote contents\n');
    assert.equal((await git(path, root, 'branch', '--show-current')).trim(), 'topic/my-work');
    assert.equal((await git(path, root, 'rev-parse', 'HEAD')).trim(), (await git(source, root, 'rev-parse', 'main')).trim());
    assert.equal(await git(path, root, 'status', '--porcelain'), '');
    await assert.rejects(createBranchWorktree(project, 'topic/my-work', 'refs/heads/main', join(root, 'other')), /already exists/);
    await assert.rejects(access(join(root, 'other')));
  });
});

test('rejects invalid branch and ref inputs, existing files, directories, and dangling symlinks', async () => {
  await fixture(async ({ root, project }) => {
    const target = join(root, 'candidate');
    await validateNewBranchName(project, 'new-branch');
    await assert.rejects(validateNewBranchName(project, 'main'), /already exists/);
    await git(project, root, 'symbolic-ref', 'refs/heads/symbolic', 'refs/heads/main');
    await assert.rejects(validateNewBranchName(project, 'symbolic'), /already exists/);
    for (const name of ['', '-option', 'bad..name', 'bad name', '@{-1}', 'name\0bad']) {
      await assert.rejects(createBranchWorktree(project, name, 'refs/heads/main', target));
      await assert.rejects(access(target));
    }
    await git(project, root, 'tag', 'test-tag');
    await git(project, root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main');
    for (const ref of ['main', 'HEAD', 'refs/tags/test-tag', 'refs/heads/main~1', 'refs/heads/missing', 'refs/remotes/origin/HEAD', 'refs/heads/main\0bad']) {
      await assert.rejects(createBranchWorktree(project, 'new-branch', ref, target));
      await assert.rejects(access(target));
    }
    const existing = join(root, 'existing');
    const file = join(root, 'existing-file');
    const link = join(root, 'dangling-link');
    await mkdir(existing);
    await writeFile(file, 'leave me alone');
    await symlink(join(root, 'not-there'), link);
    for (const path of [existing, file, link]) {
      await assert.rejects(createBranchWorktree(project, 'new-branch', 'refs/heads/main', path), /Destination already exists/);
    }
    assert.equal(await readFile(file, 'utf8'), 'leave me alone');
    assert.ok((await lstat(link)).isSymbolicLink());
    for (const path of ['relative', join(root, 'no-parent', 'child'), `${root}/x/../y`, `${root}/`, `${root}\0bad`]) {
      await assert.rejects(createBranchWorktree(project, 'new-branch', 'refs/heads/main', path));
    }
  });
});

test('arguments containing shell metacharacters are literal, and parent symlinks resolve safely', async () => {
  await fixture(async ({ root, project }) => {
    const alias = join(root, 'parent-alias');
    const actual = join(root, 'parent');
    await mkdir(actual);
    await symlink(actual, alias, 'dir');
    const path = await createBranchWorktree(project, 'literal;touch-pwned', 'refs/heads/main', join(alias, 'target;touch-pwned'));
    assert.equal(path, join(await realpath(actual), 'target;touch-pwned'));
    assert.equal((await git(path, root, 'branch', '--show-current')).trim(), 'literal;touch-pwned');
    await assert.rejects(access(join(project, 'touch-pwned')));
  });
});

test('leaves a registered partial worktree and branch in place on checkout failure', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    const wrapper = `#!${process.execPath}\nconst cp = require('node:child_process');\nif (process.argv.includes('checkout-index')) process.exit(1);\nconst result = cp.spawnSync('git', process.argv.slice(2), {stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(previousPath)}}});\nprocess.exit(result.status ?? 1);\n`;
    await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    const destination = join(root, 'partial');
    try {
      await assert.rejects(createBranchWorktree(project, 'partial-branch', 'refs/heads/main', destination),
        (e: unknown) => e instanceof GitWorktreeError && e.operation === 'checkout');
    } finally { process.env.PATH = previousPath; }
    assert.ok((await lstat(destination)).isDirectory());
    assert.equal((await git(destination, root, 'branch', '--show-current')).trim(), 'partial-branch');
    assert.ok((await git(project, root, 'worktree', 'list', '--porcelain')).includes('partial-branch'));
  });
});

test('checkout does not overwrite a file created after reservation', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    const wrapper = `#!${process.execPath}\nconst cp = require('node:child_process');\nconst fs = require('node:fs');\nif (process.argv.includes('checkout-index')) fs.writeFileSync('local.txt', 'concurrent file');\nconst result = cp.spawnSync('git', process.argv.slice(2), {stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(previousPath)}}});\nprocess.exit(result.status ?? 1);\n`;
    await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    const destination = join(root, 'collision');
    try {
      await assert.rejects(createBranchWorktree(project, 'collision-branch', 'refs/heads/main', destination),
        (e: unknown) => e instanceof GitWorktreeError && e.operation === 'checkout');
    } finally { process.env.PATH = previousPath; }
    assert.equal(await readFile(join(destination, 'local.txt'), 'utf8'), 'concurrent file');
    assert.equal((await git(destination, root, 'branch', '--show-current')).trim(), 'collision-branch');
  });
});

test('checkout fails instead of falling back to a parent repository when its .git disappears', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    const wrapper = `#!${process.execPath}\nconst cp = require('node:child_process');\nconst fs = require('node:fs');\nif (process.argv.includes('checkout-index')) fs.renameSync('.git', '.git-moved');\nconst result = cp.spawnSync('git', process.argv.slice(2), {stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(previousPath)}}});\nprocess.exit(result.status ?? 1);\n`;
    await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    const destination = join(project, 'nested-worktree');
    try {
      await assert.rejects(createBranchWorktree(project, 'nested-branch', 'refs/heads/main', destination),
        (e: unknown) => e instanceof GitWorktreeError && e.operation === 'checkout');
    } finally { process.env.PATH = previousPath; }
    assert.equal(await readFile(join(project, 'local.txt'), 'utf8'), 'local contents\n');
    await assert.rejects(access(join(destination, 'local.txt')));
  });
});

test('caps Git output and does not include it in errors', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(5 * 1024 * 1024, 'x'));\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    try {
      await assert.rejects(listRemoteNames(project), (e: unknown) =>
        e instanceof GitWorktreeError && e.reason === 'output-limit' && e.message.length < 100);
    } finally { process.env.PATH = previousPath; }
  });
});

test('bounds Git runtime and terminates a process group with inherited pipes', { skip: process.platform === 'win32', timeout: 25_000 }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    const wrapper = `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});\nsetInterval(() => {}, 1000);\n`;
    await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    const start = Date.now();
    try {
      await assert.rejects(listRemoteNames(project), (e: unknown) => e instanceof GitWorktreeError && e.reason === 'timeout');
      assert.ok(Date.now() - start < 20_000);
    } finally { process.env.PATH = previousPath; }
  });
});

test('cancellation stops a pending fetch without creating a worktree', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const previousPath = process.env.PATH ?? '';
    const wrapper = `#!${process.execPath}\nconst cp = require('node:child_process');\nif (process.argv.includes('fetch')) setInterval(() => {}, 1000);\nelse { const result = cp.spawnSync('git', process.argv.slice(2), {stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(previousPath)}}}); process.exit(result.status ?? 1); }\n`;
    await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      await assert.rejects(fetchRemoteBranches(project, 'origin', controller.signal),
        (error: unknown) => error instanceof GitWorktreeError && error.reason === 'cancelled');
      assert.equal((await git(project, root, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)?.length, 1);
    } finally { clearTimeout(timer); process.env.PATH = previousPath; }
  });
});

test('cancelling creation before dispatch leaves the destination absent', async () => {
  await fixture(async ({ root, project }) => {
    const controller = new AbortController();
    controller.abort();
    const destination = join(root, 'cancelled');
    await assert.rejects(createBranchWorktree(project, 'cancelled', 'refs/heads/main', destination, controller.signal),
      (error: unknown) => error instanceof GitWorktreeError && error.reason === 'cancelled');
    await assert.rejects(access(destination));
  });
});

test('rejects a changed destination parent before reserving a worktree', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    const destination = join(root, 'changed-parent');
    await assert.rejects(createBranchWorktree(project, 'new-branch', 'refs/heads/main', destination, undefined, '0:0'), /parent changed/);
    await assert.rejects(access(destination));
  });
});

test('rejects an untrusted replacement before running project Git operations', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ root, project }) => {
    await assert.rejects(listRemoteNames(project, undefined, '0:0'), ProjectIdentityError);
    await assert.rejects(fetchRemoteBranches(project, 'origin', undefined, '0:0'), ProjectIdentityError);
    await assert.rejects(listBranchRefs(project, true, undefined, '0:0'), ProjectIdentityError);
    await assert.rejects(validateNewBranchName(project, 'new-branch', '0:0'), ProjectIdentityError);
    await assert.rejects(createBranchWorktree(project, 'new-branch', 'refs/heads/main', join(root, 'untrusted'),
      undefined, undefined, '0:0'), ProjectIdentityError);
    await assert.rejects(access(join(root, 'untrusted')));
  });
});

test('ignores injected Git repository and command-line configuration environment', async () => {
  await fixture(async ({ root, project }) => {
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { GIT_DIR: join(root, 'missing'), GIT_WORK_TREE: root, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: join(root, 'missing') });
    try {
      assert.deepEqual(await listRemoteNames(project), ['origin']);
      await fetchRemoteBranches(project, 'origin');
      assert.ok((await listBranchRefs(project, true)).some(branch => branch.ref === 'refs/remotes/origin/main'));
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  });
});

test('suggested directory names are bounded and portable components', () => {
  for (const [name, expected] of [['feature/a b', 'feature-a-b'], ['../../', 'worktree-branch'], ['CON', 'worktree-CON'], ['', 'worktree-branch']]) {
    assert.equal(suggestWorktreeDirectory(name), expected);
  }
  assert.ok(suggestWorktreeDirectory('a'.repeat(500)).length <= 80);
  assert.match(suggestWorktreeDirectory('$(touch bad)\\evil'), /^[A-Za-z0-9_-]+$/);
});
