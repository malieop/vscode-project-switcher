# Feature: Cross-profile window discovery

## Problem and desired outcomes

The window registry lived in profile-scoped storage, so each VS Code profile saw only
its own windows. The [worktrees overview](../project-worktrees/overview.md) had already
accepted cross-profile participation as the direction; the implementation never achieved it.

Success: a window opened in any profile appears in every profile's Open Windows view,
and switching to a project focuses its window even when it belongs to another profile.

## Scope and non-goals

- In scope: moving the registry root to `~/.vscode-project-switcher/window-registry-v1`.
- In scope: all registry consumers become cross-profile (view, picker, switch dedup).
- Out of scope: cross-machine discovery, remote windows, legacy directory cleanup.
- Out of scope: record format changes. Records, requests, replies, and claims keep their
  existing versions and validation.

## System context and constraints

- Observed: the shared project store already uses `~/.vscode-project-switcher`
  (`src/extension.ts`), accepted under
  [B-11](../project-switcher/proposal.md#b-11-shared-private-saved-project-store).
- Observed: the registry was constructed with `context.globalStorageUri.fsPath`, which is
  profile-scoped. That made cross-profile discovery impossible.
- Observed: the registry already handles many concurrent writers (atomic renames,
  per-session files, guarded claims). Cross-profile adds more writers of the same kind.
- Observed: registry contents are ephemeral. Stale records expire after 15s.
- User fact (2026-11-20): the user wants windows visible across all their profiles
  (six profile directories observed on disk, names unverified).

## Sources

- `src/windowRegistry.ts`: registry mechanics, heartbeat, staleness, focus protocol.
- `src/extension.ts`: store and registry construction (before: profile-scoped root).
- [Worktrees overview](../project-worktrees/overview.md): accepted cross-profile direction.
- [Open Windows proposal](../open-windows/proposal.md): carried cross-profile visibility
  as an open question; this feature resolves it.
- User confirmation 2026-11-20: accepted P-01–P-03 and authorized implementation,
  packaging, and installation.

## Design and delivery

- [Proposal and agreement history](proposal.md)
- [Slice 01: Shared registry root](slices/01-shared-registry-root.md): implemented and
  unit-verified; runtime cross-profile check pending.
- [Feature index](../README.md)
