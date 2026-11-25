# Project Switcher

Save local project folders and switch between them from the Projects activity bar or Command Palette.

## Use

1. Run **Projects: Add Project** and select an existing Git checkout root.
2. Expand a project to see its primary checkout and Git-linked worktrees.
3. Select a checkout in the sidebar, or run **Projects: Switch Project**.
4. Use **Open Here** or **Open in New Window** to choose directly.
5. If the checkout is already open in a participating window, the extension asks that window to come forward.
6. Otherwise, choose the current window or a new window. Cancel to leave the current setup unchanged.
7. Use **Projects: Remove Project** to remove a saved entry. This never deletes project files or closes a window.

Use **Projects: Switch to Open Project Window** to choose a participating open window. Folders that are unavailable stay in the list until removed.

## Create a worktree

1. Set **Projects: Worktrees Directory** to an existing absolute directory.
2. Select **Create Worktree** on a project, or use the Command Palette.
3. Confirm project trust. Git fetches and verifies the selected remote; failures fall back to local branches.
4. Choose the starting branch and enter a new branch name.
5. Confirm the directory name and previewed path. The extension opens the worktree in a new window.

The default parent is `/Users/diogocoelho/repos/worktrees`. New worktrees use `<parent>/<project>/<branch-derived-name>`. Existing destinations are never overwritten. Git checkout filters can run; uncommitted files and dependencies are not copied.

## Boundaries

- Targets local desktop folders on VS Code 1.144.1 or later. Windows storage is unverified; remote windows and saved workspace files are not supported.
- Saved projects use `~/.vscode-project-switcher/shared-projects-v1/projects.json`, shared across participating profiles. The file is not synchronized through Settings Sync.
- Each profile imports its existing saved paths when its extension instance participates. Old extension versions do not coordinate edits with the shared file.
- A linked worktree saved by an earlier version can remain a separate project entry. Remove that entry if duplicated; its files remain untouched.
- Worktree creation requires a trusted VS Code workspace and explicit trust confirmation for the selected project. Creation is currently unavailable on Windows.
- VS Code manages each folder's profile. Worktrees do not automatically inherit their project's profile. Enable this extension in each profile you use.
- Participating local windows share the folder paths and session information needed for discovery across profiles. Windows where the extension is not active may not be discoverable.
- Focus requests recheck the selected folder. Older extension versions cannot handle the new focus protocol; use VS Code's window picker if needed.
- Git must be available to discover worktrees. Missing or non-Git project entries remain listed, with a discovery warning.
- If discovery, a focus request, or an earlier open attempt cannot be verified, the extension reports the problem instead of silently opening a possible duplicate. The native Switch Window picker is available as a fallback.
- An interrupted, unconfirmed open can block later opens of that folder. A stale registry entry can also block it; the extension fails closed instead of guessing that a window is gone.
- If a saved folder is unavailable, adding another folder is blocked when duplicate identity cannot be checked. A missing, previously deduplicated alias can also block removal until its identity is resolved.
- When a removed path is unavailable, ambiguous legacy paths are not imported automatically. Add a path explicitly if needed.
- An abandoned project-store lock blocks edits. Close all VS Code windows and inspect the lock before manual recovery; never remove a live writer's lock.
- After a failed save, the running window keeps its last confirmed list and stops further edits. A reload reads the stored state again; the result of an ambiguous failed write cannot be guaranteed.
- Opening a folder in the current window restarts its extension host. VS Code controls unsaved-change prompts; the extension does not force-save or discard edits. Terminals, tasks, and debug sessions may not survive a switch.
- Automatic OpenCode launch is skipped because VS Code does not expose a safely correlated destination window. No terminal starts when focusing an existing window.
- Closing windows, custom project names, worktree deletion, and automatic project discovery are not included.
- Window focus and duplicate prevention depend on VS Code and are not guaranteed for windows outside the extension's coverage. Race and crash recovery still need broader verification.

## Development and local packaging

Run `npm install`, `npm run compile`, and `npm test`. Use the **Run Project Switcher** launch configuration for an Extension Development Host. Run `npm run package` to create a local VSIX; installing it is a separate manual step.
