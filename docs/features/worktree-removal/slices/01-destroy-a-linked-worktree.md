# Slice 01: Destroy a linked worktree

## Status

Code complete and unit-tested. Contracts accepted as drafted on 2026-11-23;
rows-only placement confirmed the same day. The close-window gate cleared on
2026-11-23 (checklist reported complete by the user) and execution was authorized
then. The manual verification checklist below remains open.

## Outcome and scope

The user destroys a linked worktree and its branch from the Projects view or the
Command Palette. Uncommitted work is never discarded without an explicit, informed
choice. A participating window holding the worktree is closed first, safely. The
primary checkout is never a target.

Included: the Destroy Worktree command on linked checkout rows and the palette,
close-first through the window registry, loss pre-flight, explicit force, Git
worktree removal, and branch deletion with stage-named partial failure.

Excluded: the primary checkout, plain projects, saved-entry removal, remote-branch
deletion, automatic pruning or repair, unlocking locked worktrees, Windows, remote
folders.

## Proposal references

- [P-01](../proposal.md#p-01-destroy-removes-the-worktree-and-deletes-its-branch): remove then delete branch; detached is removal only.
- [P-02](../proposal.md#p-02-explicit-force-after-an-enumerated-loss-warning): three loss categories; default refuse; explicit Destroy Anyway.
- [P-03](../proposal.md#p-03-close-a-participating-window-holding-the-worktree-first): close-first; self-window and multi-root refusals.
- [P-04](../proposal.md#p-04-trust-and-execution-parity-with-creation): trust gates, identity revalidation, hardened Git, no Windows.
- [P-05](../proposal.md#p-05-ordering-concurrency-and-partial-failure): fixed order, claim-guard serialization, stage-named partial failure.
- [Close-window slice 01](../../close-window/slices/01-close-a-listed-window.md): the close mechanism this slice depends on.

## Behavior and contracts

Contribution (`package.json`, `src/projectsView.ts`):

1. Command: `{ "command": "projectSwitcher.destroyWorktree", "title": "Destroy Worktree",
   "category": "Projects", "icon": "$(trash)", "enablement": "isWorkspaceTrusted" }`.
2. `CheckoutItem.contextValue` becomes `checkoutPrimary` or `checkoutLinked`. The
   existing `view/item/context` clauses that use `viewItem == checkout` change to
   `viewItem =~ /^checkout/`; behavior of Open Here and Open in New Window is unchanged.
3. Menu: `view/item/context` with `view == projectSwitcher.projects && viewItem == checkoutLinked`,
   group `inline@3`. The action never appears on primary or plain rows, and no
   view-title entry is added; palette access comes from the command itself.
4. The palette picker lists linked (non-primary) worktrees of saved Git projects
   only. This resolves the proposal's open picker question.

Command flow (`src/projectCommands.ts`), in fixed order:

5. Gates before anything else: workspace trusted; not Windows; project trust
   confirmed with the same modal as creation; project identity captured and
   revalidated around each step via `assertProjectUnchanged`.
6. Target re-validation: re-run `listWorktrees(projectPath)` and match the
   porcelain record by path. Record gone: report the worktree no longer exists in
   Git and stop. `locked`: report the locked state and stop (unlocking stays
   manual). `prunable`: report the stale registration, suggest manual
   `git worktree prune`, and stop. Primary record: refuse (backstop; the menu
   already filters). Branch and detached state come from this fresh record.
7. Serialization: run the rest inside `registry.guard(worktreeIdentity, action)`.
   A busy guard reports the worktree is busy and stops before any Git mutation.
8. Close-first: `registry.find(worktreeIdentity)`. No record: continue. Record is
   this session: refuse and tell the user to run Destroy Worktree from another
   window. Record has multiple folders: refuse and tell the user to remove the
   folder from that workspace. Otherwise `registry.close(record)`; anything but
   `'closed'` aborts the destroy with the reported reason.
9. Loss pre-flight (re-run after the close step; new `src/gitWorktreeRemove.ts`):
   - One `git -C <worktree> status --porcelain=v1 -z --untracked-files=all`:
     `??` entries mean untracked files; any other entry means uncommitted changes.
   - Unmerged commits: `git rev-list <tip> --not <mainHEAD> [<upstream>]` from the
     main checkout, where tip is the branch ref or, for a detached HEAD, the
     worktree's HEAD oid. Upstream comes from `for-each-ref --format=%(upstream)`
     and is included only when it resolves locally. Non-empty output means
     unmerged commits.
10. Confirmation: no losses: one modal naming project, worktree path, and branch
    (detached: no branch line) with a Destroy Worktree button. Any loss category:
    one modal listing every detected category with Destroy Anyway and Cancel;
    canceling is the default refusal. Canceling any prompt changes nothing.
11. Execution: `git worktree remove [--force] -- <path>` from the main checkout,
    then `git branch -d|-D -- <branch>`; the branch step is skipped for detached
    HEAD. `--force`/`-D` only after an explicit Destroy Anyway. Branch names are
    revalidated with `check-ref-format --branch` before use.
12. Partial failure: a failed removal reports that nothing was removed and the
    branch was not touched. A failed branch deletion reports that the worktree was
    removed but the named branch still exists. Never retry silently; never roll
    back by recreating anything. The view refreshes after either outcome.

Git execution (`src/gitExec.ts`, `src/gitWorktreeRemove.ts`):

13. The hardened runner, environment, project-directory, and identity helpers move
    unchanged from `src/gitWorktreeCreate.ts` into new shared `src/gitExec.ts`;
    creation imports them. No behavior change; existing tests cover the move.
14. Removal operations join the error union; Git output and arguments stay out of
    errors, matching the no-output discipline. Timeouts: status and rev-list 15s,
    removal 120s, branch deletion 15s.

Registry (`src/windowRegistry.ts`):

15. New public `guard(identity, action)` wraps the existing `withGuard` primitive
    and returns the action result, or `undefined` when the guard is busy. Claim
    internals are unchanged.

## Acceptance criteria

- Given a linked checkout row, when the user opens its context menu, then Destroy
  Worktree is present; primary checkout, project, and plain rows never show it.
- Given the palette, when the user runs Destroy Worktree, then only linked
  worktrees of saved Git projects are offered.
- Given a clean worktree whose branch is merged, when the user confirms, then the
  worktree is removed and its branch deleted, and the view refreshes.
- Given any loss category, when the dialog appears, then it lists every detected
  category and proceeds only through Destroy Anyway.
- Given any prompt in the flow, when the user cancels, then no window closes, no
  file changes, and no Git mutation runs.
- Given a dirty worktree without force, when the flow runs, then nothing changes.
- Given a worktree open in the initiating window, when the user destroys from that
  window, then the flow refuses and says to run it from another window.
- Given a worktree in a multi-root window, when the user destroys it, then the
  flow refuses and says to remove the folder from that workspace.
- Given a worktree open in another participating window, when the user destroys
  it, then that window closes before any Git mutation; a failed or canceled close
  aborts the destroy.
- Given a detached-HEAD worktree, when the user confirms, then the worktree is
  removed and no branch operation runs.
- Given a locked worktree, when the user tries to destroy it, then the locked
  state is reported and nothing changes.
- Given a prunable registration, when the user tries to destroy it, then the
  stale state is explained with a `git worktree prune` hint and nothing changes.
- Given removal succeeds but branch deletion fails, when the flow ends, then the
  message names the stage and the surviving branch.
- Given two windows destroying the same worktree, when both try, then one reports
  the worktree is busy and no Git mutation runs twice.
- Given an untrusted workspace or Windows, when the user invokes the command,
  then the matching warning appears and nothing runs.

## Unit verification at implementation time

- Pre-flight parsing: dirty-only, untracked-only, unmerged-only, detached-tip, and
  clean fixtures each map to the contracted categories.
- Refusals: primary record, locked, prunable, missing record, self-window,
  multi-root, untrusted workspace, Windows.
- Outcomes: clean confirm, Destroy Anyway with each category, cancel at each
  prompt, close failure, still-open close, busy guard, removal failure, branch
  failure after successful removal, detached skip.
- Menu: primary and linked rows expose the contracted context values.

## Manual verification (blocking)

Run in an Extension Development Host or an installed VSIX after the
[close-window checklist](../../close-window/slices/01-close-a-listed-window.md#manual-verification-blocking)
passes; this slice's readiness stays blocked until then. Cover every acceptance
criterion, including the two refusal rules, the force dialog, and cross-window
closing. Record VS Code and macOS versions.

## Dependencies and blockers

- Blocking: the close-window manual checklist (B-09 delivery condition).
- Design: none. P-01 through P-05 and these contracts are accepted.
- Deferred: locked-worktree unlock, automatic prune, submodule detection detail,
  non-participating windows (documented limit), Windows support.

## Implementation evidence

Code complete (2026-11-23): `rtk npm run compile` clean, `rtk npm test` 178 pass /
0 fail (151 baseline + 27 new).

- New: `src/gitExec.ts` (hardened runner extracted unchanged), `src/gitWorktreeRemove.ts`
  (`inspectWorktreeLosses`, `removeWorktree`, `deleteBranch`, primary-checkout backstop),
  `src/test/gitWorktreeRemove.test.ts` (9 tests), `src/test/destroyWorktreeCommands.test.ts`
  (18 tests).
- Changed: `src/gitWorktreeCreate.ts` (imports `gitExec`, re-exports for compatibility),
  `src/windowRegistry.ts` (`guard()`), `src/projectCommands.ts` (`destroyWorktree`,
  linked-worktree picker), `src/projectsView.ts` (`checkoutPrimary`/`checkoutLinked`),
  `src/extension.ts` (registration), `package.json` (command, `checkoutLinked` menu,
  `viewItem =~ /^checkout/` clauses).

Unit-verified: all three loss categories and their parsing, clean flow, Destroy Anyway
with `--force`/`-D`, cancel-at-each-prompt, locked/prunable/missing refusals,
primary refusal, self-window and multi-root refusals, close-first ordering, failed
and still-open close aborts, busy guard, detached removal-only, and stage-named
branch-deletion failure. Extraction covered by the 151 pre-existing tests.

Unverified until the manual checklist runs in an Extension Development Host or
installed VSIX: menu wiring (including the `=~` when clause), real dialog flows,
cross-window closing against live windows, and palette behavior. Packaged and
installed as `project-switcher-0.5.0.vsix` in the default profile (2026-11-23, user
request); verification now happens live there. The slice stays short of ready until
those results are recorded.
