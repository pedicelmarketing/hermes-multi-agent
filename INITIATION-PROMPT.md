# Initiation Prompt — Migration Sprint

Paste this as the FIRST message into any Claude Code Desktop session opened in a migration worktree directory.

---

```
You are working inside a Hermes multi-agent migration sprint. Your working directory is a git worktree; read TASK.md in this directory for your full brief.

BEFORE DOING ANY WORK:

1. Run `git status` and `git branch --show-current`. The branch name will be either the worktree's intended branch (e.g. feat/migrate-setup, wire/paperclip-employees) OR a claude/* scratch branch that Claude Code Desktop auto-created.

2. If you are on a claude/* scratch branch, that is fine — it's Desktop's session-isolation default. Stay on it. Do NOT try to switch to the worktree's intended branch (git will refuse — that branch is checked out in the parent worktree).

3. Read TASK.md in full. It contains the goal, files to change, acceptance criteria, and test plan.

4. Read the migration master plan at:
     /home/openclaw/Coding/Hermes/memos-setup/learnings/2026-04-20-v2-migration-plan.md
   It gives you the 5-stage context and tells you where this worktree fits.

5. In your first reply, confirm:
   - Your current branch
   - Your understanding of the task scope
   - Your implementation plan
   - The acceptance criteria from TASK.md, restated

RULES:

- Commit in logical chunks on your current branch as you go. Use descriptive commit messages.
- When acceptance criteria pass, push:
     git push -u origin $(git branch --show-current)
- Open a PR targeting main:
     gh pr create --base main --title "<concise>" --body "<summary + evidence>"
- DO NOT merge the PR yourself. The human reviewer does that.
- DO NOT edit or run anything outside this worktree. Respect its scope.
- DO NOT run destructive operations (force push, git reset --hard, deleting branches) unless explicitly in your TASK.md.
- If you hit ambiguity or blocked on something outside the brief: STOP, explain the issue, and wait.

SCOPE DISCIPLINE:

- Do not expand scope. If a TASK.md says "out of scope: X", do not touch X even if it seems related.
- If you notice a bug or improvement outside your scope, write it down in your PR body as a follow-up, do NOT fix it.

BLIND TESTING DISCIPLINE (if your task involves testing):

- Use unique markers (e.g. timestamps) for test data so nothing collides with real or other-session data.
- Do not cherry-pick results. Report raw evidence: status codes, counts, timings, JSON bodies.
- Map your results to the acceptance criteria explicitly. Pass/fail per criterion with evidence.

OUTPUT WHEN DONE:

- Summary of commits on your branch (git log --oneline)
- Evidence table: each acceptance criterion → pass/fail → proof
- The PR URL
- Any deviations from TASK.md and why
- Any follow-up items noticed outside your scope

Now read TASK.md and reply with your plan.
```
