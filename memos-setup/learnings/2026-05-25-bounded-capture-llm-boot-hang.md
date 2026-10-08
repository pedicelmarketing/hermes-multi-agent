# 2026-05-25 — Bounded capture-pipeline LLM calls (cold-boot reflection hang prevention)

**Status:** implemented + tested. Resolves the known follow-up flagged in the
2026-05-24 sprint note ("oversized boot-backlog batches log `[llm.json]
malformed` then fall back; needs an explicit `maxTokens` / `reasoning_effort:
none` plumb").

## Symptom

Cold bridge boot (`core.init()` → `recoverDirtyClosedEpisodes` →
`captureSubscriber.runReflect` → `await handle.flush()`) could stall when a
closed-but-unreflected episode carried a large causal chain. The reflect pass
issued an LLM call whose prompt/response scaled with the episode size; the
oversized call returned truncated/malformed JSON (`[llm.json] malformed
op="capture.reflection.batch.v2"`) or timed out
(`[llm.openai_compatible] http.exception timedOut=true`). Because boot
reflection is awaited before the stdio server reports ready, the retry/timeout
chain blocked `server.started`. The 2026-05-25 incident was unblocked by
marking the offending episodes `meta.reward.skipped=true`
(`backlog-episodes-backup-2026-05-25.json`,
`dirty-episodes-backup-2026-05-21.json`); this doc is the durable prevention.

## Root cause — which call scaled with N

Two N-scaling dimensions in the capture pipeline, both in the batched
reflection scorer (`core/capture/batch-scorer.ts`):

1. **Step count per call.** `runBatchScoring` (capture.ts) sent the whole
   episode in one `batchScoreReflections` call. `shouldBatch`'s `auto` mode
   capped this at `batchThreshold` (12) by *degrading to the per-step path*
   for longer episodes — but `per_episode` mode (and any raised threshold)
   sent an unbounded single call. Even the per-step degrade path is a problem
   at boot: a 200-step episode becomes ~400 synchronous per-step LLM calls.
2. **Tool-call count per step.** The payload mapped `step.toolCalls` with **no
   count cap** (`clampTools` only caps each tool's *output*, not the *number*
   of tools). A step that accumulated hundreds of tool calls emitted an
   unbounded `tool_calls` array in one step's payload.

`runSummarize` was *misattributed* as the oversized call in the original
follow-up note. It is actually per-step (`runConcurrently`, one
`summarize` LLM call per step) — already size-1 per call, so it never
overflows a single response. Its only boot cost is **call count** for the
orphan-fallback insert path, addressed separately below.

## Fix (minimal, shared capture code — loaded by all 7 gateways)

- **Chunk `runBatchScoring`** (`core/capture/capture.ts`): split the episode
  into `≤ batchThreshold`-step chunks, score each via a new `scoreBatchChunk`
  helper, concatenate. A chunk whose batched call fails degrades to per-step
  **for that chunk alone**, so one bad chunk no longer forces the whole
  episode back to per-step. `shouldBatch` now batches whenever `batchMode !=
  per_step` (both `auto` and `per_episode`) — long episodes run more *bounded*
  batch calls instead of degrading to a per-step storm (200 steps → ~17
  bounded calls instead of ~400 per-step calls).
- **Cap per-step tool calls + plumb maxTokens** (`core/capture/batch-scorer.ts`):
  `capToolCalls` keeps head+tail and drops the middle (with a marker) above
  `MAX_TOOLCALLS_PER_STEP = 24`; the batched call forwards
  `maxTokens = BATCH_MAX_TOKENS (4096)` as a hard response ceiling.
- **Heuristic-only orphan summaries** (`core/capture/summarizer.ts` +
  `capture.ts`): the reflect-pass orphan-fallback insert passes
  `heuristicOnly: true`, skipping the LLM for orphan rows (their reflection is
  computed by the main batch pass immediately after). Eliminates the
  one-LLM-call-per-orphan-step boot cost.

## Test

Isolated `MEMOS_HOME=/tmp/memos-chunk-test` (copy of the real config), seeded a
closed dirty episode (`r_task NULL`, `closeReason: finalized`) with 100 traces,
cold-booted `bridge.cts` and watched `CTO_BRIDGE_STDERR_LOG`:

- Against a local mock LLM (deterministic, no shared-quota noise): **boot OK,
  0 malformed/timeout warnings, 18–27 batch calls all ≤ 12 steps** (chunking
  enforced). With `embedTraces:false` to isolate the reflection path from local
  BGE-embed CPU cost, **boot completed in 2.1 s**.
- Tool-cap unit check via `batchScoreReflections` with a 300-tool step: the
  serialized payload was capped to 24 tools/step and `maxTokens=4096` was
  forwarded.
- Against the real (rate-limited, shared) endpoints the path **degraded
  gracefully** (per-chunk → per-step fallback, no `capture.reflection.batch.v2`
  malformed, no hang).

The 100-orphan synthetic episode's slower (~72 s) boot was entirely local BGE
re-embedding of the orphan rows — a test artifact. Production dirty-episode
rescore reuses the existing trace rows (no orphans → no re-embed), so the
reflection path is the only LLM cost there and it is now bounded.

## Survives reinstall

Folded into `tools/plugin-patches/` + `tools/postinstall-patches.sh`
(patches 5–7): `core/capture/capture.ts`, `core/capture/batch-scorer.ts`,
`core/capture/summarizer.ts` (refresh), `adapters/hermes/memos_provider/__init__.py`
(keepalive `10→90s` + close-on-failed-boot, from the same session). Verify with
`bash tools/postinstall-patches.sh --check`.

The `skillEvolver → NVIDIA integrate API` config switch (same session) lives in
`~/.hermes/memos-plugin/config.yaml` and is intentionally **not** committed (it
carries a secret key); config.yaml is user data preserved across reinstalls.
Backup: `config.yaml.bak-skillevolver-2026-05-25`.

## Known non-blocking follow-up

`MAX_TOOLCALLS_PER_STEP` / `BATCH_MAX_TOKENS` / `batchThreshold` are constants;
if real episodes routinely exceed them, surface them as `algorithm.capture`
config knobs. Local orphan re-embedding is still unbounded in step count — only
a concern for the (rare) orphan-fallback path, not the normal rescore.
