import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface WindowFolder {
  uri: string;
  identity: string;
}

export interface WindowRecord {
  version: 1;
  id: string;
  pid: number;
  updatedAt: number;
  folders: WindowFolder[];
  /** Last time this window gained focus. Optional: older extension versions omit it. */
  lastFocusedAt?: number;
}

interface FocusRequest {
  version: 2;
  id: string;
  sender: string;
  target: string;
  identity: string;
  expiresAt: number;
}

interface FocusReply {
  version: 2;
  id: string;
  sender: string;
  target: string;
  ok: boolean;
}

/** A fixed close action; never a command id or payload. */
interface CloseRequest {
  version: 3;
  id: string;
  sender: string;
  target: string;
  expiresAt: number;
}

export type CloseOutcome = 'closed' | 'still-open';
export type CloseFailure = 'unavailable' | 'no-response' | 'invalid-response';

export class CloseError extends Error {
  constructor(readonly reason: CloseFailure, message: string) {
    super(message);
    this.name = 'CloseError';
  }
}

/** Test seam for the real-time waits in close(); production uses the defaults. */
export interface CloseTiming {
  replyMs?: number;
  goneMs?: number;
  replyPollMs?: number;
  gonePollMs?: number;
}

interface OpenClaim {
  version: 1;
  id: string;
  identity: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 64 * 1024;
export const STALE_AFTER_MS = 15_000;
const POLL_MS = 250;
const HEARTBEAT_MS = 3_000;
/** Abandoned open claims expire: window boot plus registration takes seconds, never minutes. */
const CLAIM_TTL_MS = 5 * 60_000;
/** Claim guards are held for single file operations; older means the holder died. */
const GUARD_TTL_MS = 60_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is WindowRecord {
  return isObject(value) && value.version === 1 && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    && Array.isArray(value.folders) && value.folders.length <= 100
    && value.folders.every(folder => isObject(folder) && typeof folder.uri === 'string'
      && folder.uri.length > 0 && typeof folder.identity === 'string' && folder.identity.length > 0);
}

function isRequest(value: unknown): value is FocusRequest {
  return isObject(value) && value.version === 2 && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.sender === 'string' && UUID.test(value.sender)
    && typeof value.target === 'string' && UUID.test(value.target)
    && typeof value.identity === 'string' && value.identity.length > 0 && value.identity.length <= 512
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt);
}

function isReply(value: unknown): value is FocusReply {
  return isObject(value) && value.version === 2 && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.sender === 'string' && UUID.test(value.sender)
    && typeof value.target === 'string' && UUID.test(value.target) && typeof value.ok === 'boolean';
}

function isCloseRequest(value: unknown): value is CloseRequest {
  return isObject(value) && value.version === 3 && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.sender === 'string' && UUID.test(value.sender)
    && typeof value.target === 'string' && UUID.test(value.target)
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt);
}

function isClaim(value: unknown): value is OpenClaim {
  return isObject(value) && value.version === 1 && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.identity === 'string' && value.identity.length > 0;
}

function missing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT';
}

function exists(error: unknown): boolean {
  return isObject(error) && error.code === 'EEXIST';
}

/** Fail closed: only ESRCH proves the process is gone. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(isObject(error) && error.code === 'ESRCH'); }
}

async function readJson(file: string): Promise<unknown> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid registry file');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Local, profile-independent live-window metadata. Saved projects are stored elsewhere. */
export class WindowRegistry {
  readonly sessionId = randomUUID();
  readonly root: string;
  private readonly records: string;
  private readonly inboxes: string;
  private readonly replies: string;
  private readonly claims: string;
  private folders: WindowFolder[] = [];
  private lastFocusedAt?: number;
  private heartbeat?: NodeJS.Timeout;
  private poller?: NodeJS.Timeout;
  private runningRequests = false;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  private healthError: Error | undefined;

  constructor(storagePath: string, private readonly focusSelf: (identity: string) => Promise<void>,
              private readonly closeSelf: () => Promise<void> = async () => {
                throw new Error('Window closing is not wired in this instance.');
              }) {
    this.root = path.join(storagePath, 'window-registry-v1');
    this.records = path.join(this.root, 'sessions');
    this.inboxes = path.join(this.root, 'inboxes');
    this.replies = path.join(this.root, 'replies');
    this.claims = path.join(this.root, 'claims');
  }

  async start(folders: WindowFolder[]): Promise<void> {
    for (const dir of [this.root, this.records, this.inboxes, this.replies, this.claims, this.inbox(this.sessionId)]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await this.sweepStaleState();
    await this.setFolders(folders);
    this.heartbeat = setInterval(() => {
      void this.publish().catch(error => { this.healthError = asError(error); });
    }, HEARTBEAT_MS);
    this.poller = setInterval(() => {
      void this.processRequests().catch(error => { this.healthError = asError(error); });
    }, POLL_MS);
    this.heartbeat.unref();
    this.poller.unref();
  }

  async setFolders(folders: WindowFolder[]): Promise<void> {
    this.folders = folders.map(folder => ({ ...folder }));
    await this.publish();
  }

  /** Record a focus gain; the next heartbeat publishes it. */
  noteFocused(at: number): void {
    this.lastFocusedAt = at;
  }

  private publish(): Promise<void> {
    const operation = this.writes.catch(() => undefined).then(async () => {
      if (this.closed) return;
      const record: WindowRecord = { version: 1, id: this.sessionId, pid: process.pid, updatedAt: Date.now(), folders: this.folders,
        ...(this.lastFocusedAt === undefined ? {} : { lastFocusedAt: this.lastFocusedAt }) };
      await writeAtomic(path.join(this.records, `${this.sessionId}.json`), record);
      this.healthError = undefined;
      for (const folder of record.folders) await this.releaseForRegisteredFolder(folder.identity);
    });
    this.writes = operation;
    return operation;
  }

  /** Remove abandoned state left by dead processes before joining the registry. */
  private async sweepStaleState(): Promise<void> {
    for (const name of await fs.readdir(this.records)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (id === this.sessionId) continue;
      const file = path.join(this.records, name);
      let value: unknown;
      try { value = await readJson(file); }
      catch (error) { if (!missing(error)) await fs.rm(file, { force: true }); continue; }
      if (!isRecord(value) || value.id !== id
        || (Date.now() - value.updatedAt > STALE_AFTER_MS && !pidAlive(value.pid))) {
        await fs.rm(file, { force: true });
      }
    }
    for (const name of await fs.readdir(this.claims)) {
      const file = path.join(this.claims, name);
      try {
        const ttl = name.endsWith('.guard') ? GUARD_TTL_MS : name.endsWith('.json') ? CLAIM_TTL_MS : 0;
        if (Date.now() - (await fs.stat(file)).mtimeMs > ttl) await fs.rm(file, { recursive: true, force: true });
      } catch (error) { if (!missing(error)) throw error; }
    }
  }

  async list(): Promise<WindowRecord[]> {
    if (this.healthError) throw new Error(`Window registry unavailable: ${this.healthError.message}`);
    const result: WindowRecord[] = [];
    for (const name of await fs.readdir(this.records)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!UUID.test(id)) throw new Error('Invalid window registry record name');
      let value: unknown;
      try { value = await readJson(path.join(this.records, name)); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (!isRecord(value) || value.id !== id) throw new Error('Invalid window registry record');
      if (value.updatedAt > Date.now() + STALE_AFTER_MS) throw new Error('Invalid window registry timestamp');
      result.push(value);
    }
    return result;
  }

  async find(identity: string): Promise<WindowRecord | undefined> {
    const matching = (await this.list()).filter(record => record.folders.some(folder => folder.identity === identity));
    const live = matching.filter(record => Date.now() - record.updatedAt <= STALE_AFTER_MS);
    if (live.length) return live.find(record => record.id === this.sessionId) ?? live[0];
    let unverifiable = false;
    for (const record of matching) {
      // A dead process cannot hold a window open: its record is a leftover. A live pid with a
      // stale heartbeat means a crashed extension host may have left its VS Code window open.
      if (pidAlive(record.pid)) unverifiable = true;
      else await fs.rm(path.join(this.records, `${record.id}.json`), { force: true });
    }
    // Do not silently duplicate a window whose extension host crashed but may still be open.
    if (unverifiable) throw new Error('The previous project window could not be verified');
    return undefined;
  }

  async focus(target: WindowRecord, identity: string): Promise<void> {
    if (!target.folders.some(folder => folder.identity === identity)) throw new Error('The selected window no longer has the project.');
    if (target.id === this.sessionId) { await this.focusSelf(identity); return; }
    if (Date.now() - target.updatedAt > STALE_AFTER_MS) throw new Error('The project window is no longer available');
    const request: FocusRequest = { version: 2, id: randomUUID(), sender: this.sessionId, target: target.id,
      identity, expiresAt: Date.now() + 4_000 };
    const replyFile = path.join(this.replies, `${request.id}.json`);
    try {
      await writeAtomic(path.join(this.inbox(target.id), `${request.id}.json`), request);
      while (Date.now() < request.expiresAt) {
        try {
          const value = await readJson(replyFile);
          if (!isReply(value) || value.id !== request.id || value.sender !== this.sessionId || value.target !== target.id) {
            throw new Error('Invalid window focus response');
          }
          if (!value.ok) throw new Error('The selected window could not be focused');
          return;
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await delay(100);
      }
      throw new Error('The selected window did not respond');
    } finally {
      await fs.rm(replyFile, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Ask another window to close itself. The reply acknowledges dispatch only; closure
   * is confirmed by the target's record disappearing. Never targets this session.
   */
  async close(target: WindowRecord, timing: CloseTiming = {}): Promise<CloseOutcome> {
    if (target.id === this.sessionId) throw new Error('Close this window directly, not through a request');
    const replyMs = timing.replyMs ?? 4_000;
    const goneMs = timing.goneMs ?? 10_000;
    const replyPollMs = timing.replyPollMs ?? 100;
    const gonePollMs = timing.gonePollMs ?? 500;
    // Re-read the registry: only a live, fresh record may be targeted.
    const fresh = (await this.list()).find(record => record.id === target.id);
    if (!fresh || Date.now() - fresh.updatedAt > STALE_AFTER_MS) {
      throw new CloseError('unavailable', 'The project window is no longer available');
    }
    const request: CloseRequest = { version: 3, id: randomUUID(), sender: this.sessionId,
      target: target.id, expiresAt: Date.now() + replyMs };
    const replyFile = path.join(this.replies, `${request.id}.json`);
    const targetGone = async (): Promise<boolean> => {
      try { return !(await this.list()).some(record => record.id === target.id); }
      catch { return false; }
    };
    try {
      await writeAtomic(path.join(this.inbox(target.id), `${request.id}.json`), request);
      let lastGoneCheck = 0;
      while (Date.now() < request.expiresAt) {
        try {
          const value = await readJson(replyFile);
          if (!isReply(value) || value.id !== request.id || value.sender !== this.sessionId || value.target !== target.id) {
            throw new CloseError('invalid-response', 'Invalid window close response');
          }
          if (!value.ok) throw new CloseError('invalid-response', 'The selected window could not be closed');
          // Dispatched; disappearance of the target record confirms the close.
          const deadline = Date.now() + goneMs;
          while (Date.now() < deadline) {
            if (await targetGone()) return 'closed';
            await delay(gonePollMs);
          }
          return 'still-open';
        } catch (error) {
          if (!missing(error)) throw error;
        }
        // The host may have died before answering; that also means the window is gone.
        if (Date.now() - lastGoneCheck >= gonePollMs) {
          lastGoneCheck = Date.now();
          if (await targetGone()) return 'closed';
        }
        await delay(replyPollMs);
      }
      if (await targetGone()) return 'closed';
      throw new CloseError('no-response', 'The selected window did not respond');
    } finally {
      await fs.rm(replyFile, { force: true }).catch(() => undefined);
    }
  }

  private async processRequests(): Promise<void> {
    if (this.runningRequests || this.closed) return;
    this.runningRequests = true;
    try {
      const inbox = this.inbox(this.sessionId);
      for (const name of await fs.readdir(inbox)) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!UUID.test(id)) continue;
        const file = path.join(inbox, name);
        let value: unknown;
        try { value = await readJson(file); }
        catch (error) { if (missing(error)) continue; await fs.rm(file, { force: true }); continue; }
        await fs.rm(file, { force: true });
        if (isCloseRequest(value) && value.id === id && value.target === this.sessionId
          && value.expiresAt >= Date.now() && value.expiresAt <= Date.now() + 10_000) {
          // The reply acknowledges dispatch only and must be written first: this
          // extension host dies with the window it closes.
          const reply: FocusReply = { version: 2, id: value.id, sender: value.sender, target: this.sessionId, ok: true };
          await writeAtomic(path.join(this.replies, `${value.id}.json`), reply);
          // A rejected close leaves the record in place; the sender reports the window open.
          try { await this.closeSelf(); } catch { /* Do nothing more. */ }
          continue;
        }
        if (!isRequest(value) || value.id !== id || value.target !== this.sessionId
          || value.expiresAt < Date.now() || value.expiresAt > Date.now() + 10_000) continue;
        let ok = this.folders.some(folder => folder.identity === value.identity);
        if (ok) {
          try { await this.focusSelf(value.identity); } catch { ok = false; }
        }
        const reply: FocusReply = { version: 2, id: value.id, sender: value.sender, target: this.sessionId, ok };
        await writeAtomic(path.join(this.replies, `${value.id}.json`), reply);
      }
      await this.removeOldReplies();
    } finally {
      this.runningRequests = false;
    }
  }

  private async removeOldReplies(): Promise<void> {
    for (const name of await fs.readdir(this.replies)) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      const file = path.join(this.replies, name);
      try {
        if (Date.now() - (await fs.stat(file)).mtimeMs > 60_000) await fs.rm(file, { force: true });
      } catch (error) { if (!missing(error)) throw error; }
    }
  }

  /**
   * Serialize a multi-step folder operation (e.g. destroying a worktree) across
   * participating windows. Returns undefined when another window holds the guard.
   */
  async guard<T>(identity: string, action: () => Promise<T>): Promise<T | undefined> {
    return this.withGuard(identity, async () => action(), undefined);
  }

  /** Fail closed while a previous open is unconfirmed, until the claim outlives its TTL. */
  async claim(identity: string): Promise<string | undefined> {
    return this.withGuard(identity, async lock => {
      try {
        if (Date.now() - (await fs.stat(lock)).mtimeMs <= CLAIM_TTL_MS) return undefined;
        await fs.rm(lock, { force: true });
      } catch (error) { if (!missing(error)) throw error; }
      const id = randomUUID();
      await writeAtomic(lock, { version: 1, id, identity } satisfies OpenClaim);
      return id;
    }, undefined);
  }

  /** Release only a claim belonging to this request before an open was dispatched. */
  async releaseUnstartedClaim(identity: string, id: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const released = await this.withGuard(identity, async lock => {
        let value: unknown;
        try { value = await readJson(lock); }
        catch (error) { if (missing(error)) return true; throw error; }
        if (!isClaim(value) || value.identity !== identity) throw new Error('Invalid project open claim');
        if (value.id === id) await fs.rm(lock);
        return true;
      }, false);
      if (released) return;
      await delay(50);
    }
    throw new Error('The pending project open could not be released');
  }

  private async releaseForRegisteredFolder(identity: string): Promise<void> {
    await this.withGuard(identity, async lock => {
      let value: unknown;
      try { value = await readJson(lock); }
      catch (error) { if (missing(error)) return; throw error; }
      if (!isClaim(value) || value.identity !== identity) throw new Error('Invalid project open claim');
      await fs.rm(lock);
    }, undefined);
  }

  private async withGuard<T>(identity: string, action: (lock: string) => Promise<T>, busy: T): Promise<T> {
    const key = createHash('sha256').update(identity).digest('hex');
    const guard = path.join(this.claims, `${key}.guard`);
    try { await fs.mkdir(guard, { mode: 0o700 }); }
    catch (error) { if (exists(error)) return busy; throw error; }
    try { return await action(path.join(this.claims, `${key}.json`)); }
    finally { await fs.rmdir(guard); }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.poller) clearInterval(this.poller);
    await this.writes.catch(() => undefined);
    await fs.rm(path.join(this.records, `${this.sessionId}.json`), { force: true });
    await fs.rm(this.inbox(this.sessionId), { recursive: true, force: true });
  }

  private inbox(id: string): string {
    if (!UUID.test(id)) throw new Error('Invalid window session');
    return path.join(this.inboxes, id);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
