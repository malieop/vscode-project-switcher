# Slice 01: Shared registry root

## Status

In progress

## Outcome and scope

A window opened in any VS Code profile appears in every profile's Open Windows view.
Switching to a project focuses its existing window even across profiles.

Included: the registry root move and its cross-profile consequences.
Excluded: cross-machine, remote windows, legacy cleanup, record format changes.
See [overview](../overview.md#scope-and-non-goals).

## Proposal references

- [P-01](../proposal.md#p-01-registry-root-moves-to-the-shared-home-dir-location): shared root.
- [P-02](../proposal.md#p-02-all-registry-consumers-become-cross-profile): all consumers.
- [P-03](../proposal.md#p-03-legacy-profile-scoped-registry-dirs-are-left-untouched): no migration.

## Behavior and contracts

- `src/extension.ts`: one shared root (`~/.vscode-project-switcher`) feeds
  `SharedProjectStore` and `WindowRegistry`. The registry still composes
  `window-registry-v1` under it.
- `src/windowRegistry.ts`: unchanged. Record version 1, focus protocol version 2, and
  claim version 1 contracts are untouched.
- Mixed-version transition: old and new windows write to different roots and simply do
  not see each other until reloaded. No error surfaces.

## Acceptance criteria

- Given windows in two profiles on 0.3.0, when either opens the Open Windows view, then
  both windows appear. (Runtime; deferred to manual check.)
- Given a project open in profile B, when the user switches to it from profile A, then
  its window is focused instead of a duplicate. (Runtime; deferred.)
- Given a mix of 0.2.0 and 0.3.0 windows, when either lists windows, then each sees only
  same-location writers and no error occurs. (Runtime; deferred.)
- Given the code change, when `npm test` runs, then the suite stays green including the
  registry root composition test. (Verified 2026-11-20: 143 pass, 0 fail.)

## Dependencies and blockers

- None blocking. Deferred: the three runtime criteria above; user performs them with the
  [open-windows manual checklist](../../open-windows/slices/01-open-windows-view.md#manual-verification-deferred-user-run)
  extended to a second profile.

## Implementation evidence

Implemented 2026-11-20. Changed: `src/extension.ts` (shared root wiring),
`package.json` (0.3.0), `src/test/windowRegistry.test.ts` (root composition test).
Verified: compile clean; 143/143 tests pass. Packaged and installed as 0.3.0.
Runtime criteria pending manual verification.
