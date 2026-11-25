# Slice 02: OpenCode attention badges

## Status

In progress

Implemented and unit-tested 2026-11-24; manual runtime verification pending.

## Outcome and scope

The user sees, per row in the Open Windows view, whether that window's OpenCode
session waits for input (orange marker) or finished work since the window was
last focused (green marker). Focusing a window clears its finished marker.

Included: `@opencode/client` service discovery and polling; session-to-window
mapping; the optional `lastFocusedAt` heartbeat field; waiting/finished
markers; esbuild bundling so the VSIX stays small.

Excluded: acting on sessions (replying to permissions/forms); a third
"running" marker; event-stream subscription (polling only; the stream is a
later optimization); Projects-tree badges.

## Proposal references

- [P-01](../proposal.md#p-01-indicators-live-in-the-open-windows-view-only): indicators live in this view.
- [P-02](../proposal.md#p-02-detect-opencode-state-via-opencodeclient): client-based detection, fail silent.
- [P-03](../proposal.md#p-03-two-badge-states--waiting-and-finished): waiting and finished markers.
- [P-04](../proposal.md#p-04-clearing-baseline-via-optional-lastfocusedat-heartbeat-field): focus clearing.
- [P-06](../proposal.md#p-06-two-slices--color-first-badges-second): this slice ships P-02 through P-04.

## Behavior and contracts

Service client (new file, proposed `src/opencodeStatus.ts`, vscode-free):

- `discover()` once, lazily: `Service.discover()` from `@opencode/client/service`;
  `OpenCode.make({ baseUrl, headers: Service.headers(endpoint) })`. Failure
  yields an empty status map, not an error (risk R2).
- `poll()` every ~5s while the Open Windows view is visible: session list
  (`GET /api/session`), active map (`GET /api/session/active`), pending
  permission requests (`GET /api/permission/request`), pending forms
  (`GET /api/form`). Exact client method names are resolved against the
  generated types at implementation time.
- Permission/form location scoping (open question from the proposal) resolves
  as: call without location, map each pending item to a session via its
  session id, then to a window. If testing shows the default response is
  location-filtered, fall back to one query per open window directory.
- Pure decision function `attentionFor(folders, lastFocusedAt, data)`:
  - session maps to a window when its `location.directory` equals a folder's
    path or sits inside it (multi-root: any folder); archived sessions ignored.
  - `waiting`: any pending permission or form maps to the window.
  - `finished`: a mapped session is not active and its `time.idle` (fallback
    `time.updated`) is newer than the window's `lastFocusedAt`.
  - Priority: waiting over finished. Missing `lastFocusedAt`: no finished
    marker (P-04).

Registry (`src/windowRegistry.ts`):

- `WindowRecord` gains optional `lastFocusedAt?: number`; `version` stays 1.
  The validator tolerates the extra field (verified, `windowRegistry.ts:55-62`),
  so 0.3.0/0.4.0 windows coexist (risk R3).
- The window tracks `vscode.window.onDidChangeWindowState` focus gains and
  publishes the timestamp on the next 3s heartbeat. Initialized at activation
  when the window starts focused.

Rendering (`src/windowsView.ts`, `src/windowList.ts`):

- Rows gain an attention field from the decision function.
- Colored markers use a `FileDecorationProvider` over a
  `project-switcher-window:` `resourceUri` per row: waiting = badge `!` with
  `charts.orange`; finished = badge `●` with `charts.green`. This delivers the
  accepted colors without displacing the P-05 window icon.
- `accessibilityInformation` and description gain the state in words
  ("OpenCode waiting", "OpenCode finished"); color is never the only signal
  (risk R4).

Build (`package.json`, new `esbuild` devDependency):

- `tsc -p ./` stays for typecheck and test emit. esbuild then bundles
  `src/extension.ts` to `out/extension.js` (`--bundle --format=cjs
  --platform=node --external:vscode --sourcemap`). `main` is unchanged.
- `npm run package` runs compile + bundle, then `vsce package
  --allow-missing-repository --no-dependencies` as today.

## Acceptance criteria

- Given a session in window B's folder finishes while B is unfocused, when the
  view in window A refreshes, then B's row shows the green finished marker
  within one poll plus one heartbeat interval.
- Given a pending permission or form in B's session, when the view refreshes,
  then B's row shows the orange waiting marker, overriding finished.
- Given the user focuses B, when B's heartbeat publishes `lastFocusedAt`, then
  B's finished marker clears everywhere within seconds.
- Given the OpenCode service is stopped, when the view refreshes, then rows
  render without markers and no error row or thrown error occurs.
- Given a window record without `lastFocusedAt`, when badges compute, then it
  can show waiting but never finished.
- Given a session started in a subdirectory of a window's folder, when badges
  compute, then it maps to that window.
- Given `npm test`, when unit tests run, then the decision function covers
  mapping, priority, the `lastFocusedAt` comparison, the missing-field case,
  and service absence.
- Given `npm run package`, when the VSIX builds, then it contains the bundled
  client and stays far below the ~20 MB unbundled tree.

## Manual verification (deferred, user-run)

- Run an opencode session in a second window's folder; let it finish; check
  the green marker appears in the first window's view. (Criterion 1)
- Trigger a permission prompt (for example a disallowed command); check the
  orange marker; answer it and check the marker clears. (Criteria 2-3)
- Stop the OpenCode service; check the view renders normally. (Criterion 4)

## Dependencies and blockers

- None blocking. P-01 through P-04 and P-06 are accepted; the bundler question
  is resolved (esbuild, 2026-11-24).
- Deferred: event-stream subscription; running marker; Projects-tree badges.
- Assumption: permission/form responses carry a session id usable for mapping;
  the per-directory fallback covers the contrary case.

## Implementation evidence

Implemented 2026-11-24. Changed: `src/opencodeStatus.ts` (new, pure decision
module), `src/opencodeClient.ts` (new, ESM-only poller kept out of the test
graph), `src/windowDecorations.ts` (new FileDecorationProvider),
`src/windowRegistry.ts` (optional `lastFocusedAt` + `noteFocused`),
`src/windowList.ts` (row attention), `src/windowsView.ts` (attention text,
resourceUri), `src/extension.ts` (poller, focus tracking, provider
registration), `package.json` (bundle script, deps), `tsconfig.json`
(module/moduleResolution NodeNext — required because `@opencode/client` is
ESM-only with exports-only entry points; emit stays CommonJS). Tests: 13 new
in `src/test/opencodeStatus.test.ts`, 1 new in `src/test/windowList.test.ts`.

Verified: `npm run compile` clean; `npm test` 194 pass, 0 fail; `npm run
package` built `project-switcher-0.5.0.vsix` at 96.18 KB (0.4.0 was 52.43 KB;
unbundled dep tree was ~20 MB). Bundle check: no external
`require("@opencode/...")` remains; `vscode` stays external.

Deviation from the drafted contract: permission/form lists are queried per
window directory from the start (the input types accept `location.directory`),
instead of trying the global default first — the default's scoping could not
be verified without a live pending request, and per-directory is deterministically
correct for few windows.

Unverified without live windows: marker rendering, focus-driven clearing,
per-directory permission/form responses, service-absent behavior in the
running host. See the manual verification steps above.

Installed 2026-11-24: `code --install-extension project-switcher-0.5.0.vsix`
succeeded; `code --list-extensions --show-versions` reports
`local.project-switcher@0.5.0`. Running windows keep 0.4.0 until reloaded.

Refinement 2026-11-24 (user feedback after the live badge test): window rows
were too long. Tree rows have no second line, so the parent path was removed
from the description entirely; descriptions now carry only state text
("Current window", "OpenCode waiting/finished"). Full paths remain in the
tooltip. This amends the open-windows slice-01 description contract
(parent path + marker) by explicit user request. Packaged as
`project-switcher-0.5.1.vsix` (96.22 KB); `npm test` 194 pass, 0 fail.
Installed 2026-11-25: `code --list-extensions --show-versions` reports
`local.project-switcher@0.5.1`.
