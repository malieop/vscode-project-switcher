export interface SelectableBranch {
  readonly ref: string;
}

/** Multiple remotes need an explicit user choice. */
export function defaultRemote(remotes: readonly string[]): string | undefined {
  return remotes.length === 1 ? remotes[0] : undefined;
}

export function verifiedRemoteBranches(branches: readonly { readonly ref: string; readonly oid: string }[],
                                       remote: string, advertised: readonly { readonly ref: string; readonly oid: string }[]): Set<string> {
  const heads = new Map(advertised.map(head => [head.ref, head.oid]));
  const prefix = `refs/remotes/${remote}/`;
  return new Set(branches.filter(branch => branch.ref.startsWith(prefix) &&
    heads.get(`refs/heads/${branch.ref.slice(prefix.length)}`) === branch.oid).map(branch => branch.ref));
}

/** Suggest the selected remote's main, then master, without excluding other branches. */
export function sortStartingBranches<T extends SelectableBranch>(branches: readonly T[], remote?: string,
                                                                 verified?: ReadonlySet<string>): T[] {
  const preference = (branch: T): number => {
    if (!remote || (verified && !verified.has(branch.ref))) return 2;
    if (branch.ref === `refs/remotes/${remote}/main`) return 0;
    if (branch.ref === `refs/remotes/${remote}/master`) return 1;
    return 2;
  };
  return [...branches].sort((a, b) => preference(a) - preference(b));
}
