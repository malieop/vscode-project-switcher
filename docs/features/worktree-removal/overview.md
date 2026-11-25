# Feature: Worktree removal

## Problem and desired outcomes

The extension creates worktrees but cannot remove them. Finished experiment branches
accumulate on disk and in the checkout lists. The user wants to destroy a worktree
from the extension.

Success: the user destroys a linked worktree and its branch from the Projects view.
Uncommitted work is never discarded without an explicit, informed choice. A worktree
open in a window is closed first, safely. The primary checkout is never touched.

## Scope and non-goals

- In scope: destroying linked worktrees of saved Git projects, from a checkout row or
  the Command Palette.
- In scope: deleting the worktree's branch after removal.
- In scope: explicit forced destruction after a warning that lists what is lost.
- In scope: closing a participating window that has the worktree open, via the
  [close-window feature](../close-window/proposal.md), before removing files.
- Out of scope: the primary checkout. Never a destroy target.
- Out of scope: plain (non-Git) projects; removing saved project entries; removing
  remote branches.
- Out of scope: automatic pruning or repair of stale Git worktree registrations.
  Report only; repair stays manual.
- Out of scope: unlocking locked worktrees. Report the locked state and stop.
- Out of scope: Windows, matching the creation gate. Remote folders stay unsupported.

## System context and constraints

- Observed: worktrees appear as checkout children of Git projects
  (`src/checkoutModel.ts`, `src/projectsView.ts`). Rows know `primary`, `branch`, and
  the worktree path from `git worktree list --porcelain -z` (`src/gitDiscovery.ts`).
- Observed: creation runs Git through a hardened spawn with fixed arguments,
  identity revalidation, and no shell interpolation (`src/gitWorktreeCreate.ts:83-128`).
  Removal follows the same execution discipline.
- Observed: creation requires workspace trust and confirmed project trust
  (`src/projectCommands.ts:206-233`), per accepted
  [P-14](../project-worktrees/proposal.md#p-14-trust-gates-for-git-and-opencode).
- Git facts: `git worktree remove` refuses dirty or untracked worktrees unless
  `--force`; a locked worktree needs `--force` twice. `git branch -d` refuses
  unmerged branches; `-D` forces. See the
  [Git worktree manual](https://git-scm.com/docs/git-worktree) and
  [Git branch manual](https://git-scm.com/docs/git-branch).
- User facts (2026-11-20): destroy removes worktree plus branch; force is offered
  explicitly; a window holding the worktree is closed first.
- Constraint: closing the initiating window kills the flow. A worktree open in the
  current window cannot be destroyed from that window.
- Dependency: close-first behavior requires the
  [close-window mechanism](../close-window/proposal.md), which carries the B-09
  delivery condition.

## Sources

- `src/gitWorktreeCreate.ts`: hardened Git execution, identity checks, creation policy.
- `src/gitDiscovery.ts`: worktree listing and porcelain parsing.
- `src/checkoutModel.ts`: primary versus linked checkout model.
- `src/windowRegistry.ts`: window discovery by folder identity; claims and guards.
- [Worktrees proposal](../project-worktrees/proposal.md): creation decisions P-01 through P-14; deletion was deferred there.
- [Close-window proposal](../close-window/proposal.md): the close-first dependency.
- Git manuals linked above: removal and branch-deletion refusal semantics.
- User confirmations in the 2026-11-20 session: scope, force policy, close-first.

## Design and delivery

- [Proposal and agreement history](proposal.md)
- [Feature index](../README.md)
- [Slice 01: Destroy a linked worktree](slices/01-destroy-a-linked-worktree.md): code complete and unit-tested (2026-11-23); manual runtime verification open.
