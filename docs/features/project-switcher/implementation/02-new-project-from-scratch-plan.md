# Implementation plan: Slice 02 — Create a project folder from scratch

## Source and status

- Target repository: `/Users/diogocoelho/repos/vscode-project-switcher`
- Slice: [02-new-project-from-scratch.md](../slices/02-new-project-from-scratch.md)
- Context: [overview](../overview.md), [proposal](../proposal.md); accepted decision B-14 (plus referenced B-04, B-05, B-06, B-08, B-11, B-13, P-11). Soft dependency: slice 01 (implemented first under [01-any-folder-projects-plan.md](01-any-folder-projects-plan.md)).
- Plan approval: approved by the user on 15 November 2026.
- Execution authorization: granted by the user on 15 November 2026 ("Approve and implement"); verification limited to local compile/test commands (`rtk npm test`).

## Code evidence and assumptions

- Observed: no `newProject` command or `projectsDirectory` setting exists; grep over `src/` finds neither.
- Observed: `validDirectoryComponent` and `destinationExists` (lstat-based, catches broken symlinks) in [`worktreeDestination.ts`](../../../../src/worktreeDestination.ts) are reusable as-is.
- Observed: the hardened Git runner (`runGit`/`environment()` in [`gitWorktreeCreate.ts`](../../../../src/gitWorktreeCreate.ts)) is private; it strips `GIT_*` vars, disables credential prompts and hooks, and sets `GIT_CEILING_DIRECTORIES`. Plan: export a small `initializeRepository()` that reuses it, adding `'init'` to the operation union.
- Observed: store save and B-08 warning are `this.store.add()` + `reportStoreError()` in `projectCommands.ts`; the standard open flow is `this.select(uri)` (focus-if-open, else current/new choice, cancel leaves state unchanged).
- Observed: trust gating pattern = `enablement: isWorkspaceTrusted` in `package.json` plus a runtime `vscode.workspace.isTrusted` check in the command.
- Proposed new files: `src/test/newProjectCommands.test.ts`.
- Assumption: plain `git init` (no `-b`) under the user's own config satisfies "use the user's configured default branch"; the command imposes nothing.
- Assumption: on Windows `initializeRepository` reports `'unavailable'` (mirroring fetch/create, because process-group kill is unavailable); the command then follows the contract's git-failure path and saves the folder as plain.

## Ordered steps

1. `package.json`: add `projectSwitcher.projectsDirectory` (application scope, `ignoreSync`, default `/Users/diogocoelho/repos`); add `projectSwitcher.newProject` ("New Project", `$(new-folder)`, `enablement: isWorkspaceTrusted`); place it in `view/title` next to Add Project and add it to the empty-view welcome content.
2. `src/gitWorktreeCreate.ts`: add `'init'` to `GitWorktreeOperation`; export `initializeRepository(projectPath, signal?, expectedProjectIdentity?)` reusing `projectDirectory()` + `runGit()`.
3. `src/projectCommands.ts`: `newProject()` — runtime trust check → root validation (non-empty, absolute, existing directory; error names `projectSwitcher.projectsDirectory`; never create the root) → name loop (`validDirectoryComponent`, guidance + retry, cancel stops) → collision check via `destinationExists` (warn + re-ask; never adopt/overwrite) → `fs.mkdir` default permissions (failure: report, save nothing) → lstat identity capture → "Initialize a Git repository?" modal with **No** first (default) and cancel-counts-as-No → on Yes, `initializeRepository`; on failure keep the folder, report the failed stage, continue as plain → `store.add()`; on failure apply B-08 (modal warning with known paths; folder kept; no open) → `view.refresh()` → `select()` for the standard B-05/P-11 open flow.
4. `src/extension.ts`: register `projectSwitcher.newProject`.
5. `src/test/newProjectCommands.test.ts` (new): coverage per the table below.

## Acceptance verification

| Criterion reference | Test or observable check | Environment and limits |
| --- | --- | --- |
| Happy path: folder exists, entry saved, window choice appears | test: valid name + existing root → mkdir, store.add called with file URI, select invoked | node:test, tmpdir |
| Invalid name rejected with guidance; nothing created | test: `bad/name` then valid → guidance message, only the valid folder created | node:test |
| Existing name → re-ask; existing item untouched | test: pre-created file `taken`; choose `taken` then `free` → warning, `taken` still a file, `free` created | node:test |
| "Yes" at Git prompt → checkout grouping and Create Worktree after refresh | test: `.git` appears and entry saved; tree grouping/Create Worktree gating verified by slice 01 tests over `entries()`; end-to-end tree rendering manual | node:test, real Git + manual EDH |
| "No" or cancel at Git prompt → plain project | test: both answers → no `.git`, saved | node:test |
| Failed `git init` → folder kept, stage reported, saved as plain | test: `PATH` emptied so spawn fails → warning names Git initialization, folder on disk, store saved, no `.git` | node:test |
| Store save failure → B-08 warning with known paths, folder remains | test: store.add throws ProjectStoreError(knownProjects) → modal warning lists known path; folder on disk; select not called | node:test |
| Missing/invalid root → error names setting, nothing created | test: empty, relative, nonexistent, and file roots | node:test |
| Untrusted workspace → command unavailable with trust explanation | static `enablement` + test: `isTrusted=false` → trust warning, nothing created | node:test + package.json |
| Cancel at name prompt → nothing created or saved | test: input undefined → no mkdir, no store calls | node:test |
| Window choice canceled after save → entry remains | test: stub select → 'cancelled'; store record retained, no error | node:test |
| Keyboard-only: every prompt reachable | native input box/modal/quick pick only; manual check | manual; not run here |

## Blockers and deferred work

- Blocking: none.
- Deferred per slice: templates/scaffolding, starter files, dependency installation, creating the configured root on demand.

## Execution evidence

Executed 15 November 2026 under the authorization recorded above.

Changes:

- Changed: [`package.json`](../../../../package.json) — `projectSwitcher.projectsDirectory` setting (application scope, `ignoreSync`, default `/Users/diogocoelho/repos`); `projectSwitcher.newProject` command with `enablement: isWorkspaceTrusted`; view/title placement next to Add Project; empty-view welcome link.
- Changed: [`src/gitWorktreeCreate.ts`](../../../../src/gitWorktreeCreate.ts) — `'init'` operation and exported `initializeRepository()` reusing the hardened runner (`GIT_*` stripped, no credential prompts, hooks disabled, ceiling set); plain `git init` so the user's configured default branch applies; `'unavailable'` on Windows.
- Changed: [`src/projectCommands.ts`](../../../../src/projectCommands.ts) — `newProject()` with runtime trust check, root validation naming the setting (never creates the root), `validDirectoryComponent` name loop with retry guidance and cancel-stops, lstat-based collision re-ask, plain `fs.mkdir` with post-create identity capture, modal "Initialize a Git repository?" with **No** as default and cancel-counts-as-No, stage-exact failure reports (creation / Git init / store save), B-08 store-failure handling that keeps the folder, then the standard `select()` open flow.
- Changed: [`src/extension.ts`](../../../../src/extension.ts) — `projectSwitcher.newProject` registered.
- New: [`src/test/newProjectCommands.test.ts`](../../../../src/test/newProjectCommands.test.ts) — 12 tests.

Verification:

- `rtk npm test` (compile + `node --test out/test/*.test.js`): 132 pass, 0 fail on 15 November 2026 (120 prior + 12 new).
- `package.json` parsed and inspected via `node -e` after editing: new setting, command with trust enablement, view/title order `add → newProject → switch`, and two-line welcome content confirmed.
- The failed-`git init` test forces the failure with an empty `PATH` (spawn `ENOENT` → `GitWorktreeError('init','unavailable')`), then asserts the folder is kept, the stage is reported, and the project saves as plain.

Not verified here (manual, requires a live Extension Development Host): the Git-initialized project showing checkout grouping and Create Worktree after a refresh (unit-covered via slice 01's kind-derivation tests, not end-to-end); keyboard-only traversal; the disabled command's rendering in an untrusted window.
