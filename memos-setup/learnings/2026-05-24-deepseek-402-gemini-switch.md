# 2026-05-24 — DeepSeek out of credit (402) → memory extraction LLM switched to Gemini 2.5 Flash-Lite (free tier); tower resource cleanup

## TL;DR

The tower (`sergio`) was swap-thrashing (load 83 on 4 cores, 189 MiB RAM free, swap
full). Two independent problems:

1. **Resource bloat** — retired services were still resident: v1 MemOS docker
   containers (`neo4j-docker`, `qdrant`), an orphaned Camoufox browser, and the
   full Firecrawl worker fleet sitting idle (~1.3 GB).
2. **DeepSeek memory LLM at $0 balance** — every extraction/reflection call
   returned `402 Insufficient Balance`. The memos daemon's boot-time
   dirty-episode rescore looped on retries (584 failed calls in seconds),
   which (a) blocked `server.started` so the HTTP daemon never came up after an
   OOM restart, and (b) was the high memos CPU we were originally asked to
   investigate — the bridge was spinning on a 402 retry storm.

## Actions taken

### Resource cleanup
- Killed orphaned Camoufox (`camoufox-bin`, retired 2026-05-16) — ~100 MB.
- Stopped + `--restart=no` on `neo4j-docker` and `qdrant` (v1 MemOS graph +
  vector stores, retired; v2 uses SQLite only). They no longer restart on reboot.
- Stopped the Firecrawl docker-compose stack (idle).
- Result: RAM free 189 MiB → 8.8 GiB, swap drained, load 83 → ~1.

### Firecrawl on-demand wrapper
Firecrawl has no native idle-shutdown; its worker fleet is always resident.
Added:
- `tools/firecrawl-ctl.sh` — `up | ensure | down | status | idle-check`.
  `ensure` is the idempotent pre-flight intended to be called before
  `web_search`/`web_extract`.
- `~/.config/systemd/user/firecrawl-idle-monitor.{service,timer}` — fires every
  5 min, calls `idle-check`, and `docker compose stop`s the stack after
  `IDLE_STOP_AFTER` (default 2) consecutive idle samples (api container CPU <
  `FC_CPU_IDLE_PCT`, default 5%). Enabled.
- **Still TODO for true on-demand:** nothing auto-*starts* Firecrawl yet. The
  Hermes web backend must call `firecrawl-ctl.sh ensure` before issuing a
  request (a gateway hook). Until then, bring it up manually:
  `cd ~/.openclaw/workspace/firecrawl && docker compose up -d`.

### Memory LLM: DeepSeek → Gemini 2.5 Flash-Lite
- `~/.hermes/memos-plugin/config.yaml` `llm:` block repointed:
  - `endpoint: https://generativelanguage.googleapis.com/v1beta/openai`
  - `model: gemini-2.5-flash-lite`
  - `apiKey:` hardcoded literal (loader does **not** expand `${VAR}`; matches
    the prior DeepSeek/skillEvolver pattern). Key is the AI Studio
    `GEMINI_API_KEY` from `~/.hermes/.env`.
- Backup of the pre-switch config: `config.yaml.bak-deepseek-2026-05-24`.
- Daemon now boots cleanly: `server.started`, `/api/v1/health` → `ok:true`,
  `llm.available: true`, `lastError: null`.

## Why Gemini Flash-Lite

- **Free.** Google AI Studio key has a no-cost free tier (rate-limited, not
  dollar-limited). DeepSeek required a top-up nobody had done.
- **No `<think>` pollution.** The original reason DeepSeek was chosen over
  MiniMax (CLAUDE.md) was MiniMax emitting inline `<think>` tags that broke
  extraction. Gemini 2.5's reasoning comes back as separate `thought_signature`
  metadata, **not** inline in the content field — so that constraint doesn't
  apply.
- **flash-lite specifically** — lowest thinking overhead, fastest, most generous
  free-tier RPM, ideal for the bursty high-volume capture/summarization load.
- `gemini-2.0-flash` is retired for new keys; `gemini-2.5-flash` and
  `gemini-2.5-flash-lite` both verified working via the OpenAI-compat endpoint.

## Known issue / follow-up (not blocking)

During the first boot after the switch, the capture pipeline logged ~10
`[llm.json] malformed` warnings on `capture.reflection.batch.v2`,
`l2.induction.v2`, and `l3.abstraction.v2`. The pipeline retries then
`fallback_insert`s (raw steps stored, retrieval unaffected) — **degraded, not
broken**. Root cause is **not** missing `response_format`: `completeJson()`
already forces `jsonMode=true` (→ `response_format: {type:"json_object"}`), and
standalone calls with that flag return clean JSON. The malformed cases were the
**one-time boot backlog** — episodes with 75–210 accumulated orphan steps
producing oversized output that truncates against the default max-tokens (no
`maxTokens` is set in config). Steady-state calls report `lastError: null`.

Recommended follow-up (a scoped task, not live-daemon poking):
1. Set an explicit `maxTokens` for the `llm` block sized for batch reflection.
2. Consider `reasoning_effort: "none"` for Gemini extraction calls (verified to
   keep flash-lite output clean) — needs a small provider/config plumb since the
   plugin doesn't expose it yet.
3. Re-run `bash tools/stress-test.sh` after, and watch
   `grep -c malformed logs/daemon-*.log` trend to zero.

## Privacy note

Free-tier AI Studio prompts may be used by Google to improve their products
(paid tier excludes this). The memory store holds operator/agent content. If
that's unacceptable, the options are: top up DeepSeek (restore
`config.yaml.bak-deepseek-2026-05-24`), or move to a paid Gemini billing project.

## Rollback

Restore DeepSeek once that account has balance:
```bash
cp ~/.hermes/memos-plugin/config.yaml.bak-deepseek-2026-05-24 \
   ~/.hermes/memos-plugin/config.yaml
# then bounce the daemon (CTO bridge owns it): restart Hermes-CTO mem daemon
```
