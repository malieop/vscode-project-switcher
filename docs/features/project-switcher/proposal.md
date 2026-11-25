# Proposal: Saved project switching

## Status

In discussion. B-11 replaces B-03; B-05 and P-11 change earlier window-opening rules. B-12 makes Git optional for saved projects; B-14 adds from-scratch creation and supersedes the B-05 existing-folders-only limit. The initial minimum is VS Code 1.144.1. The implementation is partial; window discovery and focus remain insufficiently verified. Closing another window is excluded.

## Approach and choices

Baseline IDs use `B-` to avoid collisions with the additions' `P-01`–`P-08`.

### B-01: Baseline scope and ordinary same-window switching

- Status: partially superseded by B-05. The saved-project scope remains accepted; the always-reuse window rule is historical.
- Original scope: separate extension repository at the target, manually added folders, dedicated sidebar, searchable quick picker, and replacing the current window's folder on project selection.
- Rationale: earlier rationale is not recorded in the source; do not infer it.
- Replacement: [B-05](#b-05-focus-open-projects-and-choose-where-to-open-others) changes ordinary project selection. The separate [worktree flow](../project-worktrees/proposal.md) remains in scope for later work.

### B-02: Native TypeScript extension and local-only baseline

- Status: accepted.
- Approach: TypeScript, strict compilation, native VS Code APIs, no webview or backend. Support local desktop folders only.
- Exclusions: automatic discovery, remote folders, workspace-file entries, cross-device synchronization, and Marketplace publishing. B-11 separately accepts local sharing across profiles.
- Rationale and alternatives: source proposes these defaults but records no comparison; alternatives are not newly evaluated by this consolidation.
- Compatibility: target VS Code 1.144.1 as the initial minimum. The installed application reports this version; runtime compatibility remains unverified.
- Confirmation: the user accepted B-01 through B-04 and selected the installed version as the minimum.

### B-03: Profile-local saved-project persistence

- Status: superseded by [B-11](#b-11-shared-private-saved-project-store). The original choice and its history remain below.
- Original approach: versioned folder URI records in `ExtensionContext.globalState`, not workspace state. Do not enable Settings Sync. Deduplicate canonical paths without merging distinct case-sensitive filesystem entries.
- Serialize store mutations and await persistence before refreshing or switching. Saved entries must survive new store instances, extension-host reloads, folder switches, and VS Code restarts.
- Failure behavior: missing folders, invalid records, and permission/persistence failures produce safe results; do not automatically remove saved entries. Removing an entry deletes metadata only. B-08 defines the response when saving the list fails.
- Original limit: use one window for saved-project additions and removals. Concurrent edits were unsupported.
- Original consequences: cross-window visibility and coordination were unresolved. No automatic concurrent-edit warning was established.
- Confirmation: the user accepted B-03 and selected single-window editing for the first slice.
- Original rationale: no additional rationale was recorded. B-11 preserves local-only storage and safe failure behavior.

### B-04: Accessible native selectors and one switching handler

- Status: partially superseded by B-05. The selectors and shared-handler approach remain accepted; the always-reuse behavior is historical.
- Add folders through a folder-only dialog with multiple selection and cancellation support. Provide an empty-state Add Project action and keyboard-accessible removal commands.
- Show folder names, distinguishing paths, tooltips, and a current-project indicator. Search names and paths through `showQuickPick` and the Command Palette.
- Both sidebar selection and quick-picker selection use one switching handler. Check the target exists and is still a directory before opening.
- Historical behavior, superseded by B-05: always call `vscode.openFolder` with `{ forceReuseWindow: true, forceNewWindow: false }`. Skip reopening the current single-folder project; selection from a multi-root workspace replaces that workspace.
- Let VS Code manage unsaved changes and cancellation. Never force-save or discard user edits. Use accessible native controls, theme-aware icons, and text labels.
- Confirmation: the user accepted B-04 with B-01 through B-03.

### B-05: Focus open projects and choose where to open others

- Status: accepted behavior, partially superseded by [P-11](../project-worktrees/proposal.md#p-11-faster-window-choice) and [B-14](#b-14-create-a-project-folder-from-scratch). Temporary discovery and focus prototypes have partial test evidence. The finished implementation remains unverified.
- Save only each existing project folder's path. Do not store a last-opened or last-changed timestamp.
- When the selected path is already open, bring its existing window forward. Do not open another window for that path.
- Original rule: otherwise, ask each time whether to open in the current window or a new window. Canceling changes nothing.
- Replacement: [P-11](../project-worktrees/proposal.md#p-11-faster-window-choice) lets explicit window actions provide that choice without a separate prompt. Normal selection still prompts.
- Selecting the current window's project must not reload it or ask where to open it.
- Superseded by [B-14](#b-14-create-a-project-folder-from-scratch): the baseline previously accepted existing folders only, with folder creation outside its scope. Git worktree creation remains a separate flow.
- When an operation fails, explain the problem in an error popup with a Close button. Do not ask the user to close a project window or close it automatically.
- This replaces the always-reuse portions of B-01 and B-04. The project list, sidebar, quick picker, and shared handler remain.
- The intended open-window coverage is local windows where the extension is enabled, including manually opened projects and windows in different profiles where technically possible; see [P-07](../project-worktrees/proposal.md#p-07-project-aware-open-window-navigation). Full discovery and focus are not runtime-verified.
- If discovery or direct focus is unavailable, show an error and offer VS Code's native Switch Window picker instead of silently opening a possible duplicate. The extension cannot assume it can detect or prevent windows opened outside its coverage.
- For simultaneous requests to open the same project, the intended result is one window: a later request either focuses it or fails. The coordination mechanism and guarantee remain unverified.
- Confirmation: the user requested focusing the existing window, chose to ask each time for unopened projects, selected existing folders, and clarified that Close dismisses the error popup.

### B-06: Treat different paths to the same folder as one project

- Status: accepted behavior.
- Different paths that point to the same directory represent one project. This applies when adding projects and checking already-open windows.
- Path matching must respect the filesystem and must not merge distinct directories merely because their names differ only in case.
- How to resolve paths safely, and how to handle paths that cannot be resolved, remain implementation details to validate. Do not silently remove entries when a folder is unavailable.
- Test evidence: on a case-insensitive macOS filesystem, different-capitalization paths to the same folder produced different `realpath` strings. A temporary folder-identity comparison matched them; other filesystems remain unverified. See the [test results](implementation/baseline-draft-plan.md#concurrency-recovery-profiles-and-paths-5-november-2026).
- Confirmation: the user confirmed that different paths to the same folder should count as one project.

### B-07: Refresh when returning to a window and before opening

- Status: accepted user-facing behavior; the discovery mechanism remains unverified.
- Refresh the saved-project and open-window lists when their VS Code window becomes active again. [B-11](#b-11-shared-private-saved-project-store) separately requires coordinated saved-project edits.
- Check the current open-window state again immediately before opening a selected project.
- Background registration or coordination may still be needed. Refreshing alone does not guarantee safe concurrent edits or eliminate simultaneous-open races.
- Confirmation: the user agreed to refresh on return and check again when selecting a project.

### B-08: Keep and show the project list when saving fails

- Status: accepted behavior.
- If saving an edit fails, keep the last confirmed saved list. Do not present the attempted change as saved.
- Show a clear warning popup with a Close button and the current known project paths. Do not close a project window or modify project files.
- Do not silently remove a saved path because its folder is unavailable. If no reliable list is available, say so instead of claiming the list is empty.
- Confirmation: the user requested keeping the current list and showing it in the warning.

### B-09: Close a selected window separately from removing a project

- Status: accepted user-facing behavior; cross-window closing is not technically verified.
- Provide an explicit action to close a selected VS Code window. Closing it does not remove its saved project entry. Removing a saved entry is a separate action; it does not close a window or delete the underlying directory.
- Let VS Code handle unsaved-change protection and cancellation; never force-save or discard edits. Verify that the selected destination, rather than an unrelated or originating window, is closed and that cancellation leaves it open.
- If the target cannot be reached or closing cannot be performed safely, report the failure without closing a different window. The routing mechanism, API availability, and behavior on supported versions remain open.
- Delivery condition: include the action only if safe and reliable targeted closing can be verified. If it cannot be verified, leave this action out rather than offer an unreliable feature. The verification cases and evidence sufficient for this condition must be defined before declaring the slice ready.
- Realization: the [close-window feature](../close-window/proposal.md) (2026-11-20) hosts the mechanism, UI placement, and verification checklist. B-09's behavior and delivery condition are unchanged.
- Confirmation: the user requested closing the VS Code window, explicitly confirmed that its saved entry remains separate, and said not to add the feature if it cannot be reliable. Broader rationale was not supplied.

### B-10: First outcome and window labels

- Status: accepted outcome and initial display direction; detailed slice contracts remain open.
- The first end-to-end outcome is to open several existing project paths in new windows, replace a window's project with another project, and, subject to B-09's verification condition, close a selected window. Ordinary selection continues to follow B-05, including focusing an already-open project and offering a current/new window choice for an unopened one.
- Display the opened root directory's name for a participating window, with a distinguishing path where needed. Custom user-defined aliases are deferred; the path remains the saved project identifier. How to label non-single-folder windows remains open.
- Worktree creation and OpenCode launch are outside this first outcome. No detailed slice or implementation approval is implied.
- Confirmation: the user described this first outcome, preferred the opened directory name for now, and deferred custom alias decisions. Broader rationale was not supplied.

### B-11: Shared private saved-project store

- Status: accepted replacement for [B-03](#b-03-profile-local-saved-project-persistence). An implementation exists; recovery and runtime verification remain open.
- Store saved project paths in a private local file shared across VS Code profiles. Do not synchronize or send telemetry.
- Coordinate additions, removals, and migration across participating windows and profiles. Do not lose confirmed edits.
- Safely migrate existing profile-local paths. Preserve unavailable and non-Git entries; removal remains an explicit metadata-only action.
- Deduplicate paths only when their identity is safely established. Preserve uncertain entries rather than silently dropping them.
- Each existing profile has its own legacy `globalState`. Migration must account for profiles when they participate; do not claim access to inactive profiles.
- Preserve legacy data until migration is confirmed. Prevent retries or later profile migration from silently restoring deliberately removed entries.
- A failed, corrupt, or uncertain read/write must not replace a confirmed list with an empty list. Apply B-08 and offer recovery.
- The live-window registry remains separate; it does not coordinate the saved-project file.
- Evidence: [`projectStore.ts`](../../../src/projectStore.ts#L3-L13) uses profile-local state; its [queue](../../../src/projectStore.ts#L67-L85) is per instance.
- Evidence: [`extension.ts`](../../../src/extension.ts) constructs the shared store separately from the window registry.
- The [profile test](implementation/baseline-draft-plan.md#concurrency-recovery-profiles-and-paths-5-november-2026) observed shared storage in one VS Code version, not a universal guarantee.
- Implemented mechanics: a versioned private file, cooperative lock, atomic replacement, migration, and tombstones. See [implementation evidence](#implementation-evidence-and-next-step).
- Remaining risks: ambiguous-alias removal, abandoned-lock recovery, interrupted initialization, and old-version coexistence.
- Confirmation: the user positively approved replacing profile-local storage with a shared private file, safe migration, and coordinated edits.
- Rationale: the confirmed direction removes the earlier single-window restriction. No further rationale was supplied.

### B-12: A project is any local folder; Git is optional

- Status: accepted.
- Approach: Add Project saves any existing local folder. A Git repository is no longer required for a saved project.
- Consequence: the current implementation rejects non-Git folders in [`projectCommands.ts`](../../../src/projectCommands.ts#L86-L104) and must change.
- Observed trigger: the old flow rejected a folder inside another repository with "Project directory is not a Git worktree root" from [`gitDiscovery.ts`](../../../src/gitDiscovery.ts#L138). The exact command path the user used is unconfirmed.
- Accepted mechanic: a Git folder must still be its repository's main checkout. Decline linked worktrees and point to the main checkout. This preserves the [P-03](../project-worktrees/proposal.md#p-03-group-worktree-entries-under-their-project) grouping identity.
- Accepted mechanic: detect Git through a `.git` entry, file or directory, at the folder root. Re-derive on every load and refresh; never store Git state. Worktree flows still revalidate fully.
- Accepted mechanic: if `.git` is present but Git fails, show the Git error. Do not silently save the folder as plain.
- Accepted mechanic: a plain-folder project has no checkout children; the project node itself opens the folder.
- Compatibility: [B-11](#b-11-shared-private-saved-project-store) already requires preserving non-Git entries. The store format needs no change.
- Supersedes: the "add local Git project paths" framing in the [worktrees overview](../project-worktrees/overview.md).
- Confirmation: the user said a project should simply create a workspace, selected "Any folder, Git optional," read slice 01 contracts 1-5, and said "I accept them."
- Slice: [01: Add any local folder as a project](slices/01-any-folder-projects.md).

### B-13: Worktree actions appear only for Git projects

- Status: accepted.
- Approach: show Create Worktree only for Git projects. Use distinct tree-item context values in the view and menu `when` clauses.
- Command Palette invocation on a plain folder explains the Git requirement instead of failing with a Git error.
- The existing workspace-trust and platform gates for worktree creation remain unchanged.
- Confirmation: the user said "the worktree should be only available if its a git project," confirmed the project-definition choice, and accepted slice 01 contracts 1-5.
- Slice: [01: Add any local folder as a project](slices/01-any-folder-projects.md).

### B-14: Create a project folder from scratch

- Status: accepted.
- Approach: a New Project action asks for a project name, creates the folder inside a configurable default root, offers optional `git init`, saves the entry, then follows the normal switching behavior.
- Accepted mechanic: the default root is a user-level setting, mirroring `projectSwitcher.worktreesDirectory`: `projectSwitcher.projectsDirectory` with default `/Users/diogocoelho/repos`.
- Accepted mechanic: after saving, run the standard flow from [B-05](#b-05-focus-open-projects-and-choose-where-to-open-others) and [P-11](../project-worktrees/proposal.md#p-11-faster-window-choice): focus if open, otherwise ask current or new window.
- Accepted mechanic: `git init` is a per-creation choice, never automatic. The prompt defaults to "No"; canceling it counts as "No" and continues the flow.
- Accepted mechanic: accept one safe directory component only; reuse the worktree name-validation pattern. Never adopt or overwrite an existing directory; a collision asks for another name.
- Accepted mechanic: if `git init` or the store save fails after creation, keep the folder and report the failed stage. Never auto-delete, matching the worktree-creation failure policy.
- Accepted mechanic: require workspace trust, consistent with worktree creation.
- Supersedes the B-05 sentence that limited additions to existing folders.
- Confirmation: the user chose the configurable default root and the normal switching choice, accepted optional `git init` per creation, and later accepted the four remaining mechanics.
- Slice: [02: Create a project folder from scratch](slices/02-new-project-from-scratch.md).

## Proposed implementation outline

Preserved from the root plan, not execution instructions for this design role:

1. Obtain implementation approval before repository initialization. The target directory now exists; inspect current state before setup rather than blindly repeating creation.
2. Initialize the independent Git repository if still needed; configure strict TypeScript compilation, extension-host tests, and local VSIX packaging.
3. Declare the Projects activity-bar view and Add, Remove, and Switch Project commands; register commands, views, and disposable resources.
4. Implement folder selection, storage, deduplication, persistence ordering, views, and shared switching behavior according to B-11/B-04.
5. Handle current folders, multi-root replacement, cancellation, missing directories, permissions, and persistence failures without data loss or automatic entry deletion.
6. Document installation, B-05 window choices, deferred capabilities, extension-host restart, and lack of terminal/task/debug-session preservation guarantees.

### Proposed files

| Path | Purpose |
| --- | --- |
| `package.json` | Commands, sidebar contributions, compatibility, and scripts. |
| `tsconfig.json` | Strict TypeScript compilation. |
| `src/extension.ts` | Commands, views, and disposable resources. |
| `src/projectStore.ts` | Saved folders persisted across switches. |
| `src/projectsView.ts` | Accessible native project tree items. |
| `src/projectCommands.ts` | Add, remove, search, and switch projects. |
| `media/projects.svg` | Theme-compatible activity icon. |
| `src/test/` | Persistence, view, command, and failure coverage. |
| `.vscode/launch.json` | Extension Development Host debugging. |
| `.vscode/tasks.json` | Compilation before debugging. |
| `.vscodeignore` | Exclude development files from installation packages. |
| `.gitignore` | Exclude dependencies, compiled files, and VSIX packages. |
| `README.md` | Development, installation, usage, and limitations. |

## Baseline verification and acceptance criteria

Adapted from the root plan and B-05 through B-10; these are expectations, not completed checks:

- Adding folders updates both sidebar and picker; duplicate additions do not create duplicate entries.
- Canceling folder selection or quick picking changes nothing.
- Saved entries survive fresh store instances and extension-host reloads, and remain available after restarting VS Code.
- Both selectors use the shared handler. An already-open project focuses its window without opening a duplicate.
- An unopened project offers current-window and new-window choices. Direct actions skip the separate prompt; canceling a prompt changes nothing.
- Selecting the current single-folder project does not reload the window or prompt for a window choice.
- Missing folders, file paths, invalid records, and persistence failures produce safe results.
- Removing an entry leaves its underlying directory unchanged.
- Duplicate folder names remain distinguishable by path.
- Keyboard-only users can add, select, search, and remove entries.
- Choosing the current window replaces its folder, including when VS Code is configured to open folders in new windows.
- Choosing a new window opens the project there and leaves the original window open.
- Canceling a native unsaved-change prompt preserves edits and the current project.
- Compilation and automated tests pass.
- An installed VSIX supports switching outside the Extension Development Host.
- Errors explain what happened and provide a Close button without closing a project window.
- If the close-window action passes its delivery condition, it closes the selected window without removing its saved project entry; a canceled native unsaved-change prompt leaves the window and edits intact. Removing a saved entry does not close its window. If safe, reliable targeted closing cannot be verified, omit the action.
- Two paths to the same folder appear as one project and match the same open window.
- Returning to a window refreshes its lists; selecting a project checks the current open-window state.
- A failed save keeps the last confirmed list and shows the known paths in a warning.
- Participating profiles see the shared list. Concurrent additions and removals do not silently lose confirmed edits.
- Migration preserves existing unavailable and non-Git paths. A retry or late profile migration does not silently resurrect removed entries.
- Corruption, permission failure, and interrupted migration preserve recoverable data and report uncertainty.

## Relevant risks and unresolved contracts

- Lifecycle: same-window opening shuts down the extension host; complete writes first. Observe actual native edit-protection behavior on supported VS Code versions/settings.
- Data protection: no forced save/discard; removal affects metadata only; missing paths do not cause automatic removal.
- Scratch creation: B-14 writes to the filesystem and can run `git init`. Validate one safe directory component; never overwrite or adopt an existing directory; keep partial results and report the failed stage. The default-root setting needs a scope and default-value contract.
- Privacy: folder paths are local metadata; do not add telemetry or synchronization.
- Accessibility: native controls and keyboard access must cover add, search, select, and remove.
- Compatibility: VS Code 1.144.1 remains unverified. Shared-file location, schema, permissions, and recovery need detailed contracts.
- Concurrent windows and migration: B-11 requires coordination. Define locking, stale locks, crash recovery, migration markers, and removal conflicts before readiness.
- Mixed versions and rollback: older instances still edit profile-local state. Define a safe upgrade, coexistence, and rollback policy before migration.
- Privacy: shared paths become visible to participating profiles. Private file permissions do not protect against malicious processes running as the same user.
- Window discovery, focus, and close: B-05 and B-09 depend on locating the intended window. The P-08 mechanism, cross-profile coverage, cross-window close, and supported-version behavior are unverified. Define path identity, races, registry/request failure handling, and duplicate-window limits before a slice is ready; the native picker is the accepted discovery/focus fallback.
- Remote development remains deferred. Workspace-file entries remain excluded from the baseline; replacing an already-open multi-root workspace does not imply supporting saved workspace files.

## Proposed verification: concurrent opens and window closing

- Previous evidence is limited: in three temporary trials on VS Code 1.145.0, simultaneous requests resulted in one reported window; see [test results](implementation/baseline-draft-plan.md#concurrency-recovery-profiles-and-paths-5-november-2026). This does not prove race safety.
- A receiving implementation agent should design and run repeatable, isolated tests with participating windows that issue near-simultaneous requests for the same unopened folder. Check that the outcome is one window and that the second request focuses it or fails, without silently opening a duplicate.
- Cover repeated attempts, different profiles, and a participating window or process closing during a request. Record versions, setup, number of trials, visible outcomes, failures, and limitations; test evidence cannot prove all possible races are absent.
- Separately define and verify targeted closing, including correct destination, unavailable target, unsaved-change cancellation, and preservation of the saved entry. If reliable and safe closing cannot be verified, leave the feature out under B-09.
- The user requested testing. The precise synchronization contract, failure recovery, test procedure, and evidence threshold remain open; executing a concrete test requires a suitable implementation agent and an agreed execution scope. This outline records intent only.

## Agreement and change history

| Event | Item | Confirmation and rationale | Impact |
| --- | --- | --- | --- |
| Original root plan | B-01 | Source labels product scope and target location confirmed; earlier rationale is unrecorded. | Preserves baseline product intent without accepting proposed technical defaults. |
| Current consolidation | Persistence | User requested “Add those to the current structure.” | Baseline content consolidated under `docs/features/` and additions linked to it; root file unchanged. No implementation authorized. |
| Implementation planning | B-01–B-04 | User said “I accept and agrre with all b1 to b4 decisions.” No additional rationale was supplied. | Product scope and baseline technical choices accepted; detailed contracts remain open. |
| Implementation planning | B-02 / B-03 | User selected single-window editing and the installed VS Code version as the initial minimum. | Concurrent edits remain unsupported; VS Code 1.144.1 is the initial target. |
| Implementation planning | Persistence | User authorized saving the acceptance and single-window editing preference. | Updated design and draft plan; implementation remains unauthorized. |
| Window-opening discussion | B-05 replaces parts of B-01 and B-04 | User requested focusing an already-open path and choosing current or new window for an unopened path. | Replaces the always-reuse rule; previously accepted rationale remains above. |
| Window-opening discussion | B-05 details | User chose path-only records, existing folders, a choice each time, and an error popup with a Close button. | Defines the initial user-facing behavior; window discovery and focus remain unverified. |
| Window-opening discussion | Persistence | User authorized updating the design and plan with these rules. | Updated documentation only; no implementation authorized. |
| Storage and refresh discussion | B-06–B-08 | User confirmed same-folder path matching, preserving and showing the current list after a failed save, and refreshing on return and before opening. | Added accepted behavior; window discovery and focus still require verification. |
| Storage and refresh discussion | Persistence | User said “yes write it.” | Authorized recording these choices and updating the plan, not implementing code. |
| First-outcome discussion | B-05 / B-07 | User accepted an error and native picker fallback, wanted simultaneous opens to result in one window with the second request focusing or failing, and deferred detailed stale-list handling. | User-facing direction recorded; race safety, discovery, and focus remain unverified. |
| First-outcome discussion | B-06 / B-08 | User preferred showing unavailable entries and letting the user delete them. The user noted typical macOS case-insensitive behavior. | Retains the accepted no-automatic-deletion and same-folder rules; other filesystem behavior remains to be verified. |
| First-outcome discussion | B-09 / B-10 | User requested closing a selected VS Code window, confirmed closing does not remove the saved entry, described the first outcome, and deferred custom aliases in favor of a directory name. | Records the new close action and initial outcome; technical close routing and a detailed slice remain open. |
| First-outcome discussion | Persistence | User said “do it. save it” to updating the existing baseline and worktree design documents. | Documentation authorization only; no implementation authorized. |
| Verification discussion | B-09 / B-10 | User said not to add the window-close feature if it cannot be reliable. | Closing is conditional on verifying safe, reliable targeting; otherwise omit it. |
| Verification discussion | B-05 / P-07 | User agreed to cross-profile open-window discovery with profile-local saved lists and requested testing concurrent opens. | Metadata scope and a proposed test outline are recorded; no new runtime evidence or implementation authorization is claimed. |
| Verification discussion | Persistence | User said “save it” after the proposed profile, close-window, and testing updates. | Authorized recording those updates in existing design documents. |
| First-version execution | Registry direction | User confirmed “Yes, use registry” for finding and focusing participating windows. | Accepts the local-registry direction for the first version, not every P-08 transport or recovery detail. |
| First-version execution | Implementation | User said “do it” after the first-version plan. | Authorized the first implementation; window closing remains excluded pending reliable verification. |
| Requirements review | B-05 / P-11 | User agreed that direct window actions skip the extra prompt while normal selection still prompts. | P-11 replaces the mandatory separate prompt, not the current/new choice or existing-window focus. |
| Reconciliation | B-11 replaces B-03 | User explicitly approved private shared-file storage, safe migration, and cross-window coordinated edits. No further rationale was supplied. | Replaces profile-local lists and single-window editing; retains local-only privacy and safe failure behavior. |
| Reconciliation | Persistence and execution | User approved the implementation plan and authorized execution. | Design updates are authorized; this design role does not edit application code. |
| Project-definition discussion | B-12 / B-13 | User said a project should simply create a workspace and that worktree creation should be Git-only, then selected "Any folder, Git optional." | Saved projects no longer require Git; worktree actions are gated to Git projects. |
| Project-definition discussion | B-14 | User chose a configurable default root and the normal switching choice after creation, and accepted optional per-creation `git init`. | From-scratch creation accepted; supersedes the B-05 existing-folders-only limit. |
| Project-definition discussion | Persistence | Saved under this session's standing `docs/features/` write scope. | Documentation only; no implementation authorized. |
| Project-definition discussion | B-12 / B-13 mechanics | User read slice 01 contracts 1-5 and said "I accept them." | Detection, add-flow, sidebar, and gating mechanics accepted; slice 01 marked ready. Design acceptance does not authorize implementation. |
| Slice 01 handoff | Implementation | User said "do it" after slice 01 was marked ready. | Authorizes implementing slice 01 under an implementation agent; the design role does not edit code. |
| Slice 02 design | B-14 mechanics | User accepted the four remaining mechanics: setting name and default, Git prompt default "No", cancel-counts-as-"No", and the trust gate. | Slice 02 marked ready. Design acceptance does not authorize implementation. |
| 2026-11-20 session | B-09 realization | User requested "someway to close windows in the extension." | The [close-window feature](../close-window/proposal.md) hosts the mechanism and verification checklist; B-09's accepted behavior and delivery condition are unchanged. No implementation authorized. |

## Implementation evidence and next step

Implementation status: partially implemented. [`src/sharedProjectStore.ts`](../../../src/sharedProjectStore.ts) provides a shared file, coordinated edits, and legacy migration. [`src/windowRegistry.ts`](../../../src/windowRegistry.ts) and [`src/switchProject.ts`](../../../src/switchProject.ts) handle participating windows. Window closing is not included.

Verification: `rtk npm test` passed 96 automated tests, including isolated Git, focus-routing, and cross-process storage tests. `rtk npm run package -- --out project-switcher-worktrees.vsix` produced a local VSIX; packaging warned that no license file is present. The VSIX was not installed, and the extension was not tested visually in an Extension Development Host. The earlier [focused window test](implementation/baseline-draft-plan.md#first-window-focus-test-5-november-2026) remains partial evidence only.

Next step: verify the [worktree slice](../project-worktrees/slices/01-project-worktrees.md) in VS Code. Resolve ambiguous-alias removal, abandoned-lock recovery, old-version coexistence, and window-focus limitations. No release readiness is claimed.
