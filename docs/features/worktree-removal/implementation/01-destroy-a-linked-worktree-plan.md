# Implementation plan: Destroy a linked worktree

## Source and status

- Target repository: `/Users/diogocoelho/repos/vscode-project-switcher/`
- Slice: [01-destroy-a-linked-worktree](../slices/01-destroy-a-linked-worktree.md) (contracts accepted 2026-11-23)
- Context: [overview](../overview.md), [proposal](../proposal.md); accepted P-01 through P-05; close-window P-01 through P-04 with [slice 01 evidence](../../close-window/slices/01-close-a-listed-window.md#implementation-evidence)
- Plan approval: approved 2026-11-23 ("Lets implmenet the destroy worktree part"), including rows-only placement
- Execution authorization: granted 2026-11-23 for the scoped steps below. The close-window manual checklist was reported complete by the user the same day, clearing the gate.

## Code evidence and assumptions

- Observed: hardened Git spawn, identity revalidation, `GitWorktreeError` in `src/gitWorktreeCreate.ts:39-128` (module-private; moves to `src/gitExec.ts`).
- Observed: porcelain parsing with `locked`/`prunable` fields in `src/gitDiscovery.ts`; `listWorktrees` revalidates the project root.
- Observed: `WindowRegistry.close()` (`src/windowRegistry.ts:298`), `find()` (`:250`), private `withGuard` (`:439`); `CloseError` reasons exported.
- Observed: `CheckoutItem.contextValue = 'checkout'` (`src/projectsView.ts:44`); menus use `viewItem == checkout` (`package.json:71-72`).
- Observed: trust modal and platform gate in `ProjectCommands.createWorktree` (`src/projectCommands.ts:218-235`); `assertProjectUnchanged` at `:358`.
- Observed: test harness fakes the `vscode` module and uses real Git fixtures in tmp dirs (`src/test/createWorktreeCommands.test.ts`, `src/test/closeWindow.test.ts`); `npm test` = compile + `node --test out/test/*.test.js`, 151 passing at planning time.
- New files (proposed): `src/gitExec.ts`, `src/gitWorktreeRemove.ts`, `src/test/gitWorktreeRemove.test.ts`, `src/test/destroyWorktreeCommands.test.ts`.
- Assumed: `git worktree remove` refuses the main worktree even when reached by path (backstop per P-01); `git branch -d` merged-check matches the pre-flight rev-list definition closely enough that divergence is rare (any divergence surfaces as a stage-named partial failure, which is the contracted behavior).

## Ordered steps

1. Extract `src/gitExec.ts` from `src/gitWorktreeCreate.ts` (runner, environment, project-directory, identity helpers, error classes, decode); update creation imports only. Check: `rtk npm run compile` and `rtk npm test` stay green (no behavior change). Slice contracts 13.
2. New `src/gitWorktreeRemove.ts`: `inspectWorktreeLosses(projectPath, worktreePath, branch|HEAD-oid, identity)`, `removeWorktree(projectPath, worktreePath, force, signal, identity)`, `deleteBranch(projectPath, branch, force, signal, identity)`; branch-name revalidation via `check-ref-format --branch`. Check: new `gitWorktreeRemove.test.ts` fixture tests for category mapping. Slice contracts 9, 11, 14.
3. `WindowRegistry.guard(identity, action)` public wrapper over `withGuard`. Check: registry test for busy/serialization behavior. Slice contract 15.
4. `ProjectCommands.destroyWorktree(item?)`: gates, re-validation by path match, guard, close-first, pre-flight, dialogs, execution, stage-named messages, refresh; private linked-worktree picker. Check: new `destroyWorktreeCommands.test.ts` flow tests with fake vscode + fake registry + real Git fixtures. Slice contracts 5-12.
5. `CheckoutItem` contextValue by `primary`; `package.json` command + `checkoutLinked` menu + `viewItem =~ /^checkout/` updates; register command in `src/extension.ts`. Check: compile; menu covered in command tests where reachable. Slice contracts 1-4.
6. Full verification: `rtk npm run compile`, `rtk npm test`. Manual/extension-host verification is deferred (see blockers).

## Acceptance verification

| Criterion reference | Test or observable check | Environment and limits |
| --- | --- | --- |
| Slice: pre-flight categories (contract 9) | `gitWorktreeRemove.test.ts`: dirty/untracked/unmerged/detached/clean fixtures | Real Git in tmp dir; no VS Code host |
| Slice: refusals (contracts 6, 8; P-03 rules) | `destroyWorktreeCommands.test.ts`: primary, locked, prunable, missing, self-window, multi-root, untrusted, win32 | Fake vscode + fake registry; win32 simulated via platform seam if needed, else code-level check |
| Slice: close-first ordering and abort (contract 8) | Fake registry records close-called-before-git flag; close failure and still-open aborts | Fake registry + real Git |
| Slice: dialogs and force (contracts 10-11) | Scripted answers: cancel at each prompt; Destroy Anyway per category; assert `--force`/`-D` and no-mutation-on-cancel via filesystem + branch state | Real Git fixtures |
| Slice: partial failure stage naming (contract 12) | Branch deletion forced to fail after successful removal; assert message and surviving branch; removal failure leaves tree and branch | Real Git fixtures |
| Slice: busy guard (contract 7) | Fake registry guard returns undefined; assert no Git calls | Fake registry |
| Slice: menu placement (contracts 1-3) | Context values asserted in view test; `package.json` inspected at compile/package time | Static check |
| Slice: acceptance criteria end-to-end | Manual checklist in Extension Development Host/VSIX | Blocking; deferred past close-window gate |

## Blockers and deferred work

- Blocking: close-window manual checklist (B-09 delivery condition); user decided on 2026-11-23 to verify close-window before any worktree-removal execution. Do not start steps 1-6 until execution authorization follows that verification.
- Blocking (ship only, not code): the slice's manual verification checklist.
- Deferred: locked-worktree unlock, automatic prune, submodule detection detail, Windows support, non-participating-window limit (documented in proposal).

## Execution evidence

Executed 2026-11-23 in the approved scope. All steps 1-6 completed.

- Changed files: `src/gitExec.ts` (new), `src/gitWorktreeRemove.ts` (new),
  `src/test/gitWorktreeRemove.test.ts` (new), `src/test/destroyWorktreeCommands.test.ts` (new),
  `src/gitWorktreeCreate.ts`, `src/windowRegistry.ts`, `src/projectCommands.ts`,
  `src/projectsView.ts`, `src/extension.ts`, `package.json`.
- Checks: `rtk npm run compile` clean after each step; `rtk npm test` 178 pass / 0 fail
  (151 baseline + 27 new). Extraction verified before step 2 with the full suite green.
- Skipped checks: the slice's manual checklist — packaged and installed as
  `project-switcher-0.5.0.vsix` (2026-11-23, user request); verification now happens
  live in the default profile.
- Remaining criteria: the manual runtime acceptance criteria only; all unit-mapped
  criteria pass. Risks: none newly discovered; the `=~` menu when-clause is unit-covered
  only by context-value assertions and needs the runtime check.
