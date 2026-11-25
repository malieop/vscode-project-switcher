# Feature: Saved project switching

## Problem and desired outcomes

Provide a local desktop VS Code extension that remembers manually added project folders and makes them easy to find and open from a dedicated sidebar or searchable quick picker.

If the selected project is already open, bring its window forward. Otherwise, ask whether to use the current window or open a new one. Saved projects remain available across switches and VS Code restarts. Removing a saved entry never deletes its directory or files.

## Scope and non-goals

Confirmed scope, including the later window-opening choices:

- Create a separate extension repository at `/Users/diogocoelho/repos/vscode-project-switcher/`.
- Add project folders manually through a folder picker. Any existing local folder can be a project; Git is optional (B-12).
- Create a project folder from scratch inside a configurable default root, with optional `git init` (B-14).
- Show worktree actions only for Git projects (B-13).
- Show saved projects in a dedicated sidebar.
- Provide a searchable quick picker for keyboard switching.
- Choose the current window or a new window for a project that is not already open.
- Focus the existing window when the project is already open.
- Treat different paths to the same folder as one project.
- Refresh the lists when returning to a window, and check open windows before opening a project.
- If saving fails, keep the confirmed list and show its paths in a warning.
- Display an unavailable saved folder and let the user remove its entry; do not delete it automatically.
- Provide an explicit action to close a selected VS Code window without removing its saved project entry, only if safe, reliable targeted closing can be verified; otherwise leave the action out. Removing a saved entry remains separate and does not close its window or delete project files.

Baseline boundaries accepted in B-02:

- Local desktop folders only; TypeScript and native VS Code APIs, without a webview or backend.
- Exclude automatic project discovery, remote folders, workspace-file entries, cross-device synchronization, and Marketplace publishing. B-11 adds local profile sharing.
- Do not promise preservation of terminals, tasks, or debug sessions across same-window switching.

## System context and constraints

- The root plan is historical and reports implementation not started. At initial inspection no application code existed; a partial first implementation now exists. See the [proposal](proposal.md#implementation-evidence-and-next-step) for current evidence and limits.
- [B-11](proposal.md#b-11-shared-private-saved-project-store) accepts a private local saved-project file shared across profiles. An implementation and tests exist; recovery and runtime checks remain open.
- Opening another folder in the current window shuts down its extension host. Complete persistence first, and let VS Code handle unsaved-change protection without force-saving or discarding edits.
- Native edit protection depends on VS Code settings and requires manual verification.
- B-11 replaces the earlier single-window edit limit. The shared store coordinates participating writers; old-version coexistence and ambiguous aliases remain unresolved.
- Finding, focusing, and closing an already-open window must be verified. Window discovery and saved-project storage are separate concerns.
- The target directory was reported as not a Git repository. A partial implementation exists; runtime validation remains incomplete.

## Sources and consolidation

- Consolidated from `vscode-project-switcher-plan.md` at the repository root, including Confirmed scope, Proposed implementation, Implementation steps, Verification and acceptance criteria, Risks and boundaries, and Evidence and approval. The root source remains unchanged; no rationale beyond that source is inferred.
- [VS Code built-in command contract](https://code.visualstudio.com/api/references/commands#commands): `vscode.openFolder` and explicit window options.
- User instruction “Add those to the current structure” authorized consolidation. The user later accepted B-01 through B-04, replaced their window-opening rule with B-05, and authorized recording these choices. None of these actions authorizes implementation.

## Design and delivery

- [Baseline proposal and acceptance criteria](proposal.md)
- [Slice 01: Add any local folder as a project](slices/01-any-folder-projects.md): ready; implements B-12 and B-13.
- [Slice 02: Create a project folder from scratch](slices/02-new-project-from-scratch.md): ready; implements B-14.
- [Worktrees, OpenCode, and open-window navigation](../project-worktrees/overview.md): additive design with separate agreement statuses.
- [Feature index](../README.md)
- The intended baseline outcome covers opening and replacing projects, plus conditional window closing. No detailed B-10 baseline slice exists; the separate worktree slice remains blocked.
