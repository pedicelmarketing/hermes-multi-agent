# Worktree B — Auth file restoration & rate limiter

> **Repos:** this worktree's work is split across **two repos** because the bugs are split. Bug 1 is mostly Hermes-side (un-archive the provisioning script + chmod 600 the `.env` files); Bug 5 is MemOS-side (startup gate + rate limiter). You'll open **two PRs**, one per repo.
>
> **Setup before any code:**
> ```bash
> # Hermes side (provisioning script restoration + .env perms)
> cd /home/openclaw/Coding/Hermes
> git fetch origin
> # Worktree already created at ~/Coding/Hermes-wt/fix-auth on branch fix/v1-auth-ratelimit
> cd ~/Coding/Hermes-wt/fix-auth
>
> # MemOS side (startup gate + rate limiter)
> cd /home/openclaw/Coding/MemOS
> git fetch origin
> git worktree add ~/Coding/MemOS-wt/fix-auth -b fix/v1-auth-ratelimit origin/main
> ```
>
> Two PRs to open at the end:
> - Hermes repo `main`: `fix(auth-ops): restore provisioning script + chmod 600 profile envs`
> - MemOS repo `main`: `fix(auth): startup gate + rate-limit + key-prefix BCrypt lookup`

You are fixing **two bugs in the v1 MemOS server's auth surface**. Both came out of the 2026-04-26 blind audit (Zero-Knowledge, Plugin-Integration, and Performance reports).

## Bug 1 (start here — fastest fix in the entire sprint, 2–4 hours)

The MemOS server is configured with `MEMOS_AUTH_REQUIRED=true` and `MEMOS_AGENT_AUTH_CONFIG=<path>`, but the file at that path **does not exist** at the deployed location. As a result, every authenticated `/product/*` call returns HTTP 401 — both demo agents (`research-agent` and `email-marketing-agent`) are memory-blind right now.

The provisioning script that generates `agents-auth.json` has been **archived** at `deploy/scripts/setup-memos-agents.py.archived`. There is also an `agents-auth.json.archived` artifact at the repo root with stale BCrypt hashes — **do not** use that file directly (its hashes are stale and the file is world-readable). Use the script to mint fresh keys.

**Fix:**

1. Un-archive the script: `git mv deploy/scripts/setup-memos-agents.py.archived deploy/scripts/setup-memos-agents.py`. Read the script — confirm it generates fresh keys, BCrypts them, and writes `agents-auth.json`. If the script needs trivial path fixes for the current layout, make them.
2. Run the script with the actual demo agent list (`research-agent`, `email-marketing-agent`, plus any others the deployment expects). Capture the printed raw keys ONCE and stash them somewhere the operator can reach (the script should already do this — don't change behaviour).
3. **Add a startup gate** in `src/memos/api/server_api.py` (or wherever the auth middleware loads): if `MEMOS_AUTH_REQUIRED=true` and the agent-auth file is missing, unreadable, empty, or contains zero hashes — **refuse to start** with a clear stderr message. Currently the server starts happily with an empty registry.
4. **Fix the file-perms regression flagged by the audit (F-06):** the existing `~/.hermes/profiles/research-agent/.env` and `~/.hermes/profiles/email-marketing/.env` are `-rw-rw-r--` (world-readable). `chmod 600` them; have the provisioning script chmod 600 anything it writes.
5. **Delete `agents-auth.json.archived`** from the repo root once the fresh `agents-auth.json` is in place — its BCrypt hashes are a brute-force target.

**Tests:**

- Smoke: with auth file in place, `curl -H "Authorization: Bearer <raw-key>" http://localhost:8001/product/...` returns 200.
- Smoke: with auth file deleted and `MEMOS_AUTH_REQUIRED=true`, the server refuses to start with a clear error message in stderr.
- Smoke: re-run the provisioning script idempotently — no duplicate users/cubes; existing keys preserved unless `--rotate` (or whatever the rotation flag is) is set.
- Inspect: `stat -c '%a' ~/.hermes/profiles/*/env*` is `600`.

---

## Bug 5 (the harder one — 1–2 days)

The audit found **two distinct rate-limiter problems**, both in `src/memos/api/middleware/`:

### F-04 — `RateLimitMiddleware` falls back to in-memory silently

```
memos.api.middleware.rate_limit - WARNING - rate_limit.py:118 - _check_rate_limit_redis
  - Redis rate limit error: Error -3 connecting to redis:6379. Temporary failure in name resolution.
```

`RateLimitMiddleware` tries `redis://redis:6379` (a Docker hostname that doesn't resolve in the production systemd deployment). Every request triggers DNS-resolution failure and falls back to a per-process in-memory store. State is not shared across workers, resets on restart, and the operator gets a WARNING flooding the logs.

**Fix:**

1. Make the Redis URL configurable via `MEMOS_REDIS_URL` env var.
2. If Redis is unreachable, **fail loud once at startup** (FATAL log) rather than warn-on-every-request. Two acceptable behaviours: (a) refuse to start if rate-limiting is required; (b) start in a clearly-labelled "rate-limiting disabled" mode that logs a single startup WARNING and emits a `/metrics` counter. Pick (b) for MVP — easier ops.
3. If Redis is configured but state is in-memory due to fallback, the rate limit still must function for a single-worker deployment — fix the per-process store to persist to SQLite (file-backed) so restarts don't reset the counter.

### F-01 — `AgentAuthMiddleware._authenticate_key()` iterates all 17 agents per request

> With 17 agents in `agents-auth.json`, each invalid-key request consumes ~4.2 s of server CPU before returning 401.

The current implementation BCrypt-checks every agent's hash against the supplied key. This is O(N) BCrypt verifies, and BCrypt is intentionally slow (~250ms per check at cost 12). At 17 agents = 4.2s per bad-key attempt. Two consequences:

- The 60-second rate-limit window is rarely triggered (an attacker can't accumulate 10 attempts in 60s when each takes 4.2s).
- A single bad-key flood DoSes the server.

**Fix (per the audit's own remediation note):**

> Move agent keys to a hash map keyed by `key_prefix` (first 8 chars of raw key). On each request, look up the 2–3 candidates sharing that prefix, then BCrypt-verify only those. Worst case becomes O(prefix_collision) ≪ O(N).

Implementation:

1. When the provisioning script writes `agents-auth.json`, also store a per-agent `key_prefix` (first 8 chars of the **raw** key — not the hash). Update the schema.
2. `AgentAuthMiddleware._load_config()` builds a `dict[prefix, list[(user_id, hash)]]` index.
3. On request, extract first 8 chars of the supplied raw key, look up the bucket, BCrypt-check only those (typically 1, occasionally 2–3 if you have prefix collisions in 17 agents).
4. Existing-key migration: on first boot after upgrade, if an agent's record lacks `key_prefix`, log WARN and force a key rotation. Document the upgrade path in the script header.

**Out of scope:** F-02 (admin key non-const-time comparison) and F-03 (no minimum BCrypt-cost guard). Defer those — they're real but not MVP-blocking. If you have spare time at the end, fix F-02 with `hmac.compare_digest`.

**Tests:**

- Unit: 100 bad-key requests against a 17-agent registry. P50 latency must drop from ~4200ms to under 300ms.
- Unit: 11 wrong-key attempts within 60s now reliably trigger 429 (currently they don't because the window expires before the count reaches 10).
- Integration: kill Redis (or unset `MEMOS_REDIS_URL`); restart server; observe single startup WARNING, no per-request flood.

---

## Working rules

- **Branch:** `fix/v1-auth-ratelimit` (already created).
- **Do not** touch `multi_mem_cube/`, `vec_dbs/`, `graph_dbs/`, MemReader prompts, or the Hermes plugin — those belong to other worktrees.
- **Do not** read `tests/v1/reports/**` or `tests/v2/reports/**` or `memos-setup/learnings/**` or any `CLAUDE.md`.
- Keep Bug 1 and Bug 5 in separate commits.

## Deliver

1. Push to `fix/v1-auth-ratelimit`.
2. PR against `main` titled `fix(auth): restore agents-auth.json + rate-limiter correctness`.
3. PR body includes: (a) confirmation the deployment now starts successfully with a non-empty registry, (b) before/after timing for the bad-key DoS attack (the 4.2s → <300ms number), (c) before/after rate-limit trigger behaviour, (d) confirmation `agents-auth.json.archived` is removed from the repo root.
4. Do NOT merge yourself.

## When you are done

Reply with: branch name, PR number, smoke-test outputs (auth required+missing → start refused; auth present → 200), bad-key timing comparison, and any deferred follow-ups.
