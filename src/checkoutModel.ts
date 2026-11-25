import { pathToFileURL } from 'node:url';
import { folderIdentity, sameFolderIdentity } from './folderIdentity';
import type { GitWorktree } from './gitDiscovery';

export interface CheckoutModel {
  readonly uri: string;
  readonly primary: boolean;
  readonly available: boolean;
  readonly current: boolean;
  readonly branch?: string;
}

/** New project records must point at Git's main checkout, not a linked worktree. */
export async function validatePrimaryCheckout(projectUri: string, worktrees: readonly GitWorktree[]): Promise<void> {
  const first = worktrees[0];
  if (!first || first.bare) throw new Error('Select a non-bare Git project checkout.');
  const project = await folderIdentity(projectUri);
  const main = await folderIdentity(pathToFileURL(first.path).href);
  if (project.kind !== 'directory' || main.kind !== 'directory' || !sameFolderIdentity(project.identity, main.identity)) {
    throw new Error('Select the project’s main Git checkout, not a linked worktree.');
  }
}

/** Preserve the selected primary path while matching Git's paths by filesystem identity. */
export async function buildCheckoutModel(projectUri: string, currentUri: string | undefined,
                                         worktrees: readonly GitWorktree[]): Promise<CheckoutModel[]> {
  const project = await folderIdentity(projectUri);
  if (project.kind !== 'directory') throw new Error('The project folder is unavailable.');
  if (worktrees.some(worktree => worktree.bare)) throw new Error('Bare repositories are not supported.');
  const current = currentUri ? await folderIdentity(currentUri) : undefined;
  const rows = await Promise.all(worktrees.map(async (worktree, index) => {
    const uri = pathToFileURL(worktree.path).href;
    const identity = await folderIdentity(uri);
    return {
      uri,
      primary: index === 0,
      selected: identity.kind === 'directory' && sameFolderIdentity(identity.identity, project.identity),
      available: identity.kind === 'directory',
      current: identity.kind === 'directory' && current?.kind === 'directory'
        && sameFolderIdentity(identity.identity, current.identity),
      branch: worktree.detached ? 'Detached HEAD' : worktree.branch
    };
  }));
  if (!rows.some(row => row.selected)) throw new Error('The saved project is not a Git checkout root.');
  return rows.map(({ selected, ...row }) => selected ? { ...row, uri: projectUri } : row);
}
