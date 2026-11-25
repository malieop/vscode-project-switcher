# Proposal: Cross-profile window discovery

## Status

Accepted

All three decisions were explicitly accepted by the user on 2026-11-20, together with
implementation, packaging, and installation authorization.

## Proposed approach

Move the window registry root into the shared home-dir location already used by the
saved-project store. One wiring change in `extension.ts`; no registry internals change.

### P-01: Registry root moves to the shared home-dir location

- Status: accepted
- Approach: construct `WindowRegistry` with `~/.vscode-project-switcher`; the registry
  composes `window-registry-v1` under it. The same root already serves the project store.
- Context and evidence: profile-scoped `globalStorageUri` made cross-profile discovery
  impossible; [B-11](../project-switcher/proposal.md#b-11-shared-private-saved-project-store)
  accepted the shared location for exactly this class of data.
- Alternatives and tradeoffs: aggregate per-profile registries by enumerating profile
  directories — fragile, and profile discovery has no supported API. Rejected.
- Consequences: windows in all profiles publish to one registry. Same permissions model
  (0o700 directories, 0o600 files); the metadata shared is what the worktrees overview
  pre-accepted sharing.
- Confirmation: user accepted P-01–P-03 (2026-11-20).

### P-02: All registry consumers become cross-profile

- Status: accepted
- Approach: no code distinction between same-profile and other-profile windows.
- Context and evidence: the Open Windows view, the picker, and switch dedup
  (`find`/`focus`/`claim`) all read the same registry.
- Alternatives and tradeoffs: restricting dedup to same-profile windows would contradict
  the accepted worktrees direction and add special-casing.
- Consequences: "Switch Project"/"Open Here" may focus a window in another profile
  instead of opening a duplicate. Intended; matches the accepted direction.
- Confirmation: user accepted P-01–P-03 (2026-11-20).

### P-03: Legacy profile-scoped registry dirs are left untouched

- Status: accepted
- Approach: no migration and no cleanup code. Legacy contents are ephemeral; records
  self-expire 15s after old-version windows reload or close.
- Context and evidence: nothing durable lives in the registry; the format is unchanged.
- Alternatives and tradeoffs: deleting legacy dirs at activation risks breaking
  not-yet-reloaded old-version windows mid-transition. Rejected for near-zero benefit.
- Consequences: mixed 0.2.0/0.3.0 windows see only same-location writers until reloaded.
  No crashes; converges on reload. "Apply Extension to all Profiles" propagates 0.3.0.
- Confirmation: user accepted P-01–P-03 (2026-11-20).

## Open questions and assumptions

- Cross-profile focus (`workbench.action.focusWindow` via file transport) is
  profile-agnostic by design but unverified at runtime. Non-blocking; deferred to the
  user's manual check.
- Assumption: all profiles belong to the same OS user and share the home directory.

## Agreement and change history

| Event | Item | Confirmation and rationale | Impact |
| --- | --- | --- | --- |
| 2026-11-20 session | P-01–P-03 | User accepted the design and authorized implementation, packaging, installation. | Slice 01. |

## Implementation evidence

Implemented 2026-11-20. `src/extension.ts` computes the shared root once and passes it
to both `SharedProjectStore` and `WindowRegistry`; `src/windowRegistry.ts` unchanged.
Version bumped to 0.3.0. Verified: `npm run compile` clean; `npm test` 143 pass / 0 fail
(1 new test pinning the registry root composition). Packaged and installed as
`project-switcher-0.3.0.vsix` via `code --install-extension` (reported success).
Runtime cross-profile visibility and focus remain unverified; deferred to manual check
with the user's consent, matching the open-windows slice precedent.
