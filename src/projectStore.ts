import { folderIdentity, localFolderPath, sameFolderIdentity } from './folderIdentity';

/** Pass ExtensionContext.globalState; this store never enables Settings Sync. */
export interface ProjectMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface ProjectRecord {
  readonly uri: string;
}

export const PROJECT_STORE_KEY = 'projectSwitcher.projects';

export type ProjectStoreErrorCode =
  | 'read-failed' | 'corrupt-data' | 'write-failed'
  | 'invalid-folder' | 'identity-uncertain';

/** knownProjects is undefined when no list has ever been confirmed. */
export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;
  readonly knownProjects: readonly ProjectRecord[] | undefined;
  readonly originalError: unknown;

  constructor(code: ProjectStoreErrorCode, message: string,
              knownProjects: readonly ProjectRecord[] | undefined, originalError?: unknown) {
    super(message);
    this.name = 'ProjectStoreError';
    this.code = code;
    this.knownProjects = knownProjects === undefined ? undefined : copy(knownProjects);
    this.originalError = originalError;
  }
}

export type AddProjectResult =
  | { readonly kind: 'added'; readonly projects: readonly ProjectRecord[] }
  | { readonly kind: 'duplicate'; readonly project: ProjectRecord; readonly projects: readonly ProjectRecord[] };

export type RemoveProjectResult =
  | { readonly kind: 'removed'; readonly projects: readonly ProjectRecord[] }
  | { readonly kind: 'not-found'; readonly projects: readonly ProjectRecord[] };

function copy(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return projects.map(({ uri }) => ({ uri }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function decode(value: unknown): ProjectRecord[] | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, ['version', 'folders']) ||
      value.version !== 1 || !Array.isArray(value.folders)) return undefined;
  const projects: ProjectRecord[] = [];
  for (const folder of value.folders) {
    if (!isObject(folder) || !hasOnlyKeys(folder, ['uri']) ||
        typeof folder.uri !== 'string' || localFolderPath(folder.uri) === undefined) return undefined;
    projects.push({ uri: folder.uri });
  }
  return projects;
}

/** Serializes operations within one instance; edits across windows are unsupported. */
export class ProjectStore {
  private confirmed: ProjectRecord[] | undefined;
  private readBlocked = false;
  private writeUncertain = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly state: ProjectMemento;
  private readonly key: string;

  constructor(state: ProjectMemento, key = PROJECT_STORE_KEY) {
    this.state = state;
    this.key = key;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private error(code: ProjectStoreErrorCode, message: string, originalError?: unknown): ProjectStoreError {
    return new ProjectStoreError(code, message, this.confirmed, originalError);
  }

  private read(): ProjectRecord[] {
    let value: unknown;
    try {
      value = this.state.get<unknown>(this.key);
    } catch (error: unknown) {
      this.readBlocked = true;
      throw this.error('read-failed', 'Unable to read saved projects.', error);
    }
    const projects = value === undefined ? [] : decode(value);
    if (projects === undefined) {
      this.readBlocked = true;
      throw this.error('corrupt-data', 'Saved projects have an unsupported or invalid format.');
    }
    this.confirmed = copy(projects);
    this.readBlocked = false;
    return copy(projects);
  }

  private current(): ProjectRecord[] {
    return this.confirmed === undefined || this.readBlocked ? this.read() : copy(this.confirmed);
  }

  private async write(projects: readonly ProjectRecord[]): Promise<ProjectRecord[]> {
    if (this.writeUncertain) {
      throw this.error('write-failed', 'A previous save has an uncertain outcome; the last confirmed list is retained.');
    }
    try {
      await this.state.update(this.key, { version: 1, folders: copy(projects) });
    } catch (error: unknown) {
      // A rejected update need not mean the underlying memento was unchanged.
      // Do not promote a subsequent read or overwrite that ambiguous state.
      this.writeUncertain = true;
      throw this.error('write-failed', 'Unable to save projects; the last confirmed list is unchanged.', error);
    }
    this.confirmed = copy(projects);
    return copy(projects);
  }

  /** Return the last confirmed list, loading it if necessary. */
  getProjects(): Promise<readonly ProjectRecord[]> {
    return this.enqueue(async () => this.current());
  }

  /** Reload unless a rejected write made the memento's state uncertain. */
  refresh(): Promise<readonly ProjectRecord[]> {
    return this.enqueue(async () => {
      if (this.writeUncertain) {
        throw this.error('write-failed', 'Cannot refresh after an uncertain save; the last confirmed list is retained.');
      }
      return this.read();
    });
  }

  /** Save a local existing directory, or return an existing record with the same identity. */
  add(uri: string): Promise<AddProjectResult> {
    return this.enqueue(async () => {
      const projects = this.current();
      const target = await folderIdentity(uri);
      if (target.kind !== 'directory') {
        throw this.error('invalid-folder', `Cannot identify the selected directory (${target.kind}).`, target);
      }
      let uncertain = false;
      for (const project of projects) {
        const existing = await folderIdentity(project.uri);
        if (existing.kind !== 'directory') {
          uncertain = true;
        } else if (sameFolderIdentity(target.identity, existing.identity)) {
          return { kind: 'duplicate', project: { ...project }, projects: copy(projects) };
        }
      }
      if (uncertain) {
        throw this.error('identity-uncertain', 'Cannot safely check for duplicates while a saved directory is unavailable.');
      }
      return { kind: 'added', projects: await this.write([...projects, { uri }]) };
    });
  }

  /** Remove the exact saved URI, affecting metadata only, even when the folder is unavailable. */
  remove(uri: string): Promise<RemoveProjectResult> {
    return this.enqueue(async () => {
      const projects = this.current();
      const index = projects.findIndex(project => project.uri === uri);
      if (index < 0) return { kind: 'not-found', projects };
      projects.splice(index, 1);
      return { kind: 'removed', projects: await this.write(projects) };
    });
  }
}
