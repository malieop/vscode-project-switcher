# Slice 02: Create a project folder from scratch

## Status

Ready. B-14 and the mechanics in contracts 1-9 are accepted. Implementation not started; design acceptance does not authorize coding.

## Outcome and scope

Outcome: create a brand-new project folder inside a configurable root, optionally initialize Git, save it, and open it — without leaving the extension.

In scope:

- A New Project command: name the project, create the folder in the configured root, offer `git init`, save, open.
- A user-level setting for the default root, mirroring `projectSwitcher.worktreesDirectory`.
- Stage-exact failure reporting: folder creation, Git init, and store save are separate stages.

Exclusions:

- Templates, scaffolding, starter files, and dependency installation.
- Worktree creation for the new project; that is the existing Create Worktree flow.
- Store format changes: none needed.
- Slice 01's any-folder Add Project: separate slice, soft dependency only.

## Proposal references

- [Overview](../overview.md): shared problem, scope, and constraints.
- [B-04](../proposal.md#b-04-accessible-native-selectors-and-one-switching-handler): native selectors, cancellation support.
- [B-05](../proposal.md#b-05-focus-open-projects-and-choose-where-to-open-others): focus open projects; window choice.
- [B-06](../proposal.md#b-06-treat-different-paths-to-the-same-folder-as-one-project): path-identity deduplication.
- [B-08](../proposal.md#b-08-keep-and-show-the-project-list-when-saving-fails): saved-list failure behavior.
- [B-11](../proposal.md#b-11-shared-private-saved-project-store): shared store.
- [B-13](../proposal.md#b-13-worktree-actions-appear-only-for-git-projects): Git-gated worktree actions.
- [B-14](../proposal.md#b-14-create-a-project-folder-from-scratch): accepted direction for this slice.
- [P-11](../../project-worktrees/proposal.md#p-11-faster-window-choice): direct open actions.
- [Slice 01](01-any-folder-projects.md): plain and Git project display behavior.

## Behavior and contracts

1. Entry points: a `projectSwitcher.newProject` command ("New Project") in the view title next to Add Project, the empty-view welcome content, and the Command Palette. Requires a trusted workspace, same as Create Worktree.
2. Root resolution: read the configured projects root, proposed as `projectSwitcher.projectsDirectory` (application scope, `ignoreSync`, default `/Users/diogocoelho/repos`). If it is empty, not absolute, missing, or not a directory, show an error naming the setting and create nothing. Never create the root implicitly.
3. Name: ask for one safe directory component, reusing the `validDirectoryComponent` pattern from worktree creation. Invalid input shows guidance and retries. Canceling stops the flow; nothing is created.
4. Collision: if `<root>/<name>` already exists as anything — directory, file, or symlink — warn and ask for another name. Never adopt or overwrite it.
5. Create: make the directory with normal user permissions. On failure, report and save nothing.
6. Git init: after creation, ask "Initialize a Git repository?" with "No" as the default. Canceling this prompt counts as "No"; the flow continues. On "Yes", run `git init` in the new folder using the extension's hardened Git environment (stripped `GIT_*` variables, no credential prompts). Use the user's configured default branch; do not impose one. On failure, keep the folder, report the failed stage, and continue to save it as a plain project.
7. Save: add the folder to the shared store per B-11. On failure, apply B-08: keep the folder, show the warning with known paths, and never delete the created folder.
8. Open: after saving, run the standard switching flow from B-05 and P-11: focus if already open, otherwise ask current or new window. Canceling the window choice leaves the saved entry in the list.
9. Resulting kind: a Git-initialized project gains Git behavior and worktree actions on the next refresh, per B-13. A declined one remains a plain project under slice 01's contracts.

## Acceptance criteria

- Given a valid name and an existing root, when New Project completes, then `<root>/<name>` exists, the entry is saved, and the window choice appears.
- Given an invalid name, then it is rejected with guidance and nothing is created.
- Given a name that already exists in the root, then the user is asked for another name and the existing item is untouched.
- Given "Yes" at the Git prompt, when the flow completes, then the project shows checkout grouping and Create Worktree after a refresh.
- Given "No" or cancel at the Git prompt, then the folder is saved as a plain project.
- Given a failed `git init`, then the folder is kept, the failed stage is reported, and the project is saved as plain.
- Given a store save failure, then the B-08 warning shows the known paths and the created folder remains on disk.
- Given a missing or invalid configured root, then an error names the setting and nothing is created.
- Given an untrusted workspace, then the command is unavailable with the trust explanation.
- Given cancellation at the name prompt, then nothing is created or saved.
- Given a completed save, when the window choice is canceled, then the entry remains in the project list.
- Given keyboard-only use, then every prompt and choice in the flow is reachable by keyboard.

## Dependencies and blockers

- Blockers: none. All contracts were explicitly accepted.
- Soft dependency: slice 01. Without it, a plain scratch project shows the legacy "Worktrees unavailable" fallback in the tree. Recommended order: slice 01, then this slice.
- Deferred: templates and scaffolding, starter files, dependency installation, and creating the configured root on demand.

## Implementation evidence

Not implemented. The current Add Project flow is the only creation-adjacent path and rejects non-Git folders; see [slice 01 evidence](01-any-folder-projects.md#implementation-evidence).
