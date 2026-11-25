# Feature: Open Windows indicators

## Problem and desired outcomes

The user runs OpenCode sessions in several project windows at once. The Open
Windows view shows which windows are live, but not which ones need attention.
The user must click through windows to find a finished or blocked OpenCode
session. The current window is also marked only by text ("· Current window"),
which is easy to miss.

Success: the Open Windows view shows, per window, whether its OpenCode session
finished work or waits for input, without opening that window. The current
window stands out by color. Badges clear when the user looks at that window.

## Scope and non-goals

- In scope: an attention badge per window row in the Open Windows view.
- In scope: two badge states — OpenCode waiting for input, OpenCode finished
  since the window was last focused.
- In scope: a colored marker for the current window row.
- In scope: clearing badges when the target window regains focus.
- Out of scope: badges in the Projects tree. Possible follow-up.
- Out of scope: per-session rows or session titles in the view. Badge
  granularity is the window.
- Out of scope: acting on the session (replying to permissions or forms) from
  the extension. The badge only reports state.
- Out of scope: starting the OpenCode service when it is not running.

## System context and constraints

- Observed: the Open Windows view renders rows from `WindowRegistry.list()`
  with a per-row `current` flag (`src/windowsView.ts`, `src/windowList.ts:25`).
- Observed: every window heartbeats a record every 3s; records go stale after
  15s (`src/windowRegistry.ts:139-170`, `STALE_AFTER_MS`).
- Observed: the `WindowRecord` validator accepts extra fields, so an optional
  new field stays compatible with extension 0.3.0 windows
  (`src/windowRegistry.ts:55-62`).
- Observed (2026-11-20, live): OpenCode V2 runs a shared background service.
  `opencode service status` reported `http://127.0.0.1:49374` (v2.3.2). The
  service registers at `~/.local/state/opencode/service.json` with
  `{id, version, url, pid, password}`.
- Observed (2026-11-20, live): `GET /api/session` returns all sessions with
  `location.directory`, `time.busy`, `time.idle`, and `outcome`.
  `GET /api/session/active` returns the running map.
  `GET /api/permission/request` and `GET /api/form` return pending prompts.
  Basic auth `opencode:<password>` was verified against the live service.
- Observed: `@opencode/client` ships `Service.discover()` (no process start)
  and `Service.headers(endpoint)` for auth, plus typed resources and an event
  subscription API (https://opencode.ai/docs/build/client).
- User fact (2026-11-20): an "update" means the session finished its work or
  waits for input. Badges clear when that window regains focus.
- User fact (2026-11-23): detection uses `@opencode/client`, not a hand-rolled
  client or SQLite reads.
- Unknown: whether `GET /api/permission/request` without a location returns
  global results; observed defaulting to the service home directory with empty
  data. A per-directory query parameter exists as fallback.
- Assumption: one OpenCode session per window directory is not required;
  several sessions may map to one window.

## Sources

- `src/windowsView.ts`: row rendering and current-window context value.
- `src/windowList.ts:19-31`: row assembly, current flag, ordering.
- `src/windowRegistry.ts:55-62,139-170`: record validation and heartbeat.
- `~/.local/state/opencode/service.json`: service registration shape.
- https://opencode.ai/docs/api: session, permission, form, event routes.
- https://opencode.ai/docs/build/client: `Service.discover`, `Service.headers`,
  typed client, live-only event subscriptions.
- Live read-only checks against the running service, 2026-11-20.
- User confirmations in the 2026-11-20/23 design sessions. The user authorized
  saving this design.

## Design and delivery

- [Proposal and agreement history](proposal.md)
- [Feature index](../README.md)
- [Slice 01: Colored current window](slices/01-current-window-color.md):
  implemented and unit-tested; manual runtime verification pending.
- [Slice 02: OpenCode attention badges](slices/02-opencode-attention-badges.md):
  drafted; awaiting acceptance.
