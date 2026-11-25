# VS Code Project Switcher — Implementation Plan

Status: proposed; implementation has not started.
Target repository: `/Users/diogocoelho/repos/vscode-project-switcher/`.

## Confirmed scope

- Create a separate extension repository at the target location.
- Add project folders manually through a folder picker.
- Show saved projects in a dedicated sidebar.
- Provide a searchable quick picker for keyboard switching.
- Replace the current window's folder when selecting another project.

## Proposed implementation

Use TypeScript and native VS Code APIs, without a webview or backend.
Initially support local desktop folders only.
Exclude automatic discovery, remote folders, workspace files, synchronization, and Marketplace publishing.

### Files in the target repository

- `package.json` — Declare commands, sidebar contributions, compatibility, and scripts.
- `tsconfig.json` — Enable strict TypeScript compilation.
- `src/extension.ts` — Register commands, views, and disposable resources.
- `src/projectStore.ts` — Persist saved folders across switches.
- `src/projectsView.ts` — Show accessible native project tree items.
- `src/projectCommands.ts` — Add, remove, search, and switch projects.
- `media/projects.svg` — Provide a theme-compatible activity icon.
- `src/test/` — Test persistence, views, commands, and failures.
- `.vscode/launch.json` — Configure Extension Development Host debugging.
- `.vscode/tasks.json` — Compile before debugging.
- `.vscodeignore` — Exclude development files from installation packages.
- `.gitignore` — Exclude dependencies, compiled files, and VSIX packages.
- `README.md` — Explain development, installation, usage, and limitations.

## Implementation steps

1. Obtain implementation approval before creating the separate repository.
2. Create the target directory and initialize its independent Git repository.
3. Configure compilation, extension-host tests, and local VSIX packaging.
4. Declare the Projects activity-bar view and Add, Remove, and Switch Project commands.
5. Use a folder-only dialog with multiple selection and cancellation support.
6. Store versioned folder URI records in `ExtensionContext.globalState`, not workspace state.
7. Keep records local to the VS Code profile; do not enable Settings Sync.
8. Deduplicate canonical paths without merging distinct case-sensitive filesystem entries.
9. Serialize store mutations and await persistence before refreshing or switching.
10. Show folder names, distinguishing paths, tooltips, and a current-project indicator.
11. Provide an empty-state Add Project action and keyboard-accessible removal commands.
12. Search names and paths through `showQuickPick` and the Command Palette.
13. Share one switching handler between sidebar selection and quick-picker selection.
14. Check that the selected folder exists and remains a directory.
15. Call `vscode.openFolder` with `{ forceReuseWindow: true, forceNewWindow: false }`.
16. Skip reopening the current single-folder project.
17. Replace a multi-root workspace when selecting a saved folder.
18. Let VS Code manage unsaved changes and cancellation.
19. Never force-save or discard user edits.
20. Report missing folders and permission failures without automatically removing entries.
21. Remove only saved records; never delete folders or project files.
22. Use accessible native controls, theme-aware icons, and text labels.
23. Explain that switching restarts the extension host.
24. Do not promise terminal, task, or debug-session preservation.
25. Document installation, switching behavior, and deferred capabilities.

## Verification and acceptance criteria

- Adding folders updates both sidebar and picker.
- Duplicate additions do not create duplicate entries.
- Canceling folder selection or quick picking changes nothing.
- Saved entries survive fresh store instances and extension-host reloads.
- Both selectors call the shared handler with explicit same-window options.
- Selecting the current single-folder project does not reload the window.
- Missing folders, file paths, invalid records, and persistence failures produce safe results.
- Removing an entry leaves its underlying directory unchanged.
- Duplicate folder names remain distinguishable by path.
- Keyboard-only users can add, select, search, and remove entries.
- Switching between two folders keeps the same VS Code window.
- Forced reuse works with VS Code configured to open folders in new windows.
- Canceling a native unsaved-change prompt preserves edits and the current project.
- Saved projects remain available after restarting VS Code.
- Compilation and automated tests pass.
- An installed VSIX supports switching outside the Extension Development Host.

## Risks and boundaries

- Switching shuts down the current extension host; complete writes before opening folders.
- Native edit protection depends on VS Code settings; verify supported behavior manually.
- Folder paths are local metadata; do not add telemetry or synchronization.
- Remote development and concurrent edits across windows need separate follow-up design.
- Choose and document the minimum supported VS Code version during implementation.

## Evidence and approval

Official command contract:
https://code.visualstudio.com/api/references/commands#commands

Confirmed choices cover scope and repository location.
Technical defaults remain proposed until implementation-plan approval.
Saving this plan does not authorize implementation.
Implementation status: not implemented. Verification status: not run.
