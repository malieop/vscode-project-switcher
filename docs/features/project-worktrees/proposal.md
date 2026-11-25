# Proposal: Project worktrees with OpenCode

## Status

In discussion. Individual choices below have independent statuses. Saving is not acceptance of proposed details or implementation authorization.

Shared context and sources: [overview](overview.md). Prerequisite baseline: [saved-project switching overview](../project-switcher/overview.md) and [proposal/acceptance criteria](../project-switcher/proposal.md).

## Approach and choices

### P-01: Create a worktree from a saved project

- Status: new branches only, suggested remote main/master, and user-selected starting branch accepted; remaining creation details are proposed.
- Approach: provide Create Worktree through a project context menu and Command Palette. Resolve the saved folder's Git repository, request a new branch name and starting branch, preview a destination, create the worktree, and persist its entry before offering to open it.
- Availability: shown only for Git projects, per [B-13](../project-switcher/proposal.md#b-13-worktree-actions-appear-only-for-git-projects).
- Proposed rationale: a new-branch-only first increment avoids the additional existing-branch selection/conflict workflow. Git remains authoritative for creation and conflicts.
- Alternatives: support existing branches immediately (more UI/conflict handling), or only save worktrees created externally (does not meet the creation request).
- Consequences: requires Git, safe argument handling, destination validation, and partial-failure recovery. Never force creation, reset an existing branch, overwrite a destination, or move/stash original edits. Uncommitted/ignored files and dependencies are not copied.
- Starting-branch selection: suggest the project's remote `main` or `master`, while allowing the user to choose any branch.
- Starting-branch refresh and ambiguous remotes follow [P-12](#p-12-fetch-before-choosing-a-starting-branch). Missing suggestions remain an open contract.
- Confirmation: the user selected only new branches, requested a remote main/master suggestion, and asked to choose any branch. No additional rationale was supplied.

### P-02: Launch OpenCode in the integrated terminal

- Status: accepted interface choice.
- Approach: OpenCode opens in the destination VS Code window's integrated terminal with the worktree/project as its working directory. No embedded AI UI or SDK integration is required for the proposed initial approach.
- Context: OpenCode V2 documents interactive CLI launch in a project directory.
- Alternatives: external terminal or desktop app; the user explicitly selected the VS Code terminal.
- Consequences: CLI availability and startup failure must be handled independently of successful project opening. Exact terminal creation and executable-resolution contracts remain proposed.
- Confirmation: user answered “In the VS Code Terminal.”

### P-03: Group worktree entries under their project

- Status: accepted project-level checkout submenu; detailed labels and controls remain open.
- Show the primary checkout and linked worktrees under their project, as in the user's example.
- Do not list branches without a primary checkout or worktree in this submenu.
- Proposed approach: distinguish checkouts by branch and path. Removing a saved entry only removes metadata, never its directory.
- Alternatives: flat saved entries are simpler; grouping improves navigation but requires repository identity and refresh rules.
- Confirmation: the user said “only the branches with a worktree” and showed the primary checkout plus worktrees as children.

### P-04: Open new worktrees in dedicated new windows

- Status: accepted.
- Approach: open a newly created worktree in a new VS Code window rooted at that directory, leaving the original window open. Launch OpenCode in the destination window, not the originating one.
- Rationale: user explicitly wants a new window allocated to the new location. Broader rationale was not supplied.
- Alternatives: reuse current window; not selected for new worktrees. The [baseline B-05](../project-switcher/proposal.md#b-05-focus-open-projects-and-choose-where-to-open-others) separately offers a window choice for unopened saved projects.
- Consequences: requires destination-scoped launch handoff and validation. Ordinary project switching is not redefined.
- Confirmation: user answered “open a new window to be allocated to the new location.”

### P-05: Reuse the shared worktrees root

- Status: accepted initial root, configurable parent, and project/branch-based layout; setting scope and exact naming rules remain proposed.
- Root: `/Users/diogocoelho/repos/worktrees`, supplied by the user after requesting reuse of their existing worktrees directory.
- Proposed configuration: a user-level Worktrees Directory setting; do not write user configuration as part of this design session.
- Layout: `<root>/<project-name>/<filesystem-safe-branch-derived-name>`. Branch names remain distinct from directory names. For example, `feature/login` can map to `feature-login`.
- Show the full path before creation. If the destination exists, ask for a different directory name; never overwrite it.
- Detect project-name and sanitized-name collisions; do not silently adopt existing directories. Exact sanitization and project disambiguation remain open.
- Alternatives: flat names or user-chosen destination per creation. Existing project/UUID directories do not establish a uniform historical layout.
- Consequences: no migration or modification of existing worktrees. Project identity/disambiguation and destination validation need agreement.
- Confirmation: user supplied the root, confirmed the configurable parent, and agreed to the proposed project/branch layout and collision behavior.

### P-06: Launch only for an explicit OpenCode action

- Status: superseded proposal; the user's later direction is [P-09](#p-09-start-opencode-when-opening-a-window).
- Approach: offer Open with OpenCode / Create Worktree & Open with OpenCode. A normal project open, future reopen, or Reload Window should not itself trigger a fresh OpenCode launch. A deliberate request launches in the destination window after activation and applicable trust checks.
- Meaning: avoid the extension starting another terminal merely because it activated again. This is not a guarantee of persistent terminals, preserved processes, restored sessions, or exactly-once launch across crashes.
- Alternatives: always launch on folder activation (surprising execution and duplicate terminals), or require a separate manual launch in the destination (simpler but less convenient).
- Consequences: handoff state must be destination/window scoped, bounded in lifetime, consumed safely, and must not trigger in unrelated windows. Repeated actions, failed opens, cancellation, and interrupted handoffs need specified behavior before readiness.
- Confirmation: not accepted; replaced by the user's automatic-launch direction.

### P-07: Project-aware open-window navigation

- Status: requested capability with accepted coverage; UI details proposed.
- Coverage: local project windows where the extension is enabled, including manually opened projects. Consider participating profiles where technically possible. Share only metadata needed for window discovery, such as paths and window identifiers. [B-11](../project-switcher/proposal.md#b-11-shared-private-saved-project-store) separately replaces profile-local saved lists. Cross-profile discovery is unverified; do not promise disabled extensions, remote windows, or all distributions.
- Proposed UI: an Open Windows sidebar section and Switch to Open Project Window command with a searchable native quick picker and user-assignable keyboard shortcut. Show project name, branch/worktree when available, distinguishing path, and current-window indicator. Keep distinct windows of the same folder as distinct entries.
- Behavior: selecting an entry focuses that existing window without replacing folders, reloading it, opening a duplicate, or launching another OpenCode instance.
- A separate explicit close action is accepted conditionally in [B-09](../project-switcher/proposal.md#b-09-close-a-selected-window-separately-from-removing-a-project). It closes the selected window without removing its saved entry; omit it if safe, reliable destination closing cannot be verified.
- Alternatives: invoke the native Switch Window picker unchanged (simpler, but does not provide our project-aware sidebar or custom labels).
- Confirmation: coverage accepted; exact UI and implementation mechanism not independently accepted by permission to save.

### P-08: Local registry with destination-side native focus action

- Status: the user accepted a local registry as the first-version direction; detailed transport and recovery mechanics are not independently accepted. A registry implementation exists, with unit tests and partial prototype evidence; full runtime verification remains pending.
- Discovery: each extension instance publishes a separate record with a unique window-session identifier, project/folder URI, optional branch/worktree information, and heartbeat. Every participating window reads the registry and marks its own record as current. Keep metadata in extension-local storage, not repositories or the worktrees root.
- Initial proposed boundary, revised by the user's later direction: same VS Code profile only. Cross-profile discovery and its precise boundary remain unverified. A VS Code 1.145.0 test found a shared `globalStorageUri`, separate `globalState` values, and cross-profile registry visibility. Do not infer universal coverage or isolation. [B-11](../project-switcher/proposal.md#b-11-shared-private-saved-project-store) separately changes saved-project persistence. The registry uses extension-generated session identifiers, not VS Code internal numeric window IDs.
- Delivery: a destination-addressed, expiring focus request (proposed file mailbox) is received by the target extension instance. That instance invokes `workbench.action.focusWindow` to focus itself. Acknowledgement reports request handling; do not equate it with proof that the OS foreground changed.
- Reconciliation: watch for registry changes with periodic reconciliation; use atomic per-record replacement. Normal shutdown removes records best-effort; heartbeat expiry removes crashed sessions from the visible list. Reload generates a new session and retires/expires the old one. Timing, schema, atomicity, and race handling require detailed contracts. Baseline B-07 separately requires refreshing visible lists on window activation and checking again before opening a project.
- Native reuse: upstream `FocusWindowAction` focuses its executing window. `workbench.action.switchWindow` instead opens an interactive picker: the inspected handler accepts no target window argument and exposes neither its window list nor selected window as an extension-facing result. Its internal window enumeration/focus services are not a supported extension API. Do not scrape or intercept that picker.
- Rationale: reuse VS Code's focus behavior while the registry supplies project labels and destination routing unavailable through the picker action. No permanent helper server or OS accessibility automation is proposed.
- Fallback: offer the native Switch Window picker when direct routing/focus is unavailable. Do not silently open the folder again.
- Alternatives: native picker only; direct access to private VS Code services (brittle and not recommended); a local IPC service instead of files (additional lifecycle/security complexity).
- Evidence: [upstream window actions](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/electron-browser/actions/windowActions.ts), `BaseSwitchWindow.run`, `SwitchWindowAction`, and `FocusWindowAction.run`. Source inspected on upstream `main`; runtime checks are limited to the [documented tests](../project-switcher/implementation/baseline-draft-plan.md#concurrency-recovery-profiles-and-paths-5-november-2026).
- Confirmation: user requested saving this direction and verifying afterward. This authorizes documentation, not implementation or a claim that the mechanism works.

### P-09: Start OpenCode when opening a window

- Status: accepted behavior; safe destination fallback is accepted in [P-13](#p-13-skip-launch-when-destination-is-uncertain). Other launch and recovery contracts remain open.
- Start OpenCode in the VS Code terminal when opening a window for a primary checkout or worktree.
- When opening in the current window, start OpenCode in the destination if technically possible.
- If that location is already open, focus its window only. Do not start another OpenCode instance.
- The existing [P-02](#p-02-launch-opencode-in-the-integrated-terminal) terminal choice remains accepted.
- P-09 replaces proposed P-06, which required a separate OpenCode action.
- Confirmation: the user said to focus an already-open window and only start OpenCode when opening a window.
- Rationale: no additional rationale was supplied. Current-window handoff feasibility and launch failure behavior remain unverified.

### P-10: Include worktrees outside the shared parent

- Status: accepted coverage where technically possible; discovery and persistence mechanics are proposed.
- Proposed approach: ask Git for linked worktrees of each saved project, regardless of location.
- Git documents `git worktree list --porcelain -z` for stable, parseable worktree details: [Git worktree manual](https://git-scm.com/docs/git-worktree#_list_output_format).
- The shared parent organizes new worktrees; it does not limit discovery to that directory.
- Show unavailable or stale Git entries without automatically removing, pruning, moving, or repairing them.
- Alternatives: scan the shared directory, which misses external worktrees; save every worktree manually, which can become stale.
- Git availability, refresh, unsupported repositories, and stored worktree metadata remain open contracts.
- Confirmation: the user requested worktrees outside the parent if possible. No additional rationale was supplied.

### P-11: Faster window choice

- Status: accepted for a trial; detailed UI contracts and implementation remain open.
- Show explicit Open Here and Open in New Window actions for each checkout.
- Selecting a checkout normally still offers a native choice; both actions remain keyboard accessible.
- Always check for an existing window first; focus it instead of opening a duplicate or launching OpenCode.
- Alternatives: keep only the current picker, or choose a default with an optional alternate action.
- Impact: direct actions bypass [B-05](../project-switcher/proposal.md#b-05-focus-open-projects-and-choose-where-to-open-others)'s separate prompt while preserving a choice per request.
- Confirmation: the user agreed to try the actions and confirmed skipping the extra prompt. No additional rationale was supplied.

### P-12: Fetch before choosing a starting branch

- Status: automatic fetch, local fallback, failure explanation, and suggestion order accepted; operational details remain open.
- After project trust is confirmed under [P-14](#p-14-trust-gates-for-git-and-opencode), fetch automatically before the starting-branch choice.
- If fetch fails, explain the failure and offer local branches without claiming freshness.
- Proposed interpretation of local branches: `refs/heads`, excluding cached remote-tracking refs. Confirm this detail before readiness.
- Prefer `origin/main`, then `origin/master`, when available. Ask the user when multiple remotes make the choice ambiguous; do not silently choose an ambiguous remote.
- If neither suggestion exists, let the user choose a valid available starting branch. No default is established for that case.
- Git fetch contacts the configured remote and updates local remote-tracking refs; see the [Git fetch manual](https://git-scm.com/docs/git-fetch#_description).
- The project list remains local and is not synchronized through Settings Sync. Remote development remains excluded.
- Alternatives: manual refresh or no fetch; the user chose automatic fetch.
- Implementation uses local branches when no remote exists. Fetch uses bounded, cancellable Git execution with explicit tracking-ref updates and verifies advertised remote heads; see [`src/gitWorktreeCreate.ts`](../../../src/gitWorktreeCreate.ts).
- Verify authentication, cancellation, safe ref updates, and supported Git versions in actual VS Code environments.
- A failed fetch can still have changed repository state. Do not claim it was side-effect-free.
- Confirmation: the user requested automatic fetch, local fallback, an explanation, suggestion order, and a choice for ambiguous remotes. No further rationale was supplied.

### P-13: Skip launch when destination is uncertain

- Status: accepted fallback for P-09.
- When the destination window cannot be identified safely, silently skip automatic OpenCode launch. Never launch in a guessed or unrelated window.
- This fallback does not suppress independent creation, persistence, or window-opening errors.
- Focusing an already-open window never starts OpenCode. A safely identified destination also requires [P-14](#p-14-trust-gates-for-git-and-opencode).
- Confirmation: the user explicitly chose silent skipping when safe destination identification fails. No further rationale was supplied.
- New evidence: [`vscode.openFolder`](https://code.visualstudio.com/api/references/commands#commands) does not document a destination identifier or correlation token. A folder-keyed request cannot distinguish an unrelated window opening the same folder.
- The user confirmed safe skipping after being told automatic launch may consequently be skipped for every opening. No supported destination-correlation method has been verified.
- Remaining contracts: request lifetime, cancellation, duplicate prevention, and safe destination identification remain blocking.

### P-14: Trust gates for Git and OpenCode

- Status: accepted trust requirements; implementation mechanism remains blocking.
- Require confirmed trust for the selected project before fetching or creating a worktree. A different trusted current workspace is not proof of trust for that project.
- Require destination Workspace Trust before automatically starting OpenCode there. Never infer destination trust from source project trust.
- If project trust is denied or cannot be established, do not fetch or create. If destination trust is denied or unavailable, do not launch.
- The [VS Code Workspace Trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust#workspace-trust-api) documents `workspace.isTrusted` for the current workspace, not arbitrary saved paths.
- Verify a supported way to bind confirmed trust to the selected project. Until then, fail closed; do not invent an arbitrary-path trust API.
- Confirmation: the user explicitly confirmed project trust before fetch/create and destination Workspace Trust before launch. No further rationale was supplied.

## Relevant risks and proposed mitigations

- Git/filesystem execution: never interpolate branch/path input into shell commands. Validate arguments and option boundaries; never force or reset. Fetch follows an explicit creation request; OpenCode launch follows P-09 and P-13. Do not run automatic setup scripts.
- Fetch: remote access can request credentials and change local refs and `FETCH_HEAD`. Bound waiting and cancellation; avoid credential disclosure. Define refspec, pruning, tags, submodule recursion, and maintenance behavior. Blocking contract.
- Trust: Git can use repository configuration and helpers; OpenCode can load project instructions. P-14 accepts both gates, but selected-project trust binding and restricted-mode behavior remain blocking.
- Partial failures: if Git succeeds but persistence/window/CLI startup fails, retain the worktree, show its path and the failed stage, and offer recovery without rerunning creation or automatically deleting files/branches. Verify Git state after ambiguous failure; do not assume nothing was created.
- Lifecycle: destination activation is separate from the initiating command. P-13 requires silent skipping when destination identity is uncertain. Routing, duplicate prevention, expiry, and cancellation remain blocking.
- Shared root: inspect/check destinations without adopting existing directories. Preserve existing layout. Naming and collision handling are blocking destination contracts.
- Discovery: Git can report missing or stale worktrees. Do not equate reported metadata with an accessible folder; report Git failures without claiming an empty list.
- Accessibility: retain native labeled inputs/quick picks and Command Palette access; errors should identify the stage and offer keyboard-accessible recovery.
- Compatibility: minimum Git/VS Code versions and behavior for unborn repositories, bare repositories, submodules, missing Git, and invalid starting revisions must be defined before slice readiness. Remote support remains deferred. Worktree deletion is now designed separately under [worktree-removal](../worktree-removal/proposal.md) (2026-11-20); it is not implemented.
- OpenCode availability: missing CLI or failed startup must not invalidate an otherwise usable worktree. No credentials, service configuration, or automatic prompts are introduced by this design.
- Window registry: paths and branch names are local metadata; keep records in user-private extension storage, do not synchronize or send telemetry, and validate record/request schemas. Focus requests support a fixed focus action only, never arbitrary command IDs, terminal input, shell commands, or executable paths. Same-user local storage is not a security boundary against malicious same-user processes.
- Profile boundary: share only needed window-discovery metadata. B-11 separately accepts a shared private saved-project file. Define both storage boundaries and access before delivery; neither implies universal cross-profile discovery.
- Focus reliability: expire stale sessions/requests, revalidate destination liveness, deduplicate requests, and bound acknowledgements. Define sleep/resume, crashed/reloaded windows, duplicate-folder sessions, and registry-unavailable behavior before readiness. Report unavailable targets without creating windows.
- Compatibility: verify `workbench.action.focusWindow` across supported VS Code versions; source on `main` is not a stable cross-version behavior guarantee. Minimized and fullscreen windows passed limited tests; ordinary non-fullscreen Spaces and repeated reliability remain unverified.

## Deferred verification: open-window focusing

Authorized tests are recorded in the [baseline plan](../project-switcher/implementation/baseline-draft-plan.md#concurrency-recovery-profiles-and-paths-5-november-2026). Normal, minimized, and fullscreen focus, several path aliases, basic recovery, and limited concurrency were tested. Cross-profile discovery and its metadata boundary need further design.

1. Confirm baseline minimum VS Code 1.144.1 suits this feature; record VS Code/macOS versions used for verification.
2. In two local windows running a minimal extension, confirm command presence through `vscode.commands.getCommands()` and execute `workbench.action.focusWindow` in the destination instance after a request from the originating instance.
3. Confirm the selected destination comes forward without reopening/reloading folders, changing unsaved edits, creating a duplicate window, or starting OpenCode.
4. Confirm remaining cases: another non-fullscreen macOS Space and two windows showing the same folder. Minimized and fullscreen destinations passed in the documented test.
5. Check crashed targets, missing command behavior, and the native picker fallback. Closed and reloaded targets and stale requests received limited tests.
6. Record evidence and revise P-08 if needed before accepting its mechanism or declaring a navigation slice ready.

## Open questions and next increment

- User: clarify exact worktree naming, missing-suggestion behavior, and the proposed local-branch interpretation. Custom saved-project aliases are deferred.
- Design: resolve project identity/collisions, supported repositories, project-trust binding, safe process launch, cross-window handoff, and partial failures.
- Baseline dependency: B-11 requires coordinated saved-project edits and safe migration. Resolve the [storage risks](../project-switcher/proposal.md#relevant-risks-and-unresolved-contracts); the window registry does not solve them.
- Baseline window behavior: B-05 now requires detecting and focusing an already-open project before opening it. The proposed P-08 mechanism and verification checklist are therefore relevant to the baseline, not just future navigation UI.
- Open-window navigation: P-07's desired coverage includes participating windows across profiles where technically possible; P-08 transport/focus mechanism remains proposed. Runtime verification above is pending; metadata exposure, cross-profile discovery, and registry/request contracts remain unresolved. Closing a selected window is accepted separately in B-09 but remains technically unverified.
- The user deferred automatic profile inheritance. Prefer the project profile only if supported and known; otherwise let VS Code decide. No inheritance guarantee is accepted.
- The [draft slice](slices/01-project-worktrees.md) records the current scope and blockers. Partial runtime evidence does not establish readiness.

## Agreement and change history

| Event | Item | Confirmation and rationale | Impact |
| --- | --- | --- | --- |
| Current design session | P-02 | User selected “In the VS Code Terminal.” | Destination terminal interface accepted. |
| Current design session | P-04 | User selected a new window allocated to the new location. | New-worktree opening differs from ordinary same-window switching. |
| Current design session | P-05 | User asked to reuse an existing shared directory, then supplied `/Users/diogocoelho/repos/worktrees`. | Root accepted; naming/configuration mechanics remain proposed. |
| Current design session | Persistence | User said “you can save it.” | Authorized saving discussed design under `docs/features/`; no implementation authorization. |
| Open-window discussion | P-07 | User said “This coverage will be enough” for local project windows with the extension enabled, including manually opened projects. | Coverage accepted; no promise of every VS Code window. |
| Open-window discussion | P-07 / P-08 persistence | User said “lets save this and verify that afterwards.” | Saved feature scope, proposed registry/native-focus mechanism, evidence limits, and deferred verification checklist. No runtime verification or implementation performed. |
| Baseline consolidation | Documentation links | User said “Add those to the current structure.” | Added baseline overview/proposal under `docs/features/project-switcher/` and linked this addition to them. Existing P-01–P-08 statuses unchanged; root source remains untouched. |
| First-outcome discussion | P-07 / P-08 | User wants participating windows considered regardless of profile where technically possible, using their opened root directory names. | Revises P-08's proposed same-profile-only boundary; cross-profile discovery and metadata exposure require design and verification. |
| First-outcome discussion | B-09 / persistence | User confirmed closing a selected window should not remove its saved entry and authorized updating the existing baseline and worktree design documents. | Links the separate close action; destination-window closing remains unverified. No implementation authorized. |
| Verification discussion | P-07 / B-09 | User accepted sharing window-discovery metadata across profiles while keeping saved-project lists separate, and said not to add closing if it cannot be reliable. | Cross-profile discovery remains unverified; closing is conditional on safe, reliable targeting. |
| Verification discussion | Persistence | User said “save it” after the proposed profile, close-window, and testing updates. | Authorized recording those updates; the [baseline verification outline](../project-switcher/proposal.md#proposed-verification-concurrent-opens-and-window-closing) is not runtime evidence. |
| First-version execution | P-08 | User confirmed “Yes, use registry” and then authorized the first-version plan. | A local registry is implemented; its detailed contracts and runtime reliability remain unverified. |
| Requirements review | P-05 | User confirmed a configurable shared parent and the previously supplied root as its initial value. | Setting scope and organized directory naming remain open. |
| Requirements review | P-09 replaces proposed P-06 | User said to focus an already-open window and start OpenCode only when opening a window. | Launch timing accepted; routing, recovery, and current-window reuse remain open. |
| Requirements review | P-10 | User requested linked worktrees outside the shared parent if possible. | Coverage accepted; Git discovery and failure handling remain proposed. |
| Requirements review | P-11 | User retained the current/new choice and requested better UX. | Direct actions and any replacement of B-05's separate prompt remain proposed. |
| Requirements review | P-09 | User requested OpenCode after switching the current window, if possible. | Destination launch handoff and recovery remain unverified. |
| Requirements review | P-11 | User said “lets try it” to the proposed direct window actions. | Trial direction accepted; replacing B-05's separate prompt still needs explicit agreement. |
| Requirements review | P-11 replaces part of B-05 | User confirmed direct actions skip the extra prompt and normal selection still prompts. | Window choice and existing-window focus remain; direct-action UI details need design. |
| Requirements review | P-01 | User selected “only new branches” for creating worktrees. | Existing-branch creation is outside this increment; starting revision and naming remain open. |
| Requirements review | P-01 | User asked to choose the starting branch for the new worktree branch. | Starting branch selection is accepted; available refs, default, and naming remain open. |
| Requirements review | P-05 | User agreed to the proposed project/branch directory layout, path preview, and alternate-name prompt for an existing destination. | Exact sanitization and project-name collision handling remain open. |
| Requirements review | P-03 | User requested each Git project's branches in a submenu under the project. | Whether the submenu includes branches without worktrees remains open. |
| Requirements review | P-03 | User clarified the submenu should show the primary checkout and worktrees, not branches without a checkout. | Accepted checkout-based list; the creation starting-branch picker is a separate concern. |
| Requirements review | P-01 | User requested suggesting the project's remote main/master while allowing any starting branch. | Suggestion and choice accepted; available refs, remote selection, and fetch behavior need detail. |
| Implementation planning | P-13 | User chose safe skipping after being told it may skip every automatic launch. | Do not infer the destination from folder identity or a newly registered session. |
| Requirements review | P-12 | User requested automatic fetch and local fallback if it fails. | Supersedes the no-automatic-fetch proposal; network, trust, and fallback details remain open. |
| Reconciliation | P-12 | User confirmed failure explanation, `origin/main` before `origin/master`, and a choice for ambiguous remotes. | Local fallback and suggestion contracts are accepted; fetch mechanics remain open. |
| Reconciliation | P-13 | User confirmed silently skipping automatic OpenCode launch if the destination cannot be identified safely. | Preserves P-09 for safely identified destinations; no unrelated window receives a launch. |
| Reconciliation | P-14 | User confirmed project trust before fetch/create and destination Workspace Trust before launch. | Trust binding and enforcement remain blocking implementation details. |
| Reconciliation | B-11 / P-07 / P-08 | User positively approved a shared private saved-project file, safe migration, and coordinated edits. | Replaces the earlier profile-local list direction; window-discovery metadata remains separate. |
| Reconciliation | Profile inheritance | User deferred automatic profile inheritance. | Prefer a supported, known project profile; otherwise let VS Code decide. |
| Reconciliation | Persistence and execution | User approved the implementation plan and authorized execution. | Design changes are saved; this role remains design-only. |
| 2026-11-20 session | Worktree deletion | User requested "someway to destroy worktree." | Deletion deferral ends as a design matter; the [worktree-removal feature](../worktree-removal/proposal.md) hosts the design. No implementation authorized. |

## Implementation evidence

Worktree discovery and creation are implemented in [`src/gitDiscovery.ts`](../../../src/gitDiscovery.ts), [`src/gitWorktreeCreate.ts`](../../../src/gitWorktreeCreate.ts), and [`src/projectCommands.ts`](../../../src/projectCommands.ts). The shared store is implemented separately; see the [baseline evidence](../project-switcher/proposal.md#implementation-evidence-and-next-step).

Automatic OpenCode launch is not implemented. VS Code exposes no verified destination correlation, and the user accepted silent skipping rather than risking a launch in the wrong window. Creation is unavailable on Windows; end-to-end VS Code behavior remains unverified.

Open-window navigation is partially implemented, not end-to-end verified. Previous probes found focus, identity, race, recovery, and profile-boundary evidence. These checks do not establish full discovery, race safety, profile separation, or compatibility beyond the tested setups.
