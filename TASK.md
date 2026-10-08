# TASK: wire/badass-skills-groundtruth — Make badass-skills the shared skills ground truth

## Goal

Both runtimes (Hermes workers + Claude Code CEO) read from `~/Coding/badass-skills/`. The MemOS plugin's auto-generated skills write back to the same directory, closing the loop.

## Context

- Hermes already reads from `~/Coding/badass-skills/` via `external_dirs` in profile configs. Verified in Sprint 1. 3 skills present today: `gemini-video`, `notebooklm`, `pdf`.
- Claude Code reads from `~/.claude/skills/` at runtime. That directory does NOT exist on this machine currently.
- The Paperclip `claude_local` adapter injects skills into Claude Code sessions by symlinking from its own runtime skills directory into `~/.claude/skills/`. It classifies any skill *already* in `~/.claude/skills/` that it didn't install as "external / user_installed / readOnly: true" — still usable by CEO, just not managed by Paperclip.
- The MemOS plugin's skill evolution outputs SKILL.md files to a configurable directory.

Prerequisite: [gate](../gate/migrate-setup.md) has merged. Plugin installed on at least one profile.

## Scope

1. Symlink `~/Coding/badass-skills/*/` into `~/.claude/skills/` so Claude Code CEO sees them.
2. Configure the MemOS plugin's skill-output directory to be `~/Coding/badass-skills/` (or a subdirectory like `~/Coding/badass-skills/auto/`).
3. Verify both runtimes read from the same source:
   - Hermes worker sees the 3 existing skills (already verified).
   - Claude Code CEO now sees them too (new).
4. Document the setup so future machines can reproduce it.

## Files to touch

- `scripts/migration/symlink-badass-skills.sh` — creates/refreshes symlinks from `~/Coding/badass-skills/*/` into `~/.claude/skills/`. Idempotent. Handles: directory doesn't exist (creates it), symlink exists and points elsewhere (warns), symlink already correct (no-op).
- `scripts/migration/configure-plugin-skill-output.sh` — sets the plugin's skill-output directory env var (or config) to point at `~/Coding/badass-skills/auto/`. Creates the `auto/` subdir if needed.
- `deploy/README.md` — update to document the skill ground-truth setup.

## Acceptance criteria

- [ ] `~/.claude/skills/gemini-video`, `~/.claude/skills/notebooklm`, `~/.claude/skills/pdf` are symlinks pointing into `~/Coding/badass-skills/`. `ls -la ~/.claude/skills/` shows them as `->` links.
- [ ] The MemOS plugin's config file (or env var) is set such that generated skills land in `~/Coding/badass-skills/auto/`. Verify by generating one test skill (e.g., via an existing conversation, or a forced run of the skill evolution pipeline) and checking the file appears there.
- [ ] A fresh Claude Code session can list the 3 existing skills (ask the user's session to run `/plugin list` or equivalent discovery). The skills marked as "user-installed" or "external" are acceptable — we want them visible, not necessarily Paperclip-managed.
- [ ] A Hermes chat session can still see and use the skills (no regression from adding the symlinks).
- [ ] Format compatibility check: at least one of the 3 skills has a `SKILL.md` with YAML frontmatter that Claude Code's skill discovery accepts (reads it without parse errors). Document any skills that are Hermes-only format and would need dual-authoring.

## Test plan

1. **Symlink creation:**
   ```bash
   bash scripts/migration/symlink-badass-skills.sh
   ls -la ~/.claude/skills/
   # Expected: 3 symlinks to ~/Coding/badass-skills/*
   ```

2. **Plugin output config:**
   ```bash
   bash scripts/migration/configure-plugin-skill-output.sh
   # Inspect the plugin's config file or env
   # Verify output path = ~/Coding/badass-skills/auto
   ```

3. **Round-trip test for auto-generated skill:**
   - Run a couple of short Hermes sessions that do something distinctive (e.g., "read the README.md and summarize in 3 bullets").
   - Wait for the plugin's skill evolution pipeline.
   - Check `~/Coding/badass-skills/auto/` for a new SKILL.md.
   - Open it. Verify structure (frontmatter, name, description, steps).

4. **Claude Code visibility:**
   - Start a fresh Claude Code session (not related to this worktree).
   - Ask it to list available skills.
   - Confirm the 3 existing + any auto-generated ones are visible.

5. **Hermes regression check:**
   - `hermes -p research-agent chat -q "what skills do you have access to?"` — should mention badass-skills-sourced skills.

## Out of scope

- Do NOT convert Hermes-format skills to Claude Code format (or vice versa). If a skill is single-runtime, note it in the README; don't fix it here.
- Do NOT add new skills to `badass-skills/`. This task is about wiring, not content.
- Do NOT configure Paperclip's skill-management field — that's a Paperclip-UI concern. Symlinks are visible as "external" skills, which is good enough.
- Do NOT delete the existing 3 skills or reorganize the badass-skills repo.

## Commit / PR

- Branch: as assigned
- PR title: `wire(skills): badass-skills as ground truth for Hermes + Claude Code + plugin output`
- PR body: evidence of all 5 acceptance criteria. Include `ls -la ~/.claude/skills/` output and the generated-skill SKILL.md file path.
