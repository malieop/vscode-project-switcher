import { OpenCode, OpenCodeClient } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { EMPTY_SNAPSHOT, OpenCodeSnapshot } from './opencodeStatus';

/**
 * Read-only client for the shared OpenCode background service. Discovers the
 * registered service without starting one (P-02). Every failure yields an
 * empty snapshot: the Open Windows view must keep working without badges (R2).
 *
 * Kept separate from opencodeStatus.ts: @opencode/client is ESM-only, so this
 * module must only load inside the esbuild bundle, never in the plain node
 * unit tests.
 */
export class OpenCodeStatus {
  private client?: OpenCodeClient;

  /** Poll the service. Permission and form lists are location-scoped, so they
   *  are queried per window directory; sessions and the active map are global. */
  async poll(directories: string[]): Promise<OpenCodeSnapshot> {
    try {
      const client = await this.connect();
      if (!client) return EMPTY_SNAPSHOT;
      const unique = [...new Set(directories)];
      const [sessions, active, permissions, forms] = await Promise.all([
        client.session.list({ limit: 100 }),
        client.session.active(),
        Promise.all(unique.map(directory => client.permission.request.list({ location: { directory } }))),
        Promise.all(unique.map(directory => client.form.list({ location: { directory } }))),
      ]);
      const pending = new Set<string>();
      for (const result of permissions) for (const request of result.data) pending.add(request.sessionID);
      for (const result of forms) for (const form of result.data) pending.add(form.sessionID);
      return {
        sessions: sessions.data.map(session => ({
          id: session.id,
          directory: session.location.directory,
          touched: session.time.idle ?? session.time.updated,
          archived: session.time.archived !== undefined,
        })),
        active: new Set(Object.keys(active)),
        pending,
      };
    } catch {
      // Rediscover next poll: the service may have restarted with a new password.
      this.client = undefined;
      return EMPTY_SNAPSHOT;
    }
  }

  private async connect(): Promise<OpenCodeClient | undefined> {
    if (this.client) return this.client;
    const endpoint = await Service.discover();
    if (!endpoint) return undefined;
    this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    return this.client;
  }
}
