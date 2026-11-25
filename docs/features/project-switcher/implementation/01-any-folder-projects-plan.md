# Implementation plan: Slice 01 — Add any local folder as a project

## Source and status

- Target repository: `/Users/diogocoelho/repos/vscode-project-switcher`
- Slice: [01-any-folder-projects.md](../slices/01-any-folder-projects.md)
- Context: [overview](../overview.md), [proposal](../proposal.md); accepted decisions B-12, B-13 (plus referenced B-04, B-05, B-06, B-08, B-11, P-03, P-11).
- Plan approval: approved by the user on 15 November 2026, together with slice 02 scope.
- Execution authorization: granted by the user on 15 November 2026 ("Approve and implement"); verification limited to local compile/test commands (`rtk npm test`).

## Code evidence and assumptions

- Observed: [`projectCommands.ts`](../../../../src/projectCommands.ts) `add()` (lines 86–104) runs `listWorktrees` + `validatePrimaryCheckout` on every picked folder, rejecting plain folders.
- Observed: [`projectsView.ts`](../../../../src/projectsView.ts) `ProjectItem` always uses `contextValue = 'project'` and is always expandable; no Git/plain distinction.
- Observed: [`package.json`](../../../../package.json) menus use `viewItem == project`; Create Worktree shows for every project.
- Observed: `pickProject`/`pickCheckout` in `projectCommands.ts` are the palette entry points; `checkouts()` runs Git discovery per project.
- Observed: test pattern in [`src/test/createWorktreeCommands.test.ts`](../../../../src/test/createWorktreeCommands.test.ts): fake `vscode` module via `require` loader hook, real temp dirs, real Git with isolated `HOME`.
- Proposed new files: `src/projectKind.ts` (Git-entry detection), `src/test/plainProjects.test.ts`.
- Assumption: a `.git` symlink counts as a Git entry (lstat reports dir/file/symlink). Git itself follows it; treating it as plain would risk silently saving a Git folder as plain, which B-12 forbids. Broken `.git` symlinks classify as Git and surface the Git error, matching contract 2.

## Ordered steps

1. `src/projectKind.ts` (new): `hasGitEntry(folderPath)` — lstat `<folder>/.git`; true for directory/file/symlink; false on ENOENT/unavailable. Never throws.
2. `src/projectsView.ts`: add `git: boolean` to `ProjectEntry`; `ProjectItem` — plain = not expandable, `contextValue 'projectPlain'`, click opens via `projectSwitcher.select`; Git = `contextValue 'projectGit'`, expandable, unchanged otherwise.
3. `src/projectCommands.ts`:
   - `entries()`: derive `git` per record via `hasGitEntry`.
   - `add()`: no `.git` → save directly; `.git` → existing `listWorktrees`/`validatePrimaryCheckout`; Git failure surfaces its error and saves nothing.
   - `pickProject`: carry the full `ProjectEntry` on the pick item.
   - `createWorktree()`: after selection, a plain project gets the plain-language Git-requirement explanation before any Git call; trust/platform gates unchanged.
   - `pickCheckout()`: plain projects produce a single row (project name, no "Primary checkout" suffix, no Git call); the "Worktrees could not be loaded" warning applies only to Git projects.
4. `package.json`: Create Worktree `when` gated to `viewItem == projectGit`; Remove/Open Here/Open in New Window cover `projectGit || projectPlain` (and `checkout` where already present).
5. `src/test/plainProjects.test.ts` (new): coverage per the table below.

## Acceptance verification

| Criterion reference | Test or observable check | Environment and limits |
| --- | --- | --- |
| Plain folder added → sidebar/picker/open | test: add plain folder saves, no error; view item not expandable with open command; pickCheckout single row | node:test, tmpdir |
| Nested folder inside another repo saves as plain, no Git error | test: git repo outer, plain inner, add inner → saved, no error message | node:test, tmpdir, real Git |
| Linked worktree declined with main-checkout guidance | test: `git worktree add` linked tree → add → error shown, not saved | node:test, real Git; skip win32 |
| Plain sidebar item: no Create Worktree, no "Worktrees unavailable", click opens | test: ProjectItem context/collapsible/command; pickCheckout warning only for Git projects | node:test with fake vscode |
| Git project behavior unchanged | existing test suite (createWorktreeCommands, gitDiscovery, checkoutModel) stays green | `rtk npm test` |
| Palette Create Worktree on plain → explanation, no Git process | test: createWorktree() without item, pick plain → explanation message; store/Git untouched | node:test |
| Folder gains `.git` → flips to Git on refresh | test: entries() before/after `git init` in the folder | node:test, real Git |
| Folder loses `.git` → behaves as plain without errors | test: entries() before/after removing `.git` | node:test |
| Keyboard-only add/open/explanation | native dialog/quick pick/message only; manual check in Extension Development Host | manual; not run here |
| Plain entry persists across restart, dedupes per B-06 | existing sharedProjectStore tests (store format unchanged, no Git involvement) | `rtk npm test` |

## Blockers and deferred work

- Blocking: none.
- Deferred: slice 02 (separate plan); window-focus runtime verification remains open per the proposal.

## Execution evidence

Executed 15 November 2026 under the authorization recorded above.

Changes:

- New: [`src/projectKind.ts`](../../../../src/projectKind.ts) — `hasGitEntry` (lstat of `.git`; dir/file/symlink counts; never throws).
- New: [`src/test/plainProjects.test.ts`](../../../../src/test/plainProjects.test.ts) — 10 tests.
- Changed: [`src/projectsView.ts`](../../../../src/projectsView.ts) — `ProjectEntry.git`; `ProjectItem` is kind-aware (`projectGit`/`projectPlain` context values, plain = not expandable + open-on-click command); `getChildren` returns no children for a plain project without invoking checkout loading.
- Changed: [`src/projectCommands.ts`](../../../../src/projectCommands.ts) — `entries()` derives `git` per record; `add()` saves folders without `.git` directly and keeps Git validation (and Git-error surfacing) for folders with one; `pickProject` carries the full entry; `createWorktree()` explains the Git requirement for plain projects before any Git call; `pickCheckout()` renders a plain project as its own single row and reserves the worktrees warning for Git projects.
- Changed: [`package.json`](../../../../package.json) — Create Worktree gated to `viewItem == projectGit`; Remove/Open Here/Open in New Window cover both project kinds.

Verification:

- `rtk npm test` (compile + `node --test out/test/*.test.js`): 132 pass, 0 fail on 15 November 2026. This count includes the slice 02 tests executed later in the same session; the slice 01 state alone passed 120/120 (110 pre-existing + 10 new).
- `package.json` parsed and inspected via `node -e` after editing: settings, command, menus, and welcome content as expected.

Not verified here (manual, requires a live Extension Development Host): keyboard-only traversal; visual tree rendering; Create Worktree button presence/absence per item kind.
