# Draft plan: Project Switcher

Historical draft: [B-11](../proposal.md#b-11-shared-private-saved-project-store) replaces the profile-local, single-window storage direction below. Test observations remain historical evidence.

## What the extension should do

- Let you add existing project folders to a saved list.
- Store each project's path, without a last-opened or last-changed timestamp.
- Treat different paths to the same folder as one project.
- Show saved projects in a sidebar and a searchable list.
- When a project is already open, bring its window forward instead of opening another.
- Otherwise, ask whether to use the current window or open a new one.
- Let you remove a project from the list without deleting its files.
- Explain errors in a popup with a Close button. Never close a project window automatically.
- If saving the list fails, keep the last saved list and show its paths in a warning.
- Refresh the lists when you return to a window. Check open windows again before opening a project.

For now, use one window to add and remove saved projects. Concurrent changes from different windows are unsupported.

## What needs clarification before coding

1. **Test finding windows first.** Normal, minimized, and fullscreen focus were visually confirmed below. One alternate-path discovery case passed. Other windows may not be discoverable.
2. **Then decide what to do if finding or focusing fails.** Do not silently open a duplicate when an existing window is known.
3. **Handle edge cases.** Decide how to identify folders when paths cannot be resolved, and handle simultaneous open requests safely.
4. **Complete the storage details.** Define the storage format and what to show if no reliable saved list is available. One-window editing does not guarantee cross-window synchronization.
5. **First slice.** Save the agreed scope and checks as a small, ready-to-implement slice.

The chosen minimum is VS Code **1.144.1**. The finished extension has not been tested on it.

## How to build it

The focused test and a partial first implementation now exist. The steps below are the original draft; see the [proposal](../proposal.md#implementation-evidence-and-next-step) for current implementation evidence.

1. **Check the window behavior first.** Continue testing discovery and focusing in two VS Code windows. Stop and discuss alternatives if the behavior cannot be made reliable.
2. **Set up the extension.** Add `package.json`, `package-lock.json`, `tsconfig.json`, `.vscode/` settings, and packaging files. Set up compilation, tests, and a local VSIX package.
3. **Save project paths.** Add `src/projectStore.ts`. Save the list across restarts, recognize paths to the same folder, and keep the last saved list if a write fails.
4. **Open projects.** Add `src/projectCommands.ts`. Refresh window information, focus an already-open project, or ask which window to use. Check the folder before opening it and show clear errors.
5. **Add the interface.** Add `src/extension.ts`, `src/projectsView.ts`, and `media/projects.svg`. Provide the sidebar, searchable list, and keyboard-accessible actions.
6. **Explain how to use it.** Add `README.md`. Explain installation, window choices, error messages, and the single-window editing limit.
7. **Test and report.** Add tests under `src/test/`. Run the checks below and report results, including anything that could not be verified.

## How to check it works

| Check | How to verify |
| --- | --- |
| Add, find, and remove projects | Test the sidebar and searchable list. Confirm removal leaves project files untouched. |
| Remember projects | Restart VS Code and confirm the saved paths remain. If saving fails, confirm the previous list remains and the warning shows its paths. |
| Same folder, different paths | Add two paths to the same folder and confirm they count as one project. Check an open window through either path. |
| Already-open project | With two windows open, select an open project. Confirm its existing window comes forward and no duplicate opens. |
| Unopened project | Choose the current window, then test the new-window choice separately. Confirm Cancel opens nothing. |
| Current project | Select the project already in the current window. Confirm it does not reload or ask for a window choice. |
| Refresh | Return to a window and confirm its lists refresh. Confirm opening checks the current windows again. |
| Errors | Test missing folders, access failures, failed saves, and unavailable window discovery. Confirm clear messages and a Close button. |
| Keyboard access | Add, find, select, and remove projects using only the keyboard. |
| Unsaved changes | Cancel VS Code's unsaved-change prompt and confirm the current folder and edits remain. |
| Build and installation | Run the proposed `npm run compile`, `npm test`, and `npm run package` scripts. Test the VSIX in an isolated VS Code profile. |

The scripts and automated tests now exist. GUI checks need local VS Code. Installing the VSIX requires separate permission.

## First window-focus test: 5 November 2026

- **Setup:** VS Code 1.144.1 on macOS 26.7.2, using two temporary folders and a separate VS Code user-data directory. Shared application storage was not independently checked. No VSIX was installed.
- **What worked:** Both temporary extensions found the focus command. Window A sent a request addressed to window B. VS Code reported that B became focused after receiving it.
- **Safety checks:** The temporary test rejected an expired request and a request for the wrong window.
- **Limit:** This is a promising first result, not proof of reliable focusing. Focus changed again shortly afterward, for an unknown reason. We did not independently verify which window was visually in front.
- **Not tested:** Full window discovery, minimized windows, macOS Spaces or fullscreen, duplicate paths, unsaved edits, and crash or reload recovery.
- **Evidence:** Temporary logs are in `focus-test.xE6rkzGM/a.jsonl` and `focus-test.xE6rkzGM/b.jsonl` under the session's temporary directory. They may not persist.
- Both temporary test windows were closed after the test. No application code was added to this project.

## Follow-up normal-window test: 5 November 2026

- Two labeled temporary VS Code windows were opened in the isolated profile.
- Window A sent a request to window B. VS Code reported that B became focused.
- The user confirmed that window B visibly came to the front after A.
- Both test windows were closed afterward. The test did not intentionally modify your projects or settings. See the later isolation warning below.
- At this point only the normal-window case was confirmed. Later checks are recorded below.

## Minimized, fullscreen, and path tests: 5 November 2026

- **Minimized window:** The user minimized window B. After a request from A, the user confirmed B restored and came to the front.
- **Alternate path:** A temporary symbolic link pointed to B's folder. The test found exactly one matching active window and requested its focus. The user confirmed B came forward.
- **Fullscreen:** The user made B fullscreen. After switching to A and requesting B, the user confirmed the fullscreen window came forward.
- **Limits:** These checks used two temporary development extensions with separate user data on VS Code 1.144.1 and macOS 26.7.2. Shared application storage was not independently checked. The path test covered one symbolic link, not every possible path alias or filesystem.
- **At that point unverified:** The finished extension, windows without it enabled, cross-profile discovery, ordinary non-fullscreen Spaces, duplicate windows, concurrent requests, and crash or reload recovery. Later checks are recorded below.
- The temporary test windows were closed afterward. No application code was added to this project.

## Concurrency, recovery, profiles, and paths: 5 November 2026

- **Setup:** VS Code 1.145.0 on macOS 26.7.2, using temporary development extensions and folders. The chosen minimum remains 1.144.1.
- **Concurrent focus:** Two test windows sent separate requests to the same window. The temporary test received and handled both; this does not prove concurrent project-list edits are safe.
- **Concurrent opening:** In three trials, two windows requested the same unopened folder 16–27 ms apart. VS Code reported one resulting window each time. This does not prove every race is safe.
- **Closed and reloaded windows:** A closed test window was no longer found. After reload or reopen, the test rejected requests for its old session and handled requests for its new session. Crash recovery remains untested.
- **Folder aliases:** A chain of symbolic links matched the open folder. On this Mac, uppercase and lowercase paths referred to the same folder but produced different `realpath` strings. A test comparing folder identity found the existing window; its behavior on other filesystems remains unverified.
- **Profiles:** In two different test profiles, saved extension state stayed separate across reloads. Both profiles received the same extension storage folder. A test registry in that folder exposed one profile's window to the other, so same-profile separation needs an explicit design.
- **Cross-profile opening:** A window in one test profile requested a folder already open in another. VS Code reported focusing the existing window and reported one window for that folder. This was not visually verified or tested on other versions.
- **Isolation warning:** The first 1.145.0 test used separate user data, but VS Code's log showed access to `~/.vscode-shared/sharedStorage/state.vscdb`. The tests did not intentionally modify your projects. Whether VS Code changed that shared database is unknown. The test process was stopped, and subsequent profile and opening checks used a separate shared-storage directory verified in VS Code's log.
- **Still unverified:** Actual extension behavior, all concurrent-open races, crash recovery, other filesystems, and discovery of windows without the extension enabled.
- All temporary test windows were closed. No application code was added to this project.

## Decisions and status

- The [proposal](../proposal.md) records the current choices. B-11 replaces B-03; B-05 replaces parts of B-01 and B-04.
- The proposed [window-focus method and test checklist](../../project-worktrees/proposal.md#deferred-verification-open-window-focusing) are only partly verified.
- The focused test and first implementation were authorized. The implementation is partial; the detailed slice is not ready for handoff.
- The earlier focus tests used temporary code outside the project. Application code, dependencies, and a local VSIX now exist; the VSIX has not been installed.
- Git initialization and VSIX installation require separate permission.
