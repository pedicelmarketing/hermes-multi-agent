# TASK: hermes/python-library-adapter — Replace Paperclip CLI subprocess with Python library

## Goal

Make Paperclip use Hermes via its Python library (`from run_agent import AIAgent`) instead of spawning `hermes` as a CLI subprocess. Lower overhead, better error handling, session state preserved in-process.

## Context

From baseline audit: "Python Library Mode 0/10 — could replace CLI invocations in Paperclip adapter. More reliable, lower overhead." Today Paperclip's `hermes_local` adapter shells out to the Hermes CLI. Each task = new subprocess = no shared state between tasks beyond what Hermes itself persists.

Switching to library mode lets us:
- Reuse connections (HTTP pool, model config cache)
- Hold richer error objects instead of parsing stdout
- Share the `claude_local` session-persistence pattern that Paperclip uses

This worktree is only worth doing if it actually benefits the stack after migration to Product 2. If the MemOS plugin auto-capture works well through the CLI path, library mode is a nice-to-have optimization, not a blocker.

## Scope

1. Read `hermes-paperclip-adapter`'s server-side code — does it already support library mode? Or is CLI the only path?
2. If library mode is supported: write a config/env flag that toggles between CLI and library.
3. If library mode needs plumbing: write a minimal wrapper module `scripts/paperclip/hermes_lib_adapter/` that exposes the library API to whatever Paperclip expects.
4. Test: run 5 tasks through each mode, compare latency + error handling quality.
5. Document findings in `deploy/README.md` — which mode is default, when to use the other.

## Files to touch

- `scripts/paperclip/hermes_lib_adapter/` (if building wrapper): module + tests
- `deploy/README.md` — doc
- `deploy/config/config.yaml` — if a Hermes-side flag is needed

## Acceptance criteria

- [ ] Determined whether hermes-paperclip-adapter supports library mode out of the box (yes/no answer documented)
- [ ] If yes: Paperclip employees configurable to use library mode; latency benchmark shows improvement
- [ ] If no: minimal wrapper in place OR this task is closed as "not worth building for current scale" with a clear finding documented
- [ ] 5 tasks tested in whichever mode is default after this work, all succeed with reasonable latency

## Test plan

```bash
# Benchmark CLI mode (current):
for i in 1 2 3 4 5; do
  time hermes -p research-agent chat -q "concise test $i: compute 7 * 8" 2>&1 | tail -1
done

# If library mode wired: same workload through Paperclip employee using library adapter
# Collect and compare wall-clock
```

## Out of scope

- Do NOT rewrite Hermes's Python library.
- Do NOT migrate Paperclip itself.
- Do NOT break the existing CLI fallback path.

## Commit / PR

- Branch: as assigned
- PR title: `hermes(adapter): [library mode shipped | deferred with findings]`
- PR body: investigation outcome, benchmark numbers if applicable.
