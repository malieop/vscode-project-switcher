import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { listWorktrees } from '../gitDiscovery';

function git(cwd: string, args: readonly string[], home: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.HOME = home;
  env.XDG_CONFIG_HOME = home;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_TERMINAL_PROMPT = '0';
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, env, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function withEnv<T>(changes: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('discovers only Git-linked worktrees, including outside roots and stale entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-git-'));
  try {
    const project = join(root, 'project');
    const external = join(root, 'outside with spaces\nand newline');
    const detached = join(root, 'detached');
    const stale = join(root, 'stale');
    await mkdir(project);
    await git(project, ['init', '-b', 'main', '--template='], root);
    await git(project, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'], root);
    await git(project, ['branch', 'unrelated'], root);
    await git(project, ['worktree', 'add', '-b', 'feature/example', external], root);
    await git(project, ['worktree', 'lock', '--reason', 'maintenance\nreason', external], root);
    await git(project, ['worktree', 'add', '--detach', detached], root);
    await git(project, ['worktree', 'add', '--detach', stale], root);
    await rm(stale, { recursive: true });

    const head = (await git(project, ['rev-parse', 'HEAD'], root)).trim();
    const canonicalProject = await realpath(project);
    const canonicalExternal = await realpath(external);
    const canonicalDetached = await realpath(detached);
    const canonicalStale = join(await realpath(root), 'stale');
    const worktrees = await listWorktrees(project);
    assert.deepEqual([...worktrees].sort((a, b) => a.path.localeCompare(b.path)), [
      { path: canonicalProject, head, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: canonicalDetached, head, detached: true, bare: false, locked: false, prunable: false },
      { path: canonicalExternal, head, branch: 'feature/example', detached: false, bare: false, locked: true, prunable: false },
      { path: canonicalStale, head, detached: true, bare: false, locked: false, prunable: true }
    ].sort((a, b) => a.path.localeCompare(b.path)));
    assert.deepEqual(await listWorktrees(external), worktrees);
    assert.equal(worktrees.some(worktree => worktree.branch === 'unrelated'), false);

    const alias = join(root, 'alias');
    await symlink(project, alias, 'dir');
    assert.deepEqual(await listWorktrees(alias), worktrees);
    const alternateCase = join(root, 'PROJECT');
    if (await stat(alternateCase).catch(() => undefined)) {
      assert.deepEqual(await listWorktrees(alternateCase), worktrees);
    }

    const subdirectory = join(project, 'ordinary-folder');
    await mkdir(subdirectory);
    await assert.rejects(listWorktrees(subdirectory), /not a Git worktree root/);
    await withEnv({ GIT_DIR: join(root, 'not-a-repository'), GIT_WORK_TREE: root }, async () => {
      assert.deepEqual(await listWorktrees(project), worktrees);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('handles unborn and bare repositories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-git-empty-'));
  try {
    const unborn = join(root, 'unborn');
    const bare = join(root, 'bare.git');
    await mkdir(unborn);
    await git(unborn, ['init', '-b', 'main', '--template='], root);
    await git(root, ['init', '--bare', '-b', 'main', '--template=', bare], root);
    assert.deepEqual(await listWorktrees(unborn), [{
      path: await realpath(unborn), head: '0'.repeat(40), branch: 'main',
      detached: false, bare: false, locked: false, prunable: false
    }]);
    assert.deepEqual(await listWorktrees(bare), [{
      path: await realpath(bare), detached: false, bare: true, locked: false, prunable: false
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid paths, non-repositories, and Git execution failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-git-invalid-'));
  try {
    const file = join(root, 'file');
    await writeFile(file, 'not a directory');
    for (const path of ['relative', 'file:///tmp/project', `${root}\0bad`, file, join(root, 'missing'), root]) {
      await assert.rejects(listWorktrees(path), path);
    }
    await withEnv({ PATH: '' }, async () => {
      await assert.rejects(listWorktrees(root));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed, truncated, oversized and timed-out Git output', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'switcher-git-malformed-'));
  try {
    const bin = join(root, 'bin');
    const project = join(root, 'project');
    await mkdir(bin);
    await mkdir(project);
    const executable = join(bin, 'git');
    const head = 'a'.repeat(40);
    const prefix = `worktree ${project}\0HEAD ${head}\0branch refs/heads/main\0`;
    const malformed = [
      Buffer.alloc(0),
      Buffer.from(prefix),
      Buffer.from(`worktree relative\0HEAD ${head}\0branch refs/heads/main\0\0`),
      Buffer.from(`worktree ${project}\0branch refs/heads/main\0\0`),
      Buffer.from(`${prefix}detached\0\0`),
      Buffer.from(`${prefix}HEAD ${head}\0\0`),
      Buffer.from(`worktree ${project}\0HEAD ${head}\0branch refs/tags/v1\0\0`),
      Buffer.from(`${prefix}unknown\0\0`),
      Buffer.concat([Buffer.from(`worktree ${project}`), Buffer.from([0xff, 0, 0])])
    ];
    await withEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }, async () => {
      const valid = `worktree ${project}\0HEAD ${'b'.repeat(64)}\0branch refs/heads/foo/bar\0` +
        'locked reason\nwith newline\0prunable stale\nreason\0\0';
      await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(Buffer.from('${Buffer.from(valid).toString('base64')}', 'base64'));\n`, { mode: 0o755 });
      assert.deepEqual(await listWorktrees(project), [{ path: project, head: 'b'.repeat(64), branch: 'foo/bar',
        detached: false, bare: false, locked: true, prunable: true }]);

      for (const output of malformed) {
        await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(Buffer.from('${output.toString('base64')}', 'base64'));\n`, { mode: 0o755 });
        await assert.rejects(listWorktrees(project), /Invalid git worktree porcelain output/);
      }
      await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(9 * 1024 * 1024));\n`, { mode: 0o755 });
      await assert.rejects(listWorktrees(project), (error: unknown) =>
        error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      await writeFile(executable, `#!${process.execPath}\nprocess.exit(42);\n`, { mode: 0o755 });
      await assert.rejects(listWorktrees(project), (error: unknown) =>
        error instanceof Error && (error as Error & { code?: number }).code === 42);
      await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
      await assert.rejects(listWorktrees(project), (error: unknown) =>
        error instanceof Error && (error as Error & { killed?: boolean; signal?: string }).killed === true &&
        (error as Error & { signal?: string }).signal === 'SIGKILL');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
