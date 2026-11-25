# Feature: Project worktrees with OpenCode

## Requirements review in progress

- The user wants to add local Git project paths to the extension. Superseded by [B-12](../project-switcher/proposal.md#b-12-a-project-is-any-local-folder-git-is-optional): any local folder can be a project; worktree features remain Git-only per [B-13](../project-switcher/proposal.md#b-13-worktree-actions-appear-only-for-git-projects).
- Each project path identifies the primary checkout, even when its branch changes.
- The user wants multiple worktrees per project and a configurable shared parent directory.
- The user wants to open the primary checkout or a worktree in VS Code.
- If that location is already open, the user wants to focus its window.
- Start OpenCode when opening a window. If the location is already open, only focus its window.
- When switching the current window to a checkout, start OpenCode there if technically possible.
- The user confirmed `/Users/diogocoelho/repos/worktrees` as the initial configurable shared parent.
- The user wants organized directories to identify worktrees and choose which one to open.
- Organize new worktrees as `<parent>/<project>/<branch-derived-name>`; preview the path and avoid collisions.
- Show each project's primary checkout and worktrees in a submenu, not branches without checkouts.
- Include linked worktrees outside the shared parent where technically possible.
- Fetch automatically after project trust is confirmed. Explain failure and offer local branches.
- Prefer `origin/main`, then `origin/master`; ask when multiple remotes make the choice ambiguous.
- Keep the current/new window choice, but improve its user experience.
- If destination identification is unsafe, silently skip automatic OpenCode launch.
- Require project trust before fetch/create and destination Workspace Trust before launch.
- Use a private local saved-project file shared across profiles; migrate existing paths and coordinate edits.
- Storage mechanics, naming, discovery, trust binding, launch routing, and window coverage remain open.

## Problem and desired outcomes

The user wants to create a Git worktree from a saved project and open it in a dedicated VS Code window. Start OpenCode only when the destination is safely identified and trusted; otherwise skip silently. Focusing an existing window never starts OpenCode.

The user also wants a project-aware list of already-open VS Code windows, with click and keyboard navigation to an existing window rather than opening a duplicate.

Success means the original checkout/window stays available while a separate worktree can be used for development. Worktrees should use the user's existing shared worktrees directory.

## Scope and non-goals

- Requested scope: worktree creation from saved local Git projects and OpenCode launch when opening a window.
- Accepted interface choices: OpenCode in the VS Code integrated terminal; new worktrees open in a new window rooted at the worktree directory.
- Initial configurable destination root: `/Users/diogocoelho/repos/worktrees`.
- Accepted open-window direction: participating local project windows across profiles where technically possible. Share only metadata needed for window discovery. Cross-profile discovery is implemented via the shared registry root (see [cross-profile-windows](../cross-profile-windows/overview.md), 2026-11-20); its runtime verification, transport, and focus remain unverified.
- Accepted creation direction: create a new branch from a user-selected branch; suggest the project's remote `main` or `master`.
- Proposed initial scope: destination preview, saved worktree entries, and recoverable creation/opening failures.
- Deferred: worktree deletion/migration, environment copying, setup scripts, remote development, OpenCode restoration, and automatic profile inheritance.
- If a project profile is supported and known, prefer it; otherwise let VS Code decide. No inheritance guarantee is accepted.
- The [baseline](../project-switcher/overview.md) focuses already-open projects and offers a window choice for unopened projects. A separate action to close a selected window without removing its saved entry is conditional on safe, reliable targeted closing being verified. Worktree creation remains a separate new-window flow.

## System context and constraints

- Documented intent, not implementation: the [baseline proposal](../project-switcher/proposal.md) accepts local folders and [shared private persistence](../project-switcher/proposal.md#b-11-shared-private-saved-project-store). Detailed storage contracts remain open.
- Observed project state: worktree discovery, creation, and shared storage now have implementations and automated tests. Automatic OpenCode launch remains unavailable under the accepted safe-skip rule.
- Observed shared root: it exists and contains both project-named and UUID-named directories. Only top-level names were inspected; their ownership and internal layouts are unknown. Existing directories must remain untouched.
- A destination window must activate the extension before it can launch a terminal there. Cross-window launch routing, cancellation, and duplicate prevention need detailed design.
- The user approved the implementation plan and execution. This design role does not implement or create a worktree.

## Sources

- [Consolidated baseline overview](../project-switcher/overview.md) and [proposal](../project-switcher/proposal.md): baseline scope, technical defaults, acceptance criteria, and window/lifecycle constraints. These contain the design content formerly available only in the unchanged root implementation plan; the root file is retained as a historical source, not a required linked implementation specification.
- User confirmations in this design session: integrated terminal, new window for the worktree location, and the shared root path above. User also authorized saving this design.
- Read-only directory inspection of the target and shared worktrees root during this session: limited filesystem evidence described above.
- [Git worktree manual](https://git-scm.com/docs/git-worktree): creation, branch conflicts, linked checkout semantics, and safeguards.
- [Git fetch manual](https://git-scm.com/docs/git-fetch#_description): remote access and remote-tracking ref updates.
- [VS Code Workspace Trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust#workspace-trust-api): trust state applies to the current workspace.
- [OpenCode V2 CLI](https://opencode.ai/v2/docs/cli): interactive launch in a selected project directory.
- [VS Code API](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions): terminal creation interface.
- [VS Code window actions source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/electron-browser/actions/windowActions.ts), `BaseSwitchWindow`, `SwitchWindowAction`, and `FocusWindowAction`: native picker internals and self-window focus action. Inspected upstream `main`, not a pinned supported release or the user's installed version; no runtime validation performed.

## Design and delivery

- [Proposal and agreement history](proposal.md)
- [Feature index](../README.md) and [baseline switching design](../project-switcher/overview.md)
- [Draft first slice](slices/01-project-worktrees.md): proposed scope and blockers; not ready for handoff.
