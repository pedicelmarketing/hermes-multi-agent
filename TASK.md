# Worktree D — Auto-capture in the Hermes plugin

> **Repo:** all edits in this worktree happen in the **Hermes repo** at `/home/openclaw/Coding/Hermes`. The plugin source lives at `deploy/plugins/_archive/memos-toolset/` (it was archived during the v2 migration sprint — see `deploy/plugins/_archive/memos-toolset/DEPRECATED.md` for the rollback path). You will:
>
> 1. Un-archive the plugin to its working location:
>    ```bash
>    cd ~/Coding/Hermes-wt/fix-auto-capture
>    git mv deploy/plugins/_archive/memos-toolset deploy/plugins/memos-toolset
>    ```
> 2. Implement the v1.0.3 auto-capture hook in `deploy/plugins/memos-toolset/`.
> 3. Coordinate with Worktree B — that worktree restores the provisioning script and `agents-auth.json` so the plugin has something to authenticate against. Don't merge D before B's Hermes-side PR lands, or the smoke test will fail.
>
> Push to and PR against the **Hermes repo's `main`**.

You are implementing **the v1.0.3 auto-capture feature in the `memos-toolset` Hermes plugin**. This is the single biggest demo-quality gap from the audit: the plugin is currently v1.0 with no auto-capture, so agents must explicitly call `memos_store` after every relevant turn. The Functionality audit graded this **0/10** because the feature is documented but missing.

The CEO + research-agent + email-marketing-agent demo will feel clunky without it (every skill needs to remember to call `memos_store`; if it forgets, the memory is lost forever). Adding it cleanly turns "explicit-call-required" into "memory just works in the background."

## Required behaviour after the fix

1. **Auto-capture hook.** After each agent turn (or each tool call worth remembering — see filter rules below), the plugin auto-invokes the equivalent of `memos_store(content=<turn>, metadata=<context>)` — without the agent's prompt or the LLM ever seeing the call.
2. **Filter rules.** Not every turn deserves to be captured. Skip:
   - Pure tool-call boilerplate / metadata turns (e.g. retry-loop control messages).
   - Turns shorter than ~50 chars (cheap heuristic — tune to taste).
   - Turns that are exact-content duplicates of the last 3 captured turns from the same session (cheap dedup; the server-side dedup will catch the rest).
   - Turns the agent explicitly marks `no-capture` via a sentinel in metadata (give skill authors an opt-out).
3. **Failure isolation.** A capture failure (network blip, server returns 500, plugin transient error) **must not break the agent's turn**. Log at WARN with `(session_id, turn_id, error)`; queue the capture for retry; continue. The agent should not stall waiting for memory.
4. **Local retry queue.** When the server is unreachable, queue captures locally (SQLite or a file under `~/.hermes/plugins/memos-toolset/queue/`). Drain the queue on next successful capture.
5. **Identity.** Capture uses the same identity model the existing `memos_store` already uses — read from `~/.hermes/profiles/<agent>/.env`. The LLM cannot override.
6. **Observability.** Every capture (success, failure, skip-reason) emits a structured log line so the operator can see what's being captured and why.

## Files in scope

The plugin source you're editing lives at `deploy/plugins/memos-toolset/` after un-archiving (see banner above). Existing files:

- `deploy/plugins/memos-toolset/__init__.py`
- `deploy/plugins/memos-toolset/handlers.py` — current `memos_store` / `memos_search` handlers; reuse this code path
- `deploy/plugins/memos-toolset/schemas.py`
- `deploy/plugins/memos-toolset/plugin.yaml`

Read all four first to understand the existing tool-handler structure. Then add:

- New: a hook registration that fires `post_turn` (or whatever Hermes' lifecycle callback is — discover from Hermes core docs at `~/.hermes/skills/` or the plugin's own README).
- New: `deploy/plugins/memos-toolset/auto_capture.py` — the hook + filter rules.
- New: `deploy/plugins/memos-toolset/capture_queue.py` — local SQLite retry queue.
- Tests under `deploy/plugins/memos-toolset/tests/` (mirror existing test patterns; don't introduce a new framework).

The deployed runtime location is `~/.hermes/plugins/memos-toolset/`. After your PR merges, the operator will rsync or symlink the source to the runtime location — don't try to edit the runtime location directly.

## Working rules

- **Branch:** `fix/v1-auto-capture` (already created).
- **Do not** touch the MemOS server source under `src/memos/` — this worktree is plugin-side only.
- **Do not** read `tests/v1/reports/**` or `tests/v2/reports/**` or `memos-setup/learnings/**` or any `CLAUDE.md`.
- Inspect the existing `memos_store` and `memos_search` code paths first — the auto-capture call should reuse the same HTTP client, identity loading, and error handling. Don't rebuild a parallel pathway.
- Coordinate with Worktree A on the `/health/deps` endpoint — once that lands you can use it for proactive availability checks (don't queue captures when the server is known to be up; quietly queue when it's down).

## Tests (must all pass)

- Unit: filter rules — short turn skipped, no-capture sentinel skipped, exact dedup skipped.
- Integration: end-to-end with a sandbox agent — issue 5 turns, assert 5 memories appear server-side.
- Integration: server-down — issue 3 turns with port 8001 firewalled, restore connectivity, assert all 3 memories eventually land via queue drain.
- Integration: capture failure does NOT block the agent — turn completes successfully even when capture errors.
- Integration: identity isolation — agent A's captures land in A's cube, not B's, even if A's prompt tries to inject `cube_id=B`.

## Deliver

1. Push to `fix/v1-auto-capture`.
2. PR against `main` titled `feat(plugin): v1.0.3 auto-capture in memos-toolset`.
3. PR body includes: (a) which Hermes lifecycle hook you used and why, (b) filter rule list, (c) queue persistence model, (d) test outputs, (e) any plugin-version bump (memos-toolset should publish as v1.0.3 once this lands — coordinate with whoever owns the plugin release).
4. Do NOT merge yourself.

## When you are done

Reply with: branch name, PR number, integration test outputs, the new plugin version number, and any deferred follow-ups (e.g. richer dedup, cross-session deduplication).
