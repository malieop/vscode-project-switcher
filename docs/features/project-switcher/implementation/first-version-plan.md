# First version implementation plan

## Status and scope

- Approved for first-version implementation. Extension code now exists; verification and readiness remain incomplete.
- Historical plan: [B-11](../proposal.md#b-11-shared-private-saved-project-store) supersedes its profile-local and single-window storage directions.
- Use the accepted [baseline](../proposal.md) and [window navigation](../../project-worktrees/proposal.md).
- The user confirmed the shared local registry direction for the first version.
- This confirmation does not accept every P-08 transport or recovery detail.
- Defer window closing unless safe, reliable targeted closing is verified.
- The original plan deferred custom aliases, worktrees, OpenCode, and concurrent saved-project edits.
- No detailed B-10 baseline slice exists. The separate worktree slice remains blocked.
- Window discovery, focus, crash recovery, and duplicate prevention remain partially verified.

## Proposed changes

These steps describe the original plan, not the current state or the B-11 migration plan.

1. Add `package.json`, `tsconfig.json`, `.vscodeignore`, and `.gitignore`.
   Configure strict TypeScript, VS Code 1.144.1, tests, and local VSIX packaging.
2. Add `src/projectStore.ts` and `src/folderIdentity.ts`.
   Persist versioned profile-local folder URIs, serialize edits, and preserve confirmed state on failure.
   Match filesystem identity without merging distinct folders. Keep unavailable entries until removed.
3. Add `src/windowRegistry.ts` and `src/windowFocus.ts`.
   Register local sessions across profiles using minimal private metadata and bounded focus requests.
   Validate records, expire stale sessions, and fail safely on registry or focus errors.
4. Add `src/projectCommands.ts`, `src/projectsView.ts`, and `src/extension.ts`.
   Provide accessible add, remove, sidebar, and search actions with one switching handler.
   Focus open projects; otherwise offer current-window, new-window, or cancellation choices.
   Refresh on activation and immediately before opening.
5. Add `media/projects.svg`, `README.md`, and development configuration under `.vscode/`.
   Document profile-local lists, participating-window coverage, limitations, and installation.
6. Add tests under `src/test/` for storage, identity, registry, commands, and errors.

## Safety and dependencies

- Define registry schemas, expiry, races, and recovery before implementing affected paths.
- Coordinate simultaneous opens by folder identity; fail safely when ownership is uncertain.
- Never assume a focus acknowledgement proves the operating system foreground changed.
- Offer VS Code's native picker if discovery or direct focus is unavailable.
- Do not automatically delete unavailable entries or modify project directories.
- Do not force-save or discard unsaved edits.
- Do not initialize Git or install a VSIX without separate permission.
- Save required design decisions and a detailed slice before claiming implementation readiness.

## Verification

- Test add, deduplication, remove, search, cancellation, and unavailable folders.
- Test persistence, failed writes, invalid records, and distinct case-sensitive folders.
- Test registry lifecycle, validation, expired sessions, focus requests, and failure fallback.
- Test simultaneous-open coordination, stale requests, and cross-profile registry visibility.
- Test current-window and new-window choices without closing unrelated windows.
- Run compilation, automated tests, and local package creation after implementation.
- Report visual checks as unverified unless completed. Do not install a desktop driver.
- Do not claim release readiness while required behavior remains unverified.
