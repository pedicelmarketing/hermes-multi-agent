# TASK: hermes/github-webhook — GitHub PR auto-review webhook handler

## Goal

Set up a GitHub webhook → Hermes handler that posts an automated review comment on new PRs in the user's repos. Close baseline audit's "Webhooks 0/10" gap.

## Context

Baseline audit: "Webhooks 0/10 — GitHub PR auto-review not configured." The goal is: when a PR opens on `sergiocoding96/hermes-multi-agent` or `sergiocoding96/MemOS`, a Hermes worker (possibly `research-agent` or a new `code-reviewer` profile) reads the diff, drafts a review, and posts as a PR comment.

This is independent of memory migration — useful on its own, runs anytime.

## Scope

1. Set up a webhook receiver — simplest path: a small Flask/FastAPI service on tower (or a Cloudflare Worker, or Hermes's own API server if exposed).
2. Register the webhook in the target GitHub repo(s) for `pull_request` events (opened, synchronize).
3. On webhook receipt, spawn a Hermes session with a `code-review` skill (or use an existing skill) that pulls the diff and posts a comment via `gh api`.
4. Security: HMAC-verify the webhook signature; allowlist the repos.
5. Test: open a test PR on a scratch repo, confirm the automated review appears.

## Files to touch

- `scripts/webhooks/github-pr-review/server.py` (or `.ts` / `.sh`) — the receiver
- `scripts/webhooks/github-pr-review/README.md` — setup + run
- `scripts/webhooks/github-pr-review/systemd/` — optional service unit
- `skills/code-review/SKILL.md` (may already exist in badass-skills — check first) — the review skill
- `.github/workflows/` — optional, only if we go the GitHub Actions route instead of webhooks

## Acceptance criteria

- [ ] Webhook receiver running (on tower or similar reachable-by-GitHub location)
- [ ] HMAC signature verification enabled
- [ ] Webhook registered on at least one test repo
- [ ] Test PR triggers an auto-review comment within 60 seconds of opening
- [ ] Review comment is non-empty and relevant to the diff
- [ ] No false positives (e.g., review doesn't fire on non-PR events)
- [ ] Repo allowlist enforced — PRs on unlisted repos are ignored

## Test plan

1. Set up a scratch repo on your GitHub.
2. Register the webhook pointing at tower's public endpoint (tailscale funnel, ngrok, or direct if IP allows).
3. Open a trivial PR with a 3-line diff.
4. Wait ≤60s. Verify a review comment appears on the PR.
5. Inspect the comment — does it reference the actual diff? Helpful or generic?

## Out of scope

- Do NOT set this up on the real `hermes-multi-agent` or `MemOS` repos until after scratch testing.
- Do NOT build a complex review pipeline (unit tests, security scans). One review comment per PR is the goal.
- Do NOT install GitHub Actions if webhook + tower can do the job — GitHub Actions cost credits.

## Commit / PR

- Branch: as assigned
- PR title: `hermes(webhooks): GitHub PR auto-review via webhook + Hermes code-review skill`
- PR body: scratch-repo test evidence, URL of sample automated review comment.
