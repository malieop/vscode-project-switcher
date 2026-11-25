import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { folderIdentity, localFolderPath, sameFolderIdentity } from './folderIdentity';
import {
  AddProjectResult, ProjectMemento, ProjectRecord, ProjectStoreError, ProjectStoreErrorCode,
  PROJECT_STORE_KEY, RemoveProjectResult
} from './projectStore';

interface SavedFolder { uri: string; aliases: string[] }
interface SharedData { version: 1; folders: SavedFolder[]; tombstones: string[] }

const MAX_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function uri(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_BYTES && localFolderPath(value) !== undefined;
}

function decodeShared(value: unknown): SharedData | undefined {
  if (!object(value) || !keys(value, ['version', 'folders', 'tombstones']) || value.version !== 1 ||
      !Array.isArray(value.folders) || !Array.isArray(value.tombstones) || !value.tombstones.every(uri)) return undefined;
  const folders: SavedFolder[] = [];
  for (const folder of value.folders) {
    if (!object(folder) || !keys(folder, ['uri', 'aliases']) || !uri(folder.uri) ||
        !Array.isArray(folder.aliases) || !folder.aliases.every(uri)) return undefined;
    folders.push({ uri: folder.uri, aliases: [...folder.aliases] });
  }
  return { version: 1, folders, tombstones: [...value.tombstones] };
}

function decodeLegacy(value: unknown): ProjectRecord[] | undefined {
  if (!object(value) || !keys(value, ['version', 'folders']) || value.version !== 1 || !Array.isArray(value.folders)) return undefined;
  const folders: ProjectRecord[] = [];
  let bytes = 0;
  for (const folder of value.folders) {
    if (!object(folder) || !keys(folder, ['uri']) || !uri(folder.uri)) return undefined;
    bytes += Buffer.byteLength(folder.uri, 'utf8') + 16;
    if (bytes > MAX_BYTES) return undefined;
    folders.push({ uri: folder.uri });
  }
  return folders;
}

function records(data: SharedData): ProjectRecord[] {
  return data.folders.map(folder => ({ uri: folder.uri }));
}

function copy(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return projects.map(project => ({ uri: project.uri }));
}

function errorCode(error: unknown, code: string): boolean {
  return object(error) && error.code === code;
}

// Lexical equality only: do not case-fold or guess whether absent paths alias.
function samePath(a: string, b: string): boolean {
  return localFolderPath(a) === localFolderPath(b);
}

type Comparison = 'same' | 'different' | 'uncertain';

async function compare(a: string, b: string): Promise<Comparison> {
  if (samePath(a, b)) return 'same';
  const [left, right] = await Promise.all([folderIdentity(a), folderIdentity(b)]);
  if (left.kind !== 'directory' || right.kind !== 'directory') return 'uncertain';
  return sameFolderIdentity(left.identity, right.identity) ? 'same' : 'different';
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One private store for participating local profiles. Only cooperative writers
 * are coordinated. A crashed writer leaves a lock requiring manual recovery;
 * an old extension version editing globalState is not coordinated. Legacy state
 * is never changed. The empty initialization marker detects a missing data
 * file, but deleting the whole storage directory (including the marker) cannot
 * be distinguished from first use; back up the entire private directory.
 * Version 1 tombstones record paths, not durable historical folder identities.
 * They are never cleared on an explicit add; an unrecorded legacy path cannot
 * be assumed unrelated just because a tombstoned path now points elsewhere.
 */
export class SharedProjectStore {
  private readonly root: string;
  private readonly file: string;
  private readonly lock: string;
  private readonly marker: string;
  private confirmed: ProjectRecord[] | undefined;
  private observedFile = false;
  private writeUncertain = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(storageDirectory: string, private readonly legacyState?: ProjectMemento) {
    this.root = path.join(storageDirectory, 'shared-projects-v1');
    this.file = path.join(this.root, 'projects.json');
    this.lock = path.join(this.root, 'write.lock');
    this.marker = path.join(this.root, 'initialized');
  }

  private error(code: ProjectStoreErrorCode, message: string, cause?: unknown): ProjectStoreError {
    return new ProjectStoreError(code, message, this.confirmed, cause);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async prepare(): Promise<void> {
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink() ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Invalid storage directory');
      await fs.chmod(this.root, 0o700);
    } catch (error) {
      throw this.error('read-failed', 'Unable to access the private project storage directory.', error);
    }
  }

  private async acquire(): Promise<{ dev: bigint; ino: bigint }> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await fs.mkdir(this.lock, { mode: 0o700 });
        // If inspection fails, leave the possibly-owned lock in place.
        const info = await fs.lstat(this.lock, { bigint: true });
        if (!info.isDirectory() || info.ino === 0n) throw new Error('Cannot identify the lock');
        return { dev: info.dev, ino: info.ino };
      } catch (error) {
        if (!errorCode(error, 'EEXIST')) throw this.error('write-failed', 'Cannot acquire the project store lock.', error);
        if (Date.now() >= deadline) throw this.error('write-failed', 'Project store lock is busy or abandoned; verify all writers have stopped before recovery.', error);
        await delay(LOCK_POLL_MS);
      }
    }
  }

  private async release(identity: { dev: bigint; ino: bigint }): Promise<void> {
    const info = await fs.lstat(this.lock, { bigint: true });
    if (!info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino) throw new Error('Lock ownership is uncertain');
    await fs.rmdir(this.lock);
  }

  private async markerExists(): Promise<boolean> {
    try {
      const info = await fs.lstat(this.marker);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Invalid initialization marker');
      return true;
    } catch (error) {
      if (errorCode(error, 'ENOENT')) return false;
      throw this.error('read-failed', 'Cannot verify the project store initialization marker.', error);
    }
  }

  private async createMarker(): Promise<void> {
    try {
      await fs.mkdir(this.marker, { mode: 0o700 });
      await fs.chmod(this.marker, 0o700);
      const dir = await fs.open(this.root, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      this.writeUncertain = true;
      throw this.error('write-failed', 'Unable to confirm project store initialization.', error);
    }
  }

  private async readShared(initialized: boolean): Promise<{ data: SharedData; exists: boolean }> {
    let handle: fs.FileHandle | undefined;
    try {
      try { handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if (errorCode(error, 'ENOENT')) {
          if (initialized || this.observedFile) throw this.error('read-failed', 'The previously initialized shared project file is missing; recovery is required.', error);
          return { data: { version: 1, folders: [], tombstones: [] }, exists: false };
        }
        throw error;
      }
      this.observedFile = true;
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o600) {
        throw this.error('corrupt-data', 'The shared project file is invalid or not private.');
      }
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > MAX_BYTES) throw this.error('corrupt-data', 'The shared project file is too large.');
      let parsed: unknown;
      try { parsed = JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown; }
      catch (error) { throw this.error('corrupt-data', 'The shared project file is corrupt.', error); }
      const data = decodeShared(parsed);
      if (!data) throw this.error('corrupt-data', 'The shared project file has an unsupported or invalid format.');
      return { data, exists: true };
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      throw this.error('read-failed', 'Unable to read the shared project file.', error);
    } finally {
      if (handle) {
        try { await handle.close(); }
        catch (error) { throw this.error('read-failed', 'Unable to close the shared project file.', error); }
      }
    }
  }

  private legacy(): ProjectRecord[] {
    if (!this.legacyState) return [];
    let value: unknown;
    try { value = this.legacyState.get<unknown>(PROJECT_STORE_KEY); }
    catch (error) { throw this.error('read-failed', 'Unable to read the profile-local projects.', error); }
    if (value === undefined) return [];
    const result = decodeLegacy(value);
    if (!result) throw this.error('corrupt-data', 'Profile-local projects have an unsupported or invalid format.');
    return result;
  }

  private async migrate(data: SharedData): Promise<boolean> {
    // Paths preserved separately while unavailable can later become provably
    // identical. Keep every observed spelling as an alias when merging.
    let changed = false;
    const paths = new Map<string, SavedFolder>();
    const identities = new Map<string, SavedFolder>();
    const distinct: SavedFolder[] = [];
    for (const folder of data.folders) {
      const local = localFolderPath(folder.uri)!;
      const identity = await folderIdentity(folder.uri);
      const key = identity.kind === 'directory' ? `${identity.identity.device}:${identity.identity.inode}` : undefined;
      const duplicate = paths.get(local) ?? (key === undefined ? undefined : identities.get(key));
      if (duplicate) {
        for (const alias of [folder.uri, ...folder.aliases]) {
          if (![duplicate.uri, ...duplicate.aliases].some(existing => samePath(existing, alias))) duplicate.aliases.push(alias);
        }
        changed = true;
      } else {
        distinct.push(folder);
        paths.set(local, folder);
        if (key !== undefined) identities.set(key, folder);
      }
    }
    data.folders = distinct;
    for (const project of this.legacy()) {
      // Recheck previously observed aliases: a symlink can be repointed.
      let recorded = false;
      for (const folder of data.folders) {
        if (samePath(folder.uri, project.uri)) { recorded = true; break; }
        const index = folder.aliases.findIndex(saved => samePath(saved, project.uri));
        if (index >= 0) {
          const relation = await compare(folder.uri, project.uri);
          if (relation === 'same') { recorded = true; break; }
          // Splitting an unidentifiable alias would let a concurrent removal
          // leave a previously represented path behind without the user's knowledge.
          if (relation === 'uncertain') throw this.error('identity-uncertain',
            `Cannot safely reconcile the previously recorded alias ${project.uri} with ${folder.uri}: their identity is uncertain.`);
          folder.aliases.splice(index, 1);
          changed = true;
        }
      }
      if (recorded) continue;
      // A tombstone refers to the path at removal time. Re-resolving it now
      // cannot prove what it pointed to then: links, directories and inodes can
      // all be replaced. Exact path retries remain removed; any other unseen
      // path could be an alias of the old target and requires an explicit add.
      if (data.tombstones.some(tombstone => samePath(project.uri, tombstone))) continue;
      if (data.tombstones.length) throw this.error('identity-uncertain',
        `Cannot safely migrate ${project.uri}: it may refer to a project removed as ${data.tombstones[0]}. Historical folder identity is unavailable; add this project explicitly if needed.`);
      let duplicate: SavedFolder | undefined;
      for (const folder of data.folders) {
        if (await compare(project.uri, folder.uri) === 'same') { duplicate = folder; break; }
      }
      if (duplicate) duplicate.aliases.push(project.uri);
      else data.folders.push({ uri: project.uri, aliases: [] });
      changed = true;
    }
    return changed;
  }

  private async write(data: SharedData): Promise<void> {
    const temporary = path.join(this.root, `projects.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    let created = false;
    try {
      const content = JSON.stringify(data);
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('Project store exceeds the size limit');
      handle = await fs.open(temporary, 'wx', 0o600);
      created = true;
      await handle.chmod(0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.file);
      created = false;
      const dir = await fs.open(this.root, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      this.observedFile = true;
    } catch (error) {
      this.writeUncertain = true;
      throw this.error('write-failed', 'Unable to save projects; the last confirmed list is retained.', error);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (created) await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async transact<T>(operation: (data: SharedData) => Promise<{ value: T; changed: boolean }>,
                            removeFallback?: string, addFallback?: string): Promise<T> {
    if (this.writeUncertain) throw this.error('write-failed', 'A previous save has an uncertain outcome; the last confirmed list is retained.');
    await this.prepare();
    const lock = await this.acquire();
    let result: T | undefined;
    let finalProjects: ProjectRecord[] | undefined;
    let failure: unknown;
    let failed = false;
    let attemptedWrite = false;
    try {
      const initialized = await this.markerExists();
      const loaded = await this.readShared(initialized);
      if (loaded.exists) this.confirmed = records(loaded.data);
      let data = loaded.data;
      // Migration can discover an unrelated ambiguous legacy path. A user can
      // still remove an exact, already-saved entry without importing that path:
      // preserve the legacy state and retry migration on a later operation.
      const beforeMigration = removeFallback === undefined && addFallback === undefined ? undefined : structuredClone(data);
      let migrated = false;
      let migrationError: ProjectStoreError | undefined;
      try { migrated = await this.migrate(data); }
      catch (error) {
        if (!(error instanceof ProjectStoreError) || error.code !== 'identity-uncertain' || beforeMigration === undefined ||
            (addFallback === undefined && !beforeMigration.folders.some(folder => folder.uri === removeFallback))) throw error;
        data = beforeMigration;
        migrationError = error;
      }
      if (migrated && beforeMigration !== undefined && removeFallback !== undefined &&
          beforeMigration.folders.some(folder => folder.uri === removeFallback)) {
        // Do not surface a newly encountered, possibly synonymous legacy path
        // in the same transaction that removes the entry it might represent.
        // Keep it in legacy state; the new tombstone will make the next import
        // fail closed until the ambiguity is resolved.
        for (const folder of data.folders) {
          if (!beforeMigration.folders.some(saved => samePath(saved.uri, folder.uri)) &&
              await compare(removeFallback, folder.uri) === 'uncertain') {
            data = beforeMigration;
            migrated = false;
            break;
          }
        }
      }
      const action = await operation(data);
      if (migrationError && !action.changed) throw migrationError;
      if (!loaded.exists || migrated || action.changed) {
        attemptedWrite = true;
        await this.write(data);
      }
      if (!initialized) {
        attemptedWrite = true;
        await this.createMarker();
      }
      result = action.value;
      finalProjects = records(data);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try { await this.release(lock); }
    catch (error) {
      if (attemptedWrite) this.writeUncertain = true;
      throw this.error('write-failed', 'Cannot safely release the project store lock; manual recovery may be required.', error);
    }
    if (failed) throw failure;
    this.confirmed = finalProjects;
    return result as T;
  }

  getProjects(): Promise<readonly ProjectRecord[]> {
    return this.enqueue(async () => {
      if (this.writeUncertain && this.confirmed !== undefined) return copy(this.confirmed);
      return this.transact(async data => ({ value: records(data), changed: false }));
    });
  }

  refresh(): Promise<readonly ProjectRecord[]> {
    return this.enqueue(() => this.transact(async data => ({ value: records(data), changed: false })));
  }

  add(projectUri: string): Promise<AddProjectResult> {
    return this.enqueue(() => this.transact(async data => {
      const target = await folderIdentity(projectUri);
      if (target.kind !== 'directory') throw this.error('invalid-folder', `Cannot identify the selected directory (${target.kind}).`, target);
      let uncertain = false;
      for (const folder of data.folders) {
        const existing = await folderIdentity(folder.uri);
        if (existing.kind !== 'directory') uncertain = true;
        else if (sameFolderIdentity(target.identity, existing.identity)) {
          return { value: { kind: 'duplicate', project: { uri: folder.uri }, projects: records(data) } as AddProjectResult, changed: false };
        }
      }
      if (uncertain) throw this.error('identity-uncertain', 'Cannot safely check for duplicates while a saved directory is unavailable.');
      // An explicit add permits this path, but must not erase a historical
      // removal: the path may now point to a different directory.
      data.folders.push({ uri: projectUri, aliases: [] });
      return { value: { kind: 'added', projects: records(data) } as AddProjectResult, changed: true };
    }, undefined, projectUri));
  }

  remove(projectUri: string): Promise<RemoveProjectResult> {
    return this.enqueue(() => this.transact(async data => {
      const index = data.folders.findIndex(folder => folder.uri === projectUri);
      if (index < 0) return { value: { kind: 'not-found', projects: records(data) } as RemoveProjectResult, changed: false };
      const same: string[] = [];
      const distinct: string[] = [];
      for (const alias of data.folders[index].aliases) {
        const relation = await compare(projectUri, alias);
        if (relation === 'uncertain') throw this.error('identity-uncertain',
          `Cannot safely remove ${projectUri}: the previously recorded alias ${alias} is unavailable or its identity is uncertain. Restore the alias and retry; no project files were removed.`);
        (relation === 'same' ? same : distinct).push(alias);
      }
      // An alias that has been retargeted to a confirmed different directory
      // remains saved, unless it could also be a previously removed project.
      for (const alias of distinct) {
        if (data.tombstones.length) {
          throw this.error('identity-uncertain', `Cannot safely preserve the changed alias ${alias}: it may refer to the project formerly removed as ${data.tombstones[0]}. Add it explicitly if needed.`);
        }
      }
      const [removed] = data.folders.splice(index, 1);
      for (const removedUri of [removed.uri, ...same]) {
        if (!data.tombstones.some(existing => samePath(existing, removedUri))) data.tombstones.push(removedUri);
      }
      for (const alias of distinct) {
        let duplicate: SavedFolder | undefined;
        for (const folder of data.folders) {
          if (await compare(alias, folder.uri) === 'same') { duplicate = folder; break; }
        }
        if (duplicate) {
          if (![duplicate.uri, ...duplicate.aliases].some(existing => samePath(existing, alias))) duplicate.aliases.push(alias);
        } else data.folders.push({ uri: alias, aliases: [] });
      }
      return { value: { kind: 'removed', projects: records(data) } as RemoveProjectResult, changed: true };
    }, projectUri));
  }
}
