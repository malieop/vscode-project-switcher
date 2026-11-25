# Slice 01: Add any local folder as a project

## Status

Ready. B-12 and B-13 and the mechanics in contracts 1-5 are accepted. Implementation not started; design acceptance does not authorize coding.

## Outcome and scope

Outcome: any existing local folder can be saved and opened as a project, and worktree actions exist only where they can work.

In scope:

- Add Project accepts folders without a `.git` entry and runs no Git on them.
- Git folders keep the current validation: main checkout, non-bare.
- The sidebar distinguishes Git and plain projects. Create Worktree appears only on Git projects.
- Command Palette Create Worktree on a plain project explains the Git requirement; no Git process runs.
- Plain projects open through the existing switching flow: sidebar click, quick picker, and inline open actions.

Exclusions:

- New Project from scratch (B-14): next slice.
- Changes to worktree creation, OpenCode launch, and the window registry.
- Store format changes: none needed; B-11 already preserves non-Git entries.

## Proposal references

- [Overview](../overview.md): shared problem, scope, and constraints.
- [B-04](../proposal.md#b-04-accessible-native-selectors-and-one-switching-handler): folder picker and shared switching handler.
- [B-05](../proposal.md#b-05-focus-open-projects-and-choose-where-to-open-others): focus open projects; window choice.
- [B-06](../proposal.md#b-06-treat-different-paths-to-the-same-folder-as-one-project): path-identity deduplication.
- [B-08](../proposal.md#b-08-keep-and-show-the-project-list-when-saving-fails): failure behavior for the saved list.
- [B-11](../proposal.md#b-11-shared-private-saved-project-store): shared store; preserves non-Git entries.
- [B-12](../proposal.md#b-12-a-project-is-any-local-folder-git-is-optional): accepted direction for this slice.
- [B-13](../proposal.md#b-13-worktree-actions-appear-only-for-git-projects): accepted gating direction.
- [P-03](../../project-worktrees/proposal.md#p-03-group-worktree-entries-under-their-project): checkout grouping identity.
- [P-11](../../project-worktrees/proposal.md#p-11-faster-window-choice): direct open actions.

## Behavior and contracts

1. Git detection: a `.git` entry, file or directory, at the folder root marks a Git project. Detection runs at every list load and refresh. Git state is derived, never stored.
2. Add flow: the folder picker is unchanged. For each picked folder:
   - No `.git`: save directly. Do not run Git.
   - `.git` present: run the existing `listWorktrees` and `validatePrimaryCheckout` checks. Linked worktrees and bare repositories stay declined with their current messages.
   - `.git` present but Git fails: show the Git error. Do not silently save the folder as plain.
3. Sidebar: a plain project node is not expandable and opens the folder on click through the shared switching handler. Git project nodes are unchanged.
4. Menu gating: the Create Worktree `when` clause uses a Git-specific item context value, for example `projectGit`. The existing workspace-trust enablement is unchanged.
5. Palette gating: Create Worktree without a tree item lists all projects. Choosing a plain project shows a plain-language explanation before any Git call.
6. Quick picker: a plain project appears as its own single row. The "Worktrees could not be loaded" warning applies only to Git projects whose discovery fails.
7. State changes: a folder gaining or losing `.git` flips its kind on the next refresh. Neither direction raises an error.
8. Failure behavior: store failures follow B-08 unchanged. This slice adds no filesystem writes.

## Acceptance criteria

- Given a folder without `.git`, when it is added, then it appears in the sidebar and quick picker and opens with the normal window choice.
- Given a folder nested inside another Git repository without its own `.git`, when it is added, then it saves as a plain project and no Git error appears. This is the reported-error regression case.
- Given a linked worktree with a `.git` file, when it is added, then it is declined with the main-checkout guidance.
- Given a plain project in the sidebar, then it shows no Create Worktree action and no "Worktrees unavailable" message, and clicking it opens the folder.
- Given a Git project, then its Create Worktree action and checkout children behave as before this slice.
- Given Create Worktree from the Command Palette on a plain project, then an explanation appears and no Git process runs.
- Given a plain folder that later gains `.git`, when the view refreshes, then it shows checkout children and the Create Worktree action.
- Given a Git project that loses `.git`, when the view refreshes, then it behaves as a plain project without errors.
- Given keyboard-only use, then Add, opening, and the palette explanation are reachable without the inline buttons.
- Given a plain project entry, when VS Code restarts, then the entry persists and deduplicates per B-06.

## Dependencies and blockers

- Blockers: none. Contracts 1-5 were explicitly accepted.
- Deferred: B-14 from-scratch creation is the next slice.
- Deferred: an old extension version shows plain entries as unavailable but preserved, per B-08. Accepted degradation for a local, single-publisher extension.
- The user's original error path is unconfirmed; the nested-repository criterion covers the observed message regardless.

## Implementation evidence

Not implemented. The current code rejects plain folders in [`projectCommands.ts`](../../../../src/projectCommands.ts#L86-L104) and raises the reported error from [`gitDiscovery.ts`](../../../../src/gitDiscovery.ts#L138).
