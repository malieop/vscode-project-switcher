# Feature: Open Windows view

## Problem and desired outcomes

The extension already tracks live VS Code windows, but shows them only in a transient
command-palette picker. The user wants a persistent way to see which windows are open.

Success: the sidebar always shows the live windows running this extension. Clicking a
window focuses it. The list follows windows opening and closing without a manual refresh.

## Scope and non-goals

- In scope: a dedicated "Open Windows" sidebar tree view in the existing Projects container.
- In scope: all participating windows, including windows whose folder is not a saved project.
- In scope: click-to-focus through the existing registry focus protocol.
- Out of scope: closing windows. Realized separately by the [close-window feature](../close-window/overview.md) (2026-11-20), which adds a close action to this view's rows.
- Out of scope: "Open" badges in the Projects tree. Possible follow-up, not part of this feature.
- Out of scope: real window titles. The registry records folders, not titles.
- Out of scope: remote windows. `currentWindowFolders` supports file-scheme folders only
  (`src/projectCommands.ts:25-32`).

## System context and constraints

- Observed: every window running the extension publishes a heartbeat record to a local
  file registry (`src/windowRegistry.ts:116-170`). Heartbeat every 3s; records stale after 15s.
- Observed: `WindowRegistry.list()` returns all records; the existing picker filters to
  records updated within 15s (`src/projectCommands.ts:433-459`).
- Observed: the registry stores per-window session id, pid, and folder list
  (uri plus device:inode identity). No window title is recorded.
- Observed: the existing "Switch to Open Project Window" command
  (`projectSwitcher.openWindows`, `package.json:48`) lists the same data in a quick pick.
  It stays unchanged.
- Observed: the sidebar contributes one container with one view today
  (`package.json:50-55`). The new view joins the same container.
- Observed: window focus already triggers a registry update and view refresh
  (`src/extension.ts:59-64`).
- User fact (this session): the user chose a dedicated sidebar view over badges or a
  surfaced picker, and chose to list all live windows.
- Unknown: whether the registry is visible across VS Code profiles. It lives under
  `context.globalStorageUri.fsPath` (`src/extension.ts:14`). The
  [worktrees overview](../project-worktrees/overview.md) already labels cross-profile
  discovery unverified.

## Sources

- `src/windowRegistry.ts`: registry records, heartbeat, staleness, `list()`, `focus()`.
- `src/projectCommands.ts:433-459`: existing open-windows picker and its staleness filter.
- `src/projectCommands.ts:25-32`: registered folders are file-scheme only.
- `src/extension.ts:12-68`: registry wiring, view registration, focus-driven refresh.
- `package.json:40-71`: existing commands, container, view, and menu contributions.
- [Worktrees overview](../project-worktrees/overview.md): accepted open-window direction and
  the project-aware window-list intent this feature completes.
- User confirmations in the 2026-11-15/16 design session: sidebar view form, all-window
  scope, and acceptance of P-01 through P-06. The user authorized saving this design.

## Design and delivery

- [Proposal and agreement history](proposal.md)
- [Feature index](../README.md)
- [Slice 01: Persistent Open Windows view](slices/01-open-windows-view.md): implemented and unit-tested; manual runtime verification pending.
