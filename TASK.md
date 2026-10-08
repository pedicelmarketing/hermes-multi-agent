# TASK: fix/paperclip-agent-auth — Override Hermes employee prompt so delegation succeeds

## Goal

Make Paperclip employees (Research Agent, Email Marketing Agent) complete delegated tasks within their turn budget. Today they time out at 600s because the `hermes_local` adapter's default prompt tells them to `curl` the Paperclip API to mark issues done, but Paperclip is in `"authenticated"` deployment mode and no bearer token is injected into the subprocess. Replace the prompt template with one that lets `stdout` be the completion.

## Context

Read [2026-04-21-paperclip-hermes-adapter-auth-gap.md](../../../../memos-setup/learnings/2026-04-21-paperclip-hermes-adapter-auth-gap.md) first — it explains the full failure mode, why the API-callback path is unnecessary, and why we picked Option 1 (prompt override) over Options 2–4.

Key fact: [execute.js:388-416](/home/linuxbrew/.linuxbrew/lib/node_modules/hermes-paperclip-adapter/dist/server/execute.js) already captures subprocess `stdout` as the agent's reply. Paperclip stores that as the issue's completion message. No API callback required.

Prerequisite: PR #7 (`wire/paperclip-employees`) is merged. Both employees exist in Paperclip's DB.

## Scope

1. Write a prompt template that:
   - Gives the agent its identity (`{{agentName}}`, `{{agentId}}`, `{{companyId}}`) for context only.
   - States the task (`{{taskTitle}}`, `{{taskBody}}`).
   - Instructs the agent to do the work and output the final answer as its last message.
   - **Explicitly tells the agent NOT to call any Paperclip API.** The answer itself is the completion.
   - Preserves the three conditional sections (`{{#taskId}}`, `{{#commentId}}`, `{{#noTask}}`) so the template works for all wake reasons (assignment, comment, heartbeat).
2. Apply this template to both Hermes employees' `adapterConfig.promptTemplate` field in Paperclip's DB (`agents` table).
3. Update the v2 creation scripts (`create-research-employee.sh`, `create-email-employee.sh`) to include the new `promptTemplate` in the payload so fresh installs use it from the start.
4. Delegation smoke test: assign a trivial task to each employee, confirm completion within 60 seconds, inspect the captured response.

## Files to touch

- `scripts/paperclip/v2/prompts/hermes-employee.mustache` (new) — the template. Mustache-style `{{var}}` and `{{#cond}}...{{/cond}}` syntax, same as adapter expects.
- `scripts/paperclip/v2/create-research-employee.sh` — read the template file, embed in the POST payload as `adapterConfig.promptTemplate`.
- `scripts/paperclip/v2/create-email-employee.sh` — same.
- `scripts/paperclip/v2/apply-prompt-override.sh` (new) — one-shot script that `UPDATE agents SET adapterConfig = jsonb_set(adapterConfig, '{promptTemplate}', $template)` for existing agents. Idempotent. Reads the template file so the DB always matches the committed source.
- `scripts/paperclip/v2/README.md` — document the template, the override script, and the test procedure.

**Do NOT touch:**
- `/home/linuxbrew/.linuxbrew/lib/node_modules/hermes-paperclip-adapter/**` — leave the adapter package alone. We override per-agent config, not the package default.
- Paperclip's `deploymentMode` setting. Stay in `"authenticated"`.

## Acceptance criteria

- [ ] Template file exists at `scripts/paperclip/v2/prompts/hermes-employee.mustache`.
- [ ] Template does NOT contain `curl` calls targeting the Paperclip API.
- [ ] Template preserves `{{#taskId}}`, `{{#commentId}}`, `{{#noTask}}` conditional sections.
- [ ] `apply-prompt-override.sh` runs idempotently — re-running doesn't corrupt the DB (no-op if template already matches).
- [ ] Both `create-*-employee.sh` scripts now include `promptTemplate` in their payload.
- [ ] **Delegation smoke test, Research Agent:** assign a simple task (e.g. "write one sentence summarizing HTTP status codes") → agent completes within 60s → issue status transitions to `done` via Paperclip's own run-handler (NOT via agent-initiated API call) → captured response is coherent.
- [ ] **Delegation smoke test, Email Marketing Agent:** same with a different marker.
- [ ] Run log shows ZERO HTTP 401 errors.
- [ ] Run log shows agent completed in < 5 turns.

## Test plan

```bash
# Apply the override to existing agents
cd ~/Coding/Hermes
source ~/.paperclip/board-token.env   # exports PAPERCLIP_BOARD_TOKEN + PAPERCLIP_URL
bash scripts/paperclip/v2/apply-prompt-override.sh

# Marker for collision avoidance
TS=$(date +%s)
MARKER="FIX-AGENT-AUTH-$TS"

# Research assignment
curl -sf -X POST "$PAPERCLIP_URL/api/companies/$COMPANY_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"$MARKER: one-sentence summary of HTTP status codes\",
    \"assigneeAgentId\": \"$RESEARCH_AGENT_ID\",
    \"status\": \"todo\",
    \"priority\": \"high\"
  }"

# Wait up to 90s, then check status
sleep 90
curl -sf "$PAPERCLIP_URL/api/issues?q=$MARKER" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
  | jq '.[] | {title, status, assigneeAgentId, completedAt}'

# Check the run log for 401s (expect none)
curl -sf "$PAPERCLIP_URL/api/companies/$COMPANY_ID/issues/<issue-id>/runs" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
  | jq '.[].logs' | grep -c "401\|Board access required"
# expected: 0
```

## Out of scope

- Do NOT patch `hermes-paperclip-adapter` / `adapter-utils` upstream. File a separate follow-up issue for Option 3 (scoped JWT minting) but don't implement it here.
- Do NOT expand to additional agent profiles beyond the two existing employees.
- Do NOT change the adapter's `buildPaperclipEnv()` — we're working entirely via `adapterConfig.promptTemplate`.
- Do NOT introduce `PAPERCLIP_BOARD_TOKEN` into `adapterConfig.env` (Option 2 rejected — security regression).

## Commit / PR

- Branch: as assigned (`claude/*` or `fix/paperclip-agent-auth`)
- PR title: `fix(paperclip): override hermes_local prompt so agents complete via stdout (no API callback)`
- PR body: include raw run log showing pre-fix timeout + post-fix completion within turns, and the assertion that `grep -c "401"` returns 0 on the run log.

## Appendix — why not Option 2/3/4

- **Option 2 (inject board token)** — leaks a powerful long-lived token into every subprocess for its full lifetime. Security regression.
- **Option 3 (scoped JWT)** — correct upstream fix. File as separate issue against `hermes-paperclip-adapter`. Requires understanding Paperclip's JWT claim format. Out of scope for this sprint.
- **Option 4 (unauthenticated Paperclip)** — removes a security control we deliberately enabled. The fact that tower is Tailscale-network-scoped isn't a reason to disable server-side auth.
