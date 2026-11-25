# Slice 01: Open a project or worktree with OpenCode

## Status

In progress. The scope has a partial implementation; required contracts and end-to-end verification remain open.

## Outcome and scope

Proposed outcome: add a local Git project, create or discover its worktrees, and open a checkout in VS Code.

- Show the primary checkout and linked worktrees under each project, not branches without checkouts.
- Create a worktree under the configured parent and preview its destination.
- Open a newly created worktree in a new window; leave the original window open.
- Fetch after project trust confirmation; suggest `origin/main`, then `origin/master`.
- Ask when multiple remotes make the choice ambiguous. Let the user choose another starting branch.
- Migrate saved paths to a private, cross-profile local file; coordinate edits across participating windows.
- Preserve existing unavailable and non-Git saved entries.
- Open a checkout or focus its existing window, following the accepted window choices.
- Start OpenCode in the trusted destination terminal when opening a window, subject to safe destination identification.
- Silently skip automatic launch when the destination cannot be identified safely.
- VS Code exposes no documented destination correlation for `vscode.openFolder`; automatic launch may be skipped for every opening.
- Exclude worktree deletion and relocation, remote development, and automatic project discovery.
- Defer automatic profile inheritance; prefer a known project profile only if supported, otherwise let VS Code decide.

## Proposal references

- [Overview](../overview.md): revised requirements and existing constraints.
- [B-05](../../project-switcher/proposal.md#b-05-focus-open-projects-and-choose-where-to-open-others): window focus and choice.
- [B-11](../../project-switcher/proposal.md#b-11-shared-private-saved-project-store): shared file, migration, and coordinated edits.
- [P-01](../proposal.md#p-01-create-a-worktree-from-a-saved-project): new branches only, remote main/master suggestion, and user-selected starting branch.
- [P-02](../proposal.md#p-02-launch-opencode-in-the-integrated-terminal): terminal interface.
- [P-03](../proposal.md#p-03-group-worktree-entries-under-their-project): project-level branch submenu.
- [P-04](../proposal.md#p-04-open-new-worktrees-in-dedicated-new-windows): new-worktree window.
- [P-05](../proposal.md#p-05-reuse-the-shared-worktrees-root): configurable shared parent.
- [P-09](../proposal.md#p-09-start-opencode-when-opening-a-window): OpenCode launch timing.
- [P-10](../proposal.md#p-10-include-worktrees-outside-the-shared-parent): outside-parent worktrees where possible.
- [P-11](../proposal.md#p-11-faster-window-choice): direct actions and normal selection.
- [P-12](../proposal.md#p-12-fetch-before-choosing-a-starting-branch): automatic fetch and local fallback.
- [P-13](../proposal.md#p-13-skip-launch-when-destination-is-uncertain): silent skip on unsafe destination identification.
- [P-14](../proposal.md#p-14-trust-gates-for-git-and-opencode): source project and destination trust gates.

## Behavior and contracts

- Proposed discovery: use Git's worktree list; do not infer ownership solely from directory names.
- Proposed safety: do not overwrite destinations, reset branches, prune metadata, or delete worktrees.
- Proposed recovery: preserve successfully created worktrees if later persistence, opening, or launch fails.
- Report a failure when window discovery or focus is unavailable; offer the native window picker.
- Project trust must be confirmed for the selected project, not inferred from an unrelated current workspace.
- Destination Workspace Trust must be confirmed separately before automatic OpenCode launch.
- On fetch failure, explain the failure and offer local branches. Proposed interpretation: `refs/heads`, not cached remote-tracking refs.
- Migrating each participating profile must preserve existing paths and not silently restore removed entries on retry.
- Shared-file mutation must coordinate reads and writes across profiles; instance-local queues are insufficient.
- File permissions, migration conflict recovery, process arguments, and handoff mechanics remain open.

## Proposed acceptance criteria

- A user adds a local Git project and sees its primary checkout and discoverable linked worktrees beneath it.
- The project submenu does not list branches without a primary checkout or worktree.
- A linked worktree outside the shared parent appears when Git reports it and discovery succeeds.
- Creating a worktree offers a starting branch, previews its destination, and never overwrites an existing destination.
- A newly created worktree opens in a new window rooted at its path; the original window remains open.
- After trust confirmation, preparing the starting-branch picker triggers a fetch.
- When both exist, suggest `origin/main`; when only `origin/master` exists, suggest it. Permit another branch.
- With ambiguous multiple remotes, ask the user instead of silently choosing a remote.
- A failed fetch explains the failure and offers local branches without presenting cached remote refs as fresh.
- Unconfirmed or denied project trust prevents both fetch and creation, even if the current workspace is trusted.
- Migrating participating profiles preserves valid unavailable and non-Git paths and deduplicates only confirmed identities.
- Concurrent adds and removals from different windows or profiles do not silently lose confirmed edits.
- Interrupted migration or a failed write preserves recoverable data. Retries do not silently resurrect removed paths.
- A newly participating profile contributes its legacy entries safely; inactive profile data is not claimed as already migrated.
- Saved paths remain local and shared between participating profiles; no Settings Sync or telemetry is used.
- Normal selection offers a window choice; direct actions use their selected destination without another prompt.
- Selecting an already-open checkout focuses its window without launching another OpenCode instance.
- Opening a safely identified, trusted destination starts an available OpenCode CLI in its integrated terminal.
- An untrusted destination never starts OpenCode. An unrelated trusted source does not bypass this gate.
- If destination identification is unsafe, launch is silently skipped; no unrelated window receives a terminal launch.
- Current-window switching starts OpenCode only when the handoff and destination trust can be verified.
- Creation success followed by an opening or actual launch failure leaves the worktree intact and reports the failure.
- A missing OpenCode CLI leaves the opened worktree usable and reports the launch failure.
- An unsafe-destination skip is silent; it is not reported as an OpenCode launch failure.
- Missing folders or failed Git discovery are not silently reported as a successful empty list.
- Users can complete branch, trust, and recovery choices with keyboard-accessible native controls.

## Dependencies and blockers

- Review the implemented local-branch fallback, no-remote behavior, naming, and creation defaults.
- Verify shared-file permissions, locking, interrupted-write recovery, and migration beyond isolated tests.
- Resolve ambiguous-alias removal, abandoned locks, and coexistence with old extension versions.
- Verify discovery, window focusing, and race handling in an Extension Development Host.
- Review the explicit selected-project trust confirmation and restricted-workspace behavior in VS Code.
- Verify supported Git/VS Code versions, fetch authentication, cancellation, and recovery beyond isolated tests.
- OpenCode launch remains skipped because destination correlation is not verified; the user accepted this fallback.
- Deferred: worktree deletion, setup automation, remote development, OpenCode restoration, and automatic profile inheritance.

## Implementation evidence

Implementation evidence: [baseline and test results](../../project-switcher/proposal.md#implementation-evidence-and-next-step) and [worktree implementation](../proposal.md#implementation-evidence). Automatic OpenCode launch is skipped; the user accepted this safety fallback.
