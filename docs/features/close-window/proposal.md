# Proposal: Close window

## Status

Accepted. P-01, P-02, and P-04 were accepted as drafted on 2026-11-20; P-03 scope was accepted the same day and its placement on 2026-11-23 with slice 01. Acceptance does not authorize implementation, which was authorized separately the same day. The B-09 delivery condition still gates shipping: the verification checklist below must pass first.

Realizes accepted baseline behavior [B-09](../project-switcher/proposal.md#b-09-close-a-selected-window-separately-from-removing-a-project).

## Proposed approach

Extend the registry mailbox with a close request. The sender writes an expiring
request into the target window's inbox. The target instance validates it, replies,
then runs `workbench.action.closeWindow` on itself. VS Code applies its own
unsaved-change handling. The sender confirms closure by watching the target's
session record disappear.

### P-01: Close request through the existing registry mailbox

- Status: accepted.
- Approach: add a versioned close-request schema beside the focus request. Reuse the
  per-target inbox, the 250ms poll loop, atomic writes, and strict validation.
  The message carries request id, sender, target session, and expiry. It carries no
  command id, path, or arbitrary payload; the receiver runs one fixed action.
- Context and evidence: the focus protocol already does destination routing and
  validation (`src/windowRegistry.ts:229-295`). Upstream `CloseWindowAction` closes
  its executing window; see overview sources. `FocusWindowAction` proved the
  self-executed pattern in the documented focus tests.
- Alternatives and tradeoffs: native `workbench.action.switchWindow` picker has close
  buttons, but its window list and host service are internal, not extension API
  (recorded in [P-08](../project-worktrees/proposal.md#p-08-local-registry-with-destination-side-native-focus-action)).
  Calling private VS Code services is brittle. The mailbox reuses verified machinery.
- Consequences: mixed extension versions fail closed. An old receiver validates
  strictly, deletes the unknown request, and never replies; the sender times out and
  reports the target did not respond. No window closes.
- Confirmation: accepted 2026-11-20 ("Accept as drafted").

### P-02: Reply means dispatched; disappearance confirms closed

- Status: accepted.
- Approach: the receiver writes its reply before executing the close, because its
  extension host dies with the window. The reply acknowledges dispatch only. After an
  ok reply, the sender waits a bounded time for the target's session record to
  disappear, then reports "closed". If the record stays, the sender reports the
  window is still open; the user may have canceled the native unsaved-changes prompt.
- Context and evidence: normal shutdown removes the record (`src/windowRegistry.ts:345-352`).
  A killed host stops its heartbeat; records go stale after 15s (`STALE_AFTER_MS`).
- Alternatives and tradeoffs: trusting the reply alone is wrong when the user cancels
  the native prompt. Waiting only for staleness (up to 15s) is slow; watching for
  record removal gives a fast, honest signal in the normal case.
- Consequences: a crash during the wait also removes the record; the reported outcome
  ("window closed") stays true either way. Wait bounds and poll interval are slice
  contracts.
- Confirmation: accepted 2026-11-20 ("Accept as drafted").

### P-03: Close action on every Open Windows row

- Status: accepted, including placement.
- Approach: inline `$(close)` action and context-menu entry on `windowCurrent` and
  `windowOther` rows. Command Palette command `projectSwitcher.closeWindow` offers the
  same action through a quick pick. Clicking a row still focuses; close is a separate
  explicit control.
- Context and evidence: user selected "All windows" on 2026-11-20. Row context values
  exist (`src/windowsView.ts:14`). Menu contributions follow the existing
  `view/item/context` pattern (`package.json:68-73`).
- Alternatives and tradeoffs: hiding the action on the current row avoids self-close,
  but the user chose uniform coverage. A picker-only action avoids icon clutter but
  hides the feature.
- Consequences: closing the current window closes the extension host running the view;
  no confirmation beyond VS Code's own unsaved-change handling is added.
- Confirmation: scope accepted 2026-11-20 ("All windows"); placement accepted 2026-11-23 via slice 01 contracts 10-13.

### P-04: Current window closes directly, without a mailbox round-trip

- Status: accepted.
- Approach: when the target record is this window's own session, execute
  `workbench.action.closeWindow` locally and skip request/reply.
- Context and evidence: the focus command already special-cases self
  (`src/windowRegistry.ts:231`).
- Alternatives and tradeoffs: routing self-close through the mailbox adds delay and
  failure modes for no benefit.
- Consequences: the initiating host closes; there is no sender left to report outcome.
  The action is fire-and-forget by nature.
- Confirmation: accepted 2026-11-20 ("Accept as drafted").

## Sequence flows

```mermaid
sequenceDiagram
  participant U as User
  participant S as Sender window
  participant R as Registry (files)
  participant T as Target window
  U->>S: Close action on a row
  S->>R: Read target record; check staleness
  S->>R: Write close request to target inbox (expiring)
  loop every 250ms
    T->>R: Poll inbox
  end
  T->>R: Validate request; write reply
  T->>T: Execute workbench.action.closeWindow
  Note over T: VS Code owns unsaved-change handling.<br/>Hot exit preserves edits; otherwise native prompt.<br/>Cancel keeps the window open.
  S->>R: Read reply, then watch target record
  alt record disappears within bound
    S->>U: Report closed
  else record remains
    S->>U: Report still open (possibly canceled)
  else no reply before expiry
    S->>U: Report target did not respond; nothing closed
  end
```

Caption: proposed close flow (P-01, P-02). Registry mailbox, validation, and record
lifecycle are observed implementation (`src/windowRegistry.ts`); the close request,
reply ordering, and sender-side wait are proposed. Source: upstream `CloseWindowAction`,
inspected 2026-11-20. Unconfirmed: cross-version command behavior.

## Verification required (B-09 delivery condition)

Define and pass these checks before declaring a slice ready:

1. The selected window closes; no other window closes, including a second window on
   the same folder.
2. A dead or unresponsive target reports failure; no window closes.
3. Hot exit off: the native prompt appears; Cancel leaves the window and edits intact;
   the sender reports the window is still open.
4. Hot exit on (default): the window closes; edits reappear as restored backups on
   reopen. Record observed VS Code behavior; do not promise a prompt.
5. The saved project entry of the closed window's folder survives.
6. A multi-root window closes as a unit; this is documented, not special-cased.
7. Closing the current window from its own row works.
8. A close request to a different profile's participating window works, or the limit
   is recorded. Registry sharing is accepted; cross-profile focus tests inform this.
9. Record VS Code and OS versions for every check.

## Relevant risks and proposed mitigations

- Wrong window closed (blocking): target by validated session record; check liveness
  before sending; bounded expiry; fail closed on timeout. Mitigated by the
  verification checklist above. Owned by this feature's first slice.
- Data loss through unsaved edits: the extension never saves or discards. VS Code
  applies hot exit or its native prompt. Acceptance criteria must cover both settings.
- Mixed extension versions (deferred): old receivers drop unknown requests; senders
  time out safely. Record as a known limitation; no migration needed.
- Privacy: requests carry only ids and expiry. Paths and branch names stay in the
  existing record schema. Same-user local storage is not a security boundary; this
  matches the recorded registry stance.
- Accessibility: the action needs a text label, context-menu presence, and Command
  Palette reach. Inline-icon-only actions are not sufficient.
- Reliability: a duplicate request finds no live target and fails closed. A lost reply
  still ends with the record watch; the sender never retries silently.

## Open questions and assumptions

- Wait bound and poll interval for record disappearance: slice contract, proposed 10s.
- Whether to disable the close action while a focus request to the same target is in
  flight: deferred; both protocols are idempotent against dead targets.
- Exact inline icon and menu ordering: slice detail.

## Agreement and change history

| Event | Item | Confirmation and rationale | Impact |
| --- | --- | --- | --- |
| 2026-11-20 session | Feature | User requested "someway to close windows in the extension." | Realizes B-09; delivery condition unchanged. No implementation authorized. |
| 2026-11-20 session | P-03 scope | User selected "All windows": every row, including the current window, gets the close action. | Scope accepted; placement and mechanism remain proposed. |
| 2026-11-20 session | P-01, P-02, P-04 | User selected "Accept as drafted" for the mailbox close request, disappearance-based confirmation, and direct self-close. | Mechanism contracts accepted; wait bounds and icon details remain slice-level. P-03 placement stays proposed. |
| 2026-11-23 session | P-03 placement, slice 01 | User read the drafted slice and said "They seem right. Implement it." | Placement accepted; slice 01 marked ready; execution authorized under the implementor role. Manual verification remains the blocking ship gate. |
| 2026-11-23 session | Delivery condition | User chose "Package + install 0.4.0" for the default profile, then said "but I want to put the package 0.4.0". | 0.4.0 installed before the manual checklist ran; verification now happens live in the default profile. B-09's condition remains recorded for any wider distribution. |

## Implementation evidence

Slice 01 code complete and unit-tested (2026-11-23): `rtk npm run compile` clean,
`rtk npm test` 151 pass / 0 fail. Changed: `src/windowRegistry.ts`,
`src/projectCommands.ts`, `src/extension.ts`, `package.json`; new
`src/test/closeWindow.test.ts`. See the
[slice evidence](slices/01-close-a-listed-window.md#implementation-evidence).
Runtime window closing remains unverified; the manual verification checklist is the
blocking ship gate. Pre-existing observed code: registry mailbox and focus protocol
(`src/windowRegistry.ts`), Open Windows view (`src/windowsView.ts`). Upstream command
evidence cited in the overview.
