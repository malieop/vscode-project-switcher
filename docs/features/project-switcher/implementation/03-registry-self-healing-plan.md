# Window Registry Self-Healing Plan

## Problem

Stale state in `window-registry-v1/` from dead VS Code processes blocks switching forever:

- Unreleased claim locks (`claims/<hash>.json`) → `busy` error: "Another open request is pending…"
- Stale session records with dead pids (`sessions/<id>.json`) → `find()` throws → `discovery` error: "Open project windows could not be checked…"
- Stale `.guard` dirs (process killed between `mkdir` and `rmdir`) → `claim()` busy forever.

Current recovery: quit all VS Code windows and delete the folder. Verified on this machine: 3 stale claims + 2 dead-pid session records for `~/repos/central` (pids 47049, 30670 dead).

## Goal

Registry heals itself. No manual cleanup, no window restart. Worst case: retry after the claim TTL.

## Changes

### `src/windowRegistry.ts`

1. **Add constants**
   - `CLAIM_TTL_MS = 5 * 60_000` — claim locks older than 5 min (by file mtime) are abandoned. Far beyond worst-case window boot + registration (~30s).
   - `GUARD_TTL_MS = 60_000` — guard dirs are held for single file ops; older than 60s is dead.
2. **Add `pidAlive(pid)` helper** — `process.kill(pid, 0)`; `ESRCH` → false, `EPERM` → true.
3. **Expire claims lazily in `claim()`** — inside the existing guard: if lock file exists and `mtimeMs` is older than `CLAIM_TTL_MS`, `fs.rm` it and proceed to write the new claim. Otherwise return `undefined` (busy) as today.
4. **Heal stale records in `find()`** — replace the blanket throw (line 183): for each stale matching record, if its pid is dead, delete the record file and treat it as absent. Throw "The previous project window could not be verified" only when a stale record's pid is still alive (true ambiguous case, preserved).
5. **Sweep on `start()`** — after the mkdir loop, remove: invalid/unreadable session files, stale-by-mtime claims, and backdated `.guard` dirs (`fs.rmdir`, ignore errors). Covers crashes that happened before this window started.
6. **`list()` stays strict** — atomic writes make corrupt files unlikely; fail loud if the registry itself is broken.

### `src/test/windowRegistry.test.ts`

- Expired claim (backdate with `fs.utimes`) is reclaimed: `claim()` returns a token.
- Fresh claim still blocks: `claim()` returns `undefined` (existing tests cover).
- Stale record with dead pid (e.g. `2**30`) → `find()` returns `undefined` and deletes the file.
- Stale record with live pid (`process.pid`) → `find()` still throws.
- `start()` sweep removes a backdated `.guard` dir and an expired claim.
- Integration: seeded stale dead-pid record → `switchProject` reaches `opened` (extend the existing `dependencies()` harness near line 135).

### Docs

- Update `docs/features/project-switcher/overview.md` if it documents the fail-closed registry behavior.

## Decisions

- **TTL 5 min**: bounds the duplicate-window risk to retries within 5 min of dispatch while a window is genuinely still booting. Conservative; can tighten later.
- **Pid reuse**: mitigated by requiring record to be stale AND pid dead before deleting.
- **No schema change**: claim age comes from file mtime; `OpenClaim` untouched.

## Verification

1. `npm test` (compiles + runs `node --test out/test/*.test.js`).
2. Manual: keep the currently broken `window-registry-v1` state, launch the Extension Development Host, switch to `central` → opens without manual cleanup.
