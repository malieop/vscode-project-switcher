# Slice 01: Persistent Open Windows view

## Status

In progress

## Outcome and scope

The user opens the Projects sidebar and always sees which VS Code windows are open.
Clicking a window focuses it. The list updates by itself as windows open and close.

Included: the "Open Windows" tree view, window rows with folder children, click-to-focus,
visibility-gated refresh, and error/empty states.

Excluded: closing windows, badges in the Projects tree, window titles, remote windows,
cross-profile verification. See [overview](../overview.md#scope-and-non-goals).

## Proposal references

- [P-01](../proposal.md#p-01-dedicated-open-windows-tree-view): dedicated tree view.
- [P-02](../proposal.md#p-02-one-row-per-window-folders-as-children): window rows, folder children.
- [P-03](../proposal.md#p-03-click-focuses-the-window): click-to-focus via `registry.focus`.
- [P-04](../proposal.md#p-04-refresh-every-3s-only-while-visible-plus-on-window-focus): refresh cadence.
- [P-05](../proposal.md#p-05-list-all-participating-windows): all windows, no store coupling.
- [P-06](../proposal.md#p-06-mirror-the-projects-views-empty-and-error-states): message-row error state.

## Behavior and contracts

Contribution (`package.json`):

- Add `{ "id": "projectSwitcher.windows", "name": "Open Windows" }` to
  `views.projectSwitcher`, beside the existing Projects view (`package.json:53-55`).

Provider (new file, `src/windowsView.ts` proposed):

- Implements `vscode.TreeDataProvider` over window rows, folder children, and a message row.
- Data: `registry.list()`, keep records with `Date.now() - updatedAt <= 15_000`, matching
  the picker filter (`src/projectCommands.ts:436`).
- Window row: label = basename of the first folder's path (fallback: full path);
  description = parent path plus "· Current window" when `record.id === sessionId`;
  tooltip = full folder paths; `contextValue` distinguishes current vs other for future
  menus. Collapsible only when the record has multiple folders.
- Folder child row: label = basename, description = full path.
- Ordering: current window first, then by first-folder path. Stable order prevents rows
  jumping between refreshes.
- Registry failure (`list()` throws): one warning message row, matching the Projects
  view's `MessageItem` pattern (`src/projectsView.ts:56-62`).
- Empty (registry not yet started at activation): empty list, no error.

Focus command:

- Internal command (proposed id `projectSwitcher.focusWindow`) registered in code only,
  like `projectSwitcher.select` (`src/extension.ts:54`); no `package.json` command entry,
  so it does not clutter the command palette.
- Calls `registry.focus(record, identity)` with the clicked row's record and folder
  identity (`src/windowRegistry.ts:229-255`). Errors surface via the existing
  error-message pattern used by `openWindows` (`src/projectCommands.ts:458`).

Refresh:

- Register via `vscode.window.createTreeView` (not `registerTreeDataProvider`) so
  visibility is observable. Poll `list()` every ~3s only while the view is visible;
  clear the timer when hidden and on dispose.
- The existing window-focus hook (`src/extension.ts:59-64`) also refreshes this view.

## Acceptance criteria

- Given two windows running the extension, when the user opens the Projects sidebar,
  then the Open Windows view lists both, marking the current one "· Current window".
- Given a window on a folder that is not a saved project, when the view refreshes,
  then that window appears in the list.
- Given another window's row, when the user clicks it, then that window gains focus.
- Given a multi-root window, when the user expands its row, then one child per folder
  appears; clicking a child focuses that window.
- Given a window closes, when its record goes stale, then its row disappears within one
  refresh interval after the 15s staleness window.
- Given the registry fails, when the view loads, then a warning message row appears and
  no unhandled error occurs.
- Given the view is hidden, when time passes, then no registry reads occur.
- Given keyboard or screen-reader use, when rows are inspected, then each exposes its
  label, path, and current state via `accessibilityInformation`, and row activation
  focuses the window.
- Given a window dies between refresh and click, when the user clicks its row, then an
  error message says the window is unavailable.

## Manual verification (deferred, user-run)

Start an Extension Development Host: open this repository in VS Code and press F5.
Alternatively run `npm run package` and install the new VSIX first.

- Given the dev host window, when you open the Projects sidebar, then "Open Windows"
  lists this window marked "· Current window". (Criteria 1-2)
- Given a second window with the extension on any folder, when you wait ~3s, then it
  appears in the first window's list, even if unsaved. (Criterion 2)
- Given both windows, when you click the other window's row, then that window gains
  focus. (Criterion 3)
- Given a multi-root workspace window, when you expand its row, then each folder child
  focuses that window. (Criterion 4)
- Given you close the second window, when ~18s pass, then its row disappears without a
  manual refresh. (Criterion 5)
- Given a second window is force-quit (`kill -9` its process), when you click its row
  within 15s, then an error message appears and no new window opens. (Criterion 9)
- Given VoiceOver, when you arrow through rows, then each announces label, path, and
  current state. (Criterion 8)

Criterion 7 (no registry reads while hidden) is code-inspected only
(`src/extension.ts` visibility-gated timer); no practical manual check exists.

## Dependencies and blockers

- None blocking. All required decisions (P-01 to P-06) are accepted; the registry and
  focus protocol exist with tests (`src/test/windowRegistry.test.ts`).
- Deferred: cross-profile registry visibility; same-name folder labels; real window
  titles. See [proposal open questions](../proposal.md#open-questions-and-assumptions).

## Implementation evidence

Partially implemented (2026-11-16). Code complete: `src/windowList.ts`,
`src/windowsView.ts`, `src/test/windowList.test.ts` (new); `src/extension.ts`,
`src/projectCommands.ts`, `src/windowRegistry.ts` (export only), `package.json` (updated).
Verified: `npm run compile` clean; `npm test` 142 pass, 0 fail, including 6 new
`windowList` tests covering staleness filtering, current marking, ordering, multi-root
folders, empty-window exclusion, and registry failure.

Unverified without a live VS Code window: click-to-focus wiring, multi-root expansion,
stale-row disappearance in the rendered view, no-reads-while-hidden (code-inspected
only), and screen-reader output. User accepted this verification level (2026-11-16);
runtime check remains available.
