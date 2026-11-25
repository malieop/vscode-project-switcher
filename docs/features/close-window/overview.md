# Feature: Close window

## Problem and desired outcomes

The user wants to close a VS Code window from the extension, not only focus windows.
Today the Open Windows view and picker only navigate. Closing requires switching to
the window first.

Success: the user closes any listed window from the Open Windows view. The correct
window closes. Unsaved edits stay under VS Code's control. The saved project entry
survives. A failed close never affects a different window.

## Scope and non-goals

- In scope: a close action on every Open Windows row, including the current window.
- In scope: a Command Palette close command with the window quick pick.
- In scope: a destination-addressed close request through the existing registry mailbox.
- In scope: sender-side confirmation by watching the target's registry record disappear.
- Out of scope: removing saved project entries. [B-09](../project-switcher/proposal.md#b-09-close-a-selected-window-separately-from-removing-a-project) keeps closing and removing separate.
- Out of scope: closing folders inside a window, quitting VS Code, or closing editors.
- Out of scope: force-save or discard. VS Code owns unsaved-change handling.
- Out of scope: remote windows. Registered folders are file-scheme only.

## System context and constraints

- Accepted behavior: [B-09](../project-switcher/proposal.md#b-09-close-a-selected-window-separately-from-removing-a-project)
  accepts closing a selected window, conditional on verified safe targeting. This
  feature designs the mechanism; the delivery condition still applies.
- Observed: the registry runs a destination-addressed, expiring request/reply mailbox
  for focus (`src/windowRegistry.ts:229-255`). The target instance executes
  `workbench.action.focusWindow` on itself.
- Observed upstream: `CloseWindowAction` (`workbench.action.closeWindow`) closes its
  executing window via `nativeHostService.closeWindow`. Same self-acting pattern as
  the verified focus action. Source:
  [upstream window actions](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/electron-browser/actions/windowActions.ts), inspected 2026-11-20.
- User fact (2026-11-20): the close action covers all windows, including the current one.
- Constraint: with default hot exit, VS Code preserves dirty editors silently as
  backups; the cancelable prompt appears only when hot exit is off. Both paths keep
  VS Code in charge of edits.
- Unknown: cross-version behavior of `workbench.action.closeWindow`. Verification
  required before slice readiness, per the B-09 delivery condition.

## Sources

- `src/windowRegistry.ts`: registry records, mailbox protocol, staleness, record removal on dispose.
- `src/windowsView.ts`: Open Windows rows, `windowCurrent` and `windowOther` context values.
- `src/extension.ts:51-75`: view wiring and visibility-gated refresh.
- [Baseline proposal B-09](../project-switcher/proposal.md#b-09-close-a-selected-window-separately-from-removing-a-project): accepted close behavior and delivery condition.
- [Open Windows proposal](../open-windows/proposal.md): the view that hosts the action.
- Upstream `CloseWindowAction` and `FocusWindowAction`: command IDs and self-acting behavior.
- User confirmations in the 2026-11-20 session: feature request and all-windows scope.

## Design and delivery

- [Proposal and agreement history](proposal.md)
- [Feature index](../README.md)
- [Slice 01: Close a listed window](slices/01-close-a-listed-window.md): code complete and unit-tested; manual runtime verification pending (blocking ship gate).
