# Proposal: Worktree removal

## Status

Accepted. P-01 through P-03 directions were accepted on 2026-11-20; the P-02 through P-05 contracts and the "Destroy Worktree" name were accepted as drafted the same day. Acceptance does not authorize implementation. Slice readiness stays blocked until the close-window verification checklist passes.

Depends on the [close-window proposal](../close-window/proposal.md) for P-03. Reverses the creation flow in the [worktrees proposal](../project-worktrees/proposal.md), where deletion was deferred.

## Proposed approach

Add a Destroy Worktree action to non-primary checkout rows and the Command Palette.
The flow confirms trust, closes a participating window holding the worktree, checks
for work that would be lost, asks for explicit confirmation, removes the worktree
with Git, then deletes its branch.

### P-01: Destroy removes the worktree and deletes its branch

- Status: accepted, including the "Destroy Worktree" command name.
- Approach: run `git worktree remove -- <path>` from the project's main checkout,
  then `git branch -d -- <branch>`. Detached-HEAD worktrees have no branch; removal
  only. Never target the primary checkout: the action appears only on non-primary
  checkout rows, and Git refuses to remove the main worktree as a backstop.
- Context and evidence: user selected "Worktree + branch" on 2026-11-20. Git refuses
  to delete a branch checked out in a worktree; removing the worktree first frees it.
  Branch names come from parsed porcelain output (`src/gitDiscovery.ts`) and are
  revalidated before use.
- Alternatives and tradeoffs: worktree-only removal keeps branches forever and
  forces terminal cleanup. Asking each time adds a prompt the user already answered.
- Consequences: unmerged-branch refusal needs the force path in P-02. Branch deletion
  after worktree removal is a partial-failure point; see P-05.
- Confirmation: accepted 2026-11-20 ("Worktree + branch"; name "Destroy Worktree" accepted as drafted).

### P-02: Explicit force after an enumerated loss warning

- Status: accepted.
- Approach: pre-flight detects three loss categories: uncommitted changes, untracked
  files, and commits not merged into the main checkout's HEAD or the branch's
  upstream. Clean worktree and merged branch: one plain confirmation naming the
  branch, path, and project. Any category present: refuse by default and explain, or
  proceed only through an explicit "Destroy Anyway" choice whose dialog lists every
  detected category. Forced removal uses `git worktree remove --force`; forced branch
  deletion uses `git branch -D`.
- Context and evidence: user selected "Offer explicit force" on 2026-11-20. Git's own
  refusals define the categories; pre-flight exists because this codebase's Git
  wrapper intentionally discards command output (`src/gitWorktreeCreate.ts:24-30`),
  so refusal reasons cannot be parsed after the fact.
- Alternatives and tradeoffs: refuse-always is safer but strands routine cleanup.
  Parsing Git's stderr for refusal reasons conflicts with the no-output discipline.
- Consequences: pre-flight detection commands are slice contracts. Detection must
  re-run after the close-first step, because closing a window does not change Git
  state but the user may have edited files meanwhile.
- Confirmation: accepted 2026-11-20 ("Offer explicit force"; combined dialog accepted as drafted).

### P-03: Close a participating window holding the worktree first

- Status: accepted, including the current-window and multi-root refusal rules.
- Approach: before any Git mutation, look up the worktree's folder identity in the
  window registry. If a live window holds it, send a close request and wait for the
  record to disappear. If the close fails or the window stays open, abort the destroy
  and say why. Two refusal rules, proposed:
  - The worktree is open in the initiating window: refuse. Closing it would kill the
    extension host mid-flow. Tell the user to run destroy from another window.
  - The worktree is one folder of a multi-root window: refuse. Closing that window
    closes unrelated folders. Tell the user to remove the folder from that workspace.
- Context and evidence: user selected "Close that window first" on 2026-11-20.
  Identity-based lookup exists (`WindowRegistry.find`, `src/windowRegistry.ts:213-227`).
  The close mechanism and its B-09 delivery condition live in the
  [close-window proposal](../close-window/proposal.md).
- Alternatives and tradeoffs: refusing whenever open is simpler but forces manual
  window closing for the common case. Proceeding with an open window leaves VS Code
  running against deleted files.
- Consequences: this feature cannot reach readiness before the close-window
  mechanism is verified. A non-participating window (extension disabled) cannot be
  detected; the destroy proceeds and that window loses its folder. Documented limit.
- Confirmation: accepted 2026-11-20 ("Close that window first"; refusal rules accepted as drafted).

### P-04: Trust and execution parity with creation

- Status: accepted.
- Approach: same gates as creation: workspace trust, confirmed project trust with
  identity revalidation around each step, and the hardened Git environment. Not
  available on Windows. Menu enablement uses `isWorkspaceTrusted`, matching
  Create Worktree.
- Context and evidence: accepted trust gates in
  [P-14](../project-worktrees/proposal.md#p-14-trust-gates-for-git-and-opencode);
  observed gates in `src/projectCommands.ts:206-233`; platform gate at
  `src/projectCommands.ts:220-223`.
- Alternatives and tradeoffs: lighter gates for deletion would be inconsistent;
  `git worktree remove` still runs repository configuration and hooks machinery.
- Consequences: the same unverified trust-binding concern as creation applies.
- Confirmation: accepted 2026-11-20 ("Accept as drafted").

### P-05: Ordering, concurrency, and partial failure

- Status: accepted.
- Approach: fixed order: close window, remove worktree, delete branch. Serialize
  destroys of the same folder identity with the registry's existing claim-guard
  pattern (`src/windowRegistry.ts:336-343`). After a failure, report the exact stage
  reached. A removed worktree with a surviving branch is a stable, explained end
  state; never retry silently, never roll back by recreating anything.
- Context and evidence: creation's partial-failure policy keeps partial results and
  names the failed stage ([worktrees proposal risks](../project-worktrees/proposal.md#relevant-risks-and-proposed-mitigations)).
- Alternatives and tradeoffs: branch-first ordering is impossible; Git refuses to
  delete a checked-out branch. Best-effort re-creation on failure violates the
  no-surprise-mutation stance.
- Consequences: concurrent destroys from two windows fail closed on the guard; the
  loser reports the worktree is busy.
- Confirmation: accepted 2026-11-20 ("Accept as drafted").

## Sequence flows

```mermaid
sequenceDiagram
  participant U as User
  participant E as Extension (initiating window)
  participant R as Window registry
  participant W as Window holding worktree
  participant G as Git (main checkout)
  U->>E: Destroy Worktree on a checkout row
  E->>E: Workspace trust + project trust + identity
  E->>R: find(worktree identity)
  alt open in initiating window or multi-root window
    E->>U: Refuse with guidance
  else open in another participating window
    E->>R: Close request
    R->>W: Deliver; W closes itself
    E->>R: Wait for record removal; abort if it stays
  end
  E->>G: Pre-flight: dirty? untracked? unmerged?
  alt losses detected
    E->>U: Refuse, or explicit Destroy Anyway listing losses
  else clean
    E->>U: Confirm branch, path, project
  end
  E->>G: git worktree remove [--force] -- path
  E->>G: git branch -d|-D -- branch
  E->>U: Report result; name the stage on partial failure
```

Caption: proposed destroy flow (P-01 through P-05). Registry lookup and claim guards
are observed implementation; close delivery is proposed in the close-window proposal
and unverified. Git refusal semantics per the cited manuals. No runtime evidence yet.

## Relevant risks and proposed mitigations

- Data loss (blocking): force discards uncommitted changes, untracked files, and
  unmerged commits. Mitigations: default refusal, enumerated loss warning, explicit
  force choice, no auto-force ever. Acceptance criteria: canceling any prompt changes
  nothing; destroying a dirty worktree without force changes nothing.
- Wrong window closed (blocking): P-03 inherits the close-window verification
  checklist and B-09 delivery condition. This feature's first slice stays blocked
  until that checklist passes.
- Partial failure between removal and branch deletion (blocking contract): report
  the stage; the surviving branch is valid Git state; offer no automatic cleanup.
- Non-participating windows (deferred): a window without the extension is invisible;
  its folder disappears under it. Documented limit, same class as existing discovery
  limits.
- Locked worktrees (deferred): Git demands double force; v1 reports the locked state
  and stops. Unlocking is a separate decision.
- Stale registrations (deferred): a manually deleted folder fails removal; v1
  explains and suggests manual `git worktree prune`. No automatic pruning, per the
  recorded no-repair stance.
- Submodules (deferred): forced removal discards submodule working-tree changes.
  Detection detail deferred; the force warning covers the worktree as a whole.
- Compatibility: Windows excluded, matching creation. Old extension versions lack the
  action; no coexistence concern beyond the close-request version note.

## Open questions and assumptions

- ~~Command title~~ Resolved 2026-11-20: "Destroy Worktree", distinct from
  metadata-only "Remove Project".
- Pre-flight detection commands and merged-state definition: slice contracts.
- Whether the palette picker filters to linked worktrees only: proposed yes.

## Agreement and change history

| Event | Item | Confirmation and rationale | Impact |
| --- | --- | --- | --- |
| 2026-11-20 session | Feature | User requested "someway to destroy worktree." | New feature; deletion was deferred in the worktrees proposal. No implementation authorized. |
| 2026-11-20 session | P-01 | User selected "Worktree + branch." | Destroy deletes the branch after removing the worktree; detached HEAD skips branch deletion. |
| 2026-11-20 session | P-02 | User selected "Offer explicit force." | Forced path exists, gated by an enumerated loss warning; default refuses. |
| 2026-11-20 session | P-03 | User selected "Close that window first." | Destroy depends on the close-window feature; refusal rules proposed. |
| 2026-11-20 session | P-02–P-05 contracts, naming | User selected "Accept as drafted" for the combined force dialog, both refusal rules, trust parity, and ordering/concurrency; user selected "Destroy Worktree". | All P-01 through P-05 contracts accepted. Remaining items are slice-level details. |

## Implementation evidence

Not implemented. Observed prerequisites: worktree listing (`src/gitDiscovery.ts`),
hardened Git execution (`src/gitWorktreeCreate.ts`), checkout model
(`src/checkoutModel.ts`), registry lookup and guards (`src/windowRegistry.ts`).
Acceptance does not authorize implementation.
