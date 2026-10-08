# TASK: hermes/mcp-integration — Wire external MCP servers for Hermes + Claude Code

## Goal

Configure at least 3 useful MCP servers for both Hermes workers and the Claude Code CEO. Close the baseline-audit MCP 0/10 gap.

## Context

Baseline audit scored MCP 0/10: "external tool servers not connected." Claude Code supports MCP natively via `claude mcp add`. Hermes supports external tools via its plugin mechanism (pattern: a Hermes plugin that wraps an MCP client can bridge MCP tools into Hermes).

Candidate MCP servers to wire up:
- **filesystem MCP** — safe filesystem access outside the working dir
- **github MCP** — GitHub API access (Paperclip context: PR review, issue mgmt)
- **sqlite MCP** — query SQLite databases (useful for inspecting plugin state)
- **postgres MCP** (optional) — for databases agents need to query
- **memos-hub MCP** — the one from [ceo-hub-access](../wire/ceo-hub-access.md) worktree (may overlap)

This is independent of the memory migration. Run anytime after Stage 1.

## Scope

1. Pick 3 MCP servers from the list above (or user's preference).
2. Install each and register with Claude Code (`claude mcp add <name> ...`).
3. For each, test that a Claude Code session can invoke one tool from the server.
4. For Hermes: document the path to bridge MCP into Hermes via a plugin wrapper. If bandwidth permits, implement one bridge (e.g., github MCP → Hermes tool). Otherwise, document as follow-up.
5. Update `deploy/install.sh` to install + register the MCP servers on new deployments.

## Files to touch

- `scripts/mcp/install-filesystem-mcp.sh`
- `scripts/mcp/install-github-mcp.sh`
- `scripts/mcp/install-sqlite-mcp.sh`
- `scripts/mcp/README.md` — what's installed, what tools each exposes, how to add more
- `deploy/install.sh` — call the install scripts

## Acceptance criteria

- [ ] 3 MCP servers installed and registered in Claude Code (`claude mcp list` shows them)
- [ ] From a fresh Claude Code session, at least one tool from each MCP server works (invoke + observe result)
- [ ] `deploy/install.sh` includes the MCP install steps
- [ ] Bridge plan for Hermes exists (implemented or documented as follow-up)
- [ ] No credentials committed; all tokens/keys kept in env files NOT in the repo

## Test plan

```bash
# After install:
claude mcp list
# Expected: 3 servers + any existing

# Per MCP, test one tool:
# (specific command depends on how Claude Code invokes MCP tools — use Claude's UI to confirm discovery)
```

## Out of scope

- Do NOT install more than 3 MCP servers — scope creep.
- Do NOT build custom MCP servers; use official / community ones.
- Do NOT change Hermes's plugin loader — if bridging is complex, document as follow-up.

## Commit / PR

- Branch: as assigned
- PR title: `hermes(mcp): wire 3 MCP servers (filesystem, github, sqlite) for CEO + workers`
- PR body: list of tools now available, one invocation example per server.
