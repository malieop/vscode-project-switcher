# Slice 01: Colored current window

## Status

In progress

Implemented and unit-tested 2026-11-23; manual runtime verification pending.

## Outcome and scope

The user glances at the Open Windows view and immediately sees which window
they are in, by color.

Included: a green-tinted window icon on the current row; other rows unchanged;
description text and accessibility labels unchanged.

Excluded: OpenCode attention badges ([slice 02 outline](../overview.md));
label text coloring via `FileDecorationProvider`; any registry, protocol, or
`package.json` change.

## Proposal references

- [P-01](../proposal.md#p-01-indicators-live-in-the-open-windows-view-only): indicators live in this view.
- [P-05](../proposal.md#p-05-current-window-shown-with-a-colored-icon-plus-text): colored icon plus text.
- [P-06](../proposal.md#p-06-two-slices--color-first-badges-second): this slice ships P-05 alone.

## Behavior and contracts

Icon selection (`src/windowList.ts`, kept free of vscode imports per its
header comment at `src/windowList.ts:15-18`):

- Add a pure helper `windowIcon(row: WindowRow): { id: string; colorId?: string }`.
- Returns `{ id: 'window', colorId: 'charts.green' }` when `row.current` is
  true; `{ id: 'window' }` otherwise.
- `charts.green` is a theme-contributed color id, so the tint follows the
  user's color theme without hardcoded values.

Rendering (`src/windowsView.ts`, `WindowItem`):

- Replace the fixed `new vscode.ThemeIcon('window')` (`src/windowsView.ts:17`)
  with the helper's result: `new vscode.ThemeIcon(icon.id, icon.colorId ? new
  vscode.ThemeColor(icon.colorId) : undefined)`.
- Description keeps the "· Current window" suffix (`src/windowsView.ts:15`);
  `accessibilityInformation` keeps its current-state wording
  (`src/windowsView.ts:20-22`). Color never carries the meaning alone (risk
  R4 in the [proposal](../proposal.md#risk-findings)).

No other files change. Refresh cadence, ordering, and focus commands are
untouched.

## Acceptance criteria

- Given two windows running the extension, when the Open Windows view renders,
  then the current window's row shows a green-tinted window icon and the other
  row shows the default untinted icon.
- Given the current row, when it renders, then its description still ends with
  "· Current window" and its accessibility label still announces the current
  state.
- Given the user switches focus to the other window, when the view refreshes,
  then the green tint moves to the newly current row within one refresh
  interval.
- Given any color theme, when the row renders, then the tint follows the
  theme's `charts.green` value and the text alone still identifies the current
  window.
- Given `npm test`, when the windowList tests run, then the icon helper is
  covered for current and non-current rows.

## Manual verification (deferred, user-run)

Start an Extension Development Host (F5) or install a freshly packaged VSIX.

- Given the dev host window, when you open the Open Windows view, then your
  window's row shows the green icon and "· Current window". (Criteria 1-2)
- Given a second window with the extension, when you switch focus between the
  two, then the green icon follows the focused window within a few seconds.
  (Criterion 3)
- Given a different color theme, when you reload, then the tint uses the
  theme's green and the text still marks the current row. (Criterion 4)

## Dependencies and blockers

- None blocking. P-01, P-05, and P-06 are accepted; the current-window flag
  and row rendering already exist with tests (`src/test/windowList.test.ts`).
- Deferred: label text coloring via `FileDecorationProvider` if the tinted
  icon proves too subtle in practice (P-05 alternatives).

## Implementation evidence

Implemented 2026-11-23. Changed: `src/windowList.ts` (new `windowIcon` helper),
`src/windowsView.ts` (`WindowItem` uses the helper), `src/test/windowList.test.ts`
(2 new tests). Verified: `npm run compile` clean; `npm test` 180 pass, 0 fail.
First run caught a test-authoring error (missing vs `undefined` `colorId` under
strict deepEqual); fixed in the test, no source change needed.

Packaged and installed 2026-11-23: `project-switcher-0.4.0.vsix` (24 files,
52.43 KB); `code --install-extension` succeeded; `code --list-extensions
--show-versions` reports `local.project-switcher@0.4.0`. The version field was
already 0.4.0 at packaging time (bumped outside this session). Running windows
keep 0.3.0 until reloaded.

Unverified without a live VS Code window: rendered green tint, tint following
focus between windows, and theme behavior. See the manual verification steps
above.
