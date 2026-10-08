# TASK: hermes/fallback-model — Add LLM fallback to Hermes config

## Goal

Configure Hermes to automatically fall back to a secondary LLM provider if the primary (MiniMax M2.7) is unavailable. Close the "Resilience 2/10" baseline gap from the 2026-04-06 setup audit.

## Context

From `HERMES-SETUP-AUDIT-2026-04-06.md` — Fallback & Resilience scored 2/10:
> "Single MiniMax M2.7 provider. No fallback_model — MiniMax down = everything dead. Single API key. `fallback_providers: []`."

The fix is configuration, not code. Hermes supports `fallback_providers` in `config.yaml`. DeepSeek V3 is already configured as MEMRADER — we have a key and credentials available, so use it as the fallback LLM too.

This worktree is independent of the memory migration. Run anytime.

## Scope

1. Add `fallback_providers` stanza to `~/.hermes/config.yaml` with DeepSeek V3 as the first fallback.
2. Mirror the change in the repo's deploy config template (`deploy/config/config.yaml`) so new deployments get the fallback.
3. Test failover: temporarily break the primary provider (invalidate MiniMax key in a test profile) and confirm Hermes retries via DeepSeek.
4. Document the fallback behavior in `deploy/README.md`.

## Files to touch

- `deploy/config/config.yaml` — add `fallback_providers` section (the source template)
- `deploy/README.md` — document the fallback row in the Configuration Summary table
- `~/.hermes/config.yaml` — mirror on the live machine (not committed since `~/.hermes/` isn't in the repo, but document the change)

## Acceptance criteria

- [ ] `~/.hermes/config.yaml` has `fallback_providers` listing at least DeepSeek V3
- [ ] `deploy/config/config.yaml` has the same
- [ ] `hermes config show fallback_providers` (or equivalent) confirms the value at runtime
- [ ] Negative test: temporarily set `MINIMAX_API_KEY=invalid` in a test profile, send a chat request — Hermes completes the request via the fallback provider (NOT by hanging or erroring)
- [ ] Restore the valid key after the test
- [ ] Baseline audit's Resilience score rationale updated in a follow-up doc (minimum: note in PR body)

## Test plan

```bash
# Before (confirm current state):
hermes config show 2>&1 | grep -i fallback

# After configuring:
cp deploy/config/config.yaml ~/.hermes/config.yaml
hermes config show | grep -i fallback

# Force failover by corrupting the primary key in a disposable profile:
echo "MINIMAX_API_KEY=sk-test-invalid" > /tmp/broken.env
HERMES_ENV=/tmp/broken.env hermes chat -q "one-line test" -p default
# Expect: request succeeds via DeepSeek, log indicates fallback fired
```

## Out of scope

- Do NOT add a third-tier fallback (Gemini, Anthropic) unless trivially easy.
- Do NOT change the primary provider away from MiniMax.
- Do NOT add credential-pool rotation (that's a separate concern).

## Commit / PR

- Branch: as assigned
- PR title: `hermes(config): add DeepSeek V3 as LLM fallback — closes resilience 2/10 gap`
- PR body: before/after config snippets, failover test evidence.
