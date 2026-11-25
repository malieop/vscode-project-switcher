import type { WindowRecord } from './windowRegistry';

export type OpenChoice = 'current' | 'new';
export type SwitchResult = 'current' | 'focused' | 'cancelled' | 'opened';
export type SwitchFailureStage = 'identity' | 'discovery' | 'focus' | 'busy' | 'open' | 'unconfirmed';

export class SwitchError extends Error {
  constructor(readonly stage: SwitchFailureStage, message: string, readonly original?: unknown) {
    super(message);
    this.name = 'SwitchError';
  }
}

export interface SwitchDependencies {
  identify(): Promise<string>;
  isCurrent(identity: string): Promise<boolean>;
  find(identity: string): Promise<WindowRecord | undefined>;
  focus(record: WindowRecord, identity: string): Promise<void>;
  choose(): Promise<OpenChoice | undefined>;
  claim(identity: string): Promise<string | undefined>;
  releaseUnstartedClaim(identity: string, token: string): Promise<void>;
  revalidate(identity: string): Promise<boolean>;
  open(choice: OpenChoice): Promise<void>;
  waitForRegistration(identity: string): Promise<boolean>;
}

/** Shared switching behavior for the sidebar and the command palette. */
export async function switchProject(deps: SwitchDependencies, preferredChoice?: OpenChoice): Promise<SwitchResult> {
  let identity: string;
  try { identity = await deps.identify(); }
  catch (error) { throw new SwitchError('identity', 'The project folder is unavailable or cannot be accessed.', error); }
  if (await deps.isCurrent(identity)) return 'current';

  let openWindow: WindowRecord | undefined;
  try { openWindow = await deps.find(identity); }
  catch (error) { throw new SwitchError('discovery', 'Open project windows could not be checked.', error); }
  if (openWindow) return focus(openWindow, identity, deps);

  const choice = preferredChoice ?? await deps.choose();
  if (!choice) return 'cancelled';

  let token: string | undefined;
  try { token = await deps.claim(identity); }
  catch (error) { throw new SwitchError('discovery', 'The project open request could not be coordinated.', error); }
  if (!token) throw new SwitchError('busy', 'Another open request is pending or could not be verified.');

  let dispatched = false;
  try {
    try { openWindow = await deps.find(identity); }
    catch (error) { throw new SwitchError('discovery', 'Open project windows could not be checked.', error); }
    if (openWindow) return await focus(openWindow, identity, deps);

    let unchanged: boolean;
    try { unchanged = await deps.revalidate(identity); }
    catch (error) { throw new SwitchError('identity', 'The project folder is unavailable or cannot be accessed.', error); }
    if (!unchanged) throw new SwitchError('identity', 'The project folder changed or is no longer available.');

    dispatched = true;
    try { await deps.open(choice); }
    catch (error) { throw new SwitchError('open', 'VS Code could not open the project.', error); }

    let confirmed: boolean;
    try { confirmed = await deps.waitForRegistration(identity); }
    catch (error) { throw new SwitchError('unconfirmed', 'The opened project window could not be verified.', error); }
    if (!confirmed) throw new SwitchError('unconfirmed', 'The opened project window could not be verified.');
    return 'opened';
  } finally {
    if (!dispatched) await deps.releaseUnstartedClaim(identity, token);
  }
}

async function focus(record: WindowRecord, identity: string, deps: SwitchDependencies): Promise<SwitchResult> {
  try { await deps.focus(record, identity); return 'focused'; }
  catch (error) { throw new SwitchError('focus', 'The selected project window could not be focused.', error); }
}
