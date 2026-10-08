# Worktree C — Secret redaction across logs and stored memories

> **Repo:** all edits in this worktree happen in the **MemOS repo** at `/home/openclaw/Coding/MemOS`, NOT the Hermes repo. Files like `src/memos/core/redactor.py` (new) and `src/memos/mem_scheduler/task_schedule_modules/handlers/add_handler.py` live only in MemOS. The Hermes worktree at `~/Coding/Hermes-wt/fix-redaction` exists as a project-management artifact pointing at this brief; do your code work in a fresh MemOS worktree.
>
> **Setup before any code:**
> ```bash
> cd /home/openclaw/Coding/MemOS
> git fetch origin
> git worktree add ~/Coding/MemOS-wt/fix-redaction -b fix/v1-log-redaction origin/main
> cd ~/Coding/MemOS-wt/fix-redaction
> ```
> Push to and PR against the **MemOS repo's `main`**, not Hermes.

You are fixing **two related security bugs in the v1 MemOS server**. Both came out of the 2026-04-26 blind audit (Zero-Knowledge and Observability reports).

The system today logs LLM prompts and memory content unredacted, and the MemReader extractor stores secrets verbatim into Qdrant + Neo4j. If a user pastes an API key into a chat, that key ends up on disk in three places (log file, Qdrant vector text, Neo4j node).

## Bug 3a — F-05: secrets preserved verbatim by MemReader

> Submit a memory whose text contains a Bearer token, an `sk-…` key, a JWT, an email, an AWS `AKIA…` key, a PEM `-----BEGIN…` block. The extractor stores them all faithfully into Qdrant/Neo4j.

## Bug 3b — F-09: `add_handler` logs raw content on parse failure

> `src/memos/mem_scheduler/task_schedule_modules/handlers/add_handler.py` line 56, 118–125 logs the first 200 chars of raw content on parse error.

The audit's prescribed fix:

> Add a pre-extraction redaction pass that replaces known secret patterns (Bearer tokens, `sk-*` keys, `AKIA*`, PEM headers, email, phone) with `[REDACTED]` before handing content to MemReader, **and again in a post-extraction pass on the output**.

## Required outcome after this fix

1. **Pre-extraction redaction.** Before any content reaches MemReader, secrets are replaced with `[REDACTED:<class>]` (where `<class>` is one of `bearer`, `sk-key`, `aws-key`, `pem`, `email`, `phone`, `jwt`, `card`, `ssn`). The extractor never sees the raw secret.
2. **Post-extraction redaction.** After MemReader returns its structured output (which may have re-quoted user content into fields like `summary` or `tags`), the same redactor runs on every string field of the output before persistence.
3. **Log redaction.** Every `logger.error`, `logger.warning`, `logger.info` call that includes user-supplied content (request bodies, tool args, parse-error excerpts) flows through the redactor first. The `add_handler.py` line 56 path specifically gets:
   ```python
   logger.error("Parse error on content (redacted): %s", redact(str(e)))
   ```
4. **No "trust the LLM to redact" path.** Redaction is mechanical and runs even if the LLM call is skipped or fails.

## Patterns to redact (start here, expand as you find more)

| Class | Regex sketch |
|---|---|
| `bearer` | `\bBearer\s+[A-Za-z0-9._\-+/=]{8,}` (case-insensitive) |
| `sk-key` | `\bsk-[A-Za-z0-9_\-]{16,}` |
| `aws-key` | `\bAKIA[0-9A-Z]{16}\b` and `aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}` |
| `pem` | `-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----` |
| `jwt` | `\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b` |
| `email` | `[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}` |
| `phone` | `\+?\d{1,3}[\s\-.]?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}` (loose; tune for false positives) |
| `card` | Luhn-validated 13–19 digit run |
| `ssn` | `\b\d{3}-\d{2}-\d{4}\b` (US format) |

False-positive cost is low (`[REDACTED:email]` is fine even on non-secrets); false-negative cost is high. Err on aggressive.

## Files in scope

- **NEW** `src/memos/core/redactor.py` — module exposing `redact(text: str) -> str` and `redact_dict(obj: dict) -> dict` (recursive, every string field gets passed through `redact`).
- **NEW** `tests/unit/core/test_redactor.py` — table-driven tests, 30+ cases covering each class plus near-miss negatives.
- `src/memos/mem_scheduler/task_schedule_modules/handlers/add_handler.py` — wrap line 56 with `redact()`. Also lines 118–125.
- The MemReader call site — find it (`grep -rn "MemReader\|mem_reader_prompts" src/memos/`) and wrap input with `redact(text)`. Wrap output with `redact_dict(parsed)`.
- The logging config — install a `logging.Filter` that redacts `record.msg % record.args` (or whatever the formatter resolves to) before any handler emits. This is your **defense in depth** layer for log lines that bypass the explicit `redact()` calls.

## Working rules

- **Branch:** `fix/v1-log-redaction` (already created).
- **Do not** touch `multi_mem_cube/`, `vec_dbs/`, `graph_dbs/`, `api/middleware/agent_auth.py`, `api/middleware/rate_limit.py`, or the Hermes plugin — those belong to other worktrees.
- **Do not** read `tests/v1/reports/**` or `tests/v2/reports/**` or `memos-setup/learnings/**` or any `CLAUDE.md`.
- The redactor must be **fast enough not to bottleneck**: target <1ms per 1KB of content. Use compiled regex objects, not re-compiling per call.
- The redactor must not mutate inputs in place; always return a new string.

## Tests (must all pass)

- Unit: every pattern class redacts on a positive sample and leaves a negative sample untouched.
- Unit: `redact_dict` recurses into nested dicts/lists; non-string fields (ints, bools, datetime) pass through unchanged.
- Integration: store a memory containing `Bearer abc123def456ghi789` plus `sk-test-12345abcdef`. After persistence, query Qdrant directly: the stored vector text contains `[REDACTED:bearer]` and `[REDACTED:sk-key]`, **never** the raw values.
- Integration: trigger a parse failure in `add_handler` with content containing a secret. Check `~/.memos/logs/memos.log` — the secret is `[REDACTED:*]`, not the raw value.
- Negative: a benign string like `"the bearer of the message"` is NOT redacted.
- Performance: 1MB of text passes through `redact()` in under 100ms.

## Deliver

1. Push to `fix/v1-log-redaction`.
2. PR against `main` titled `fix(security): redact secrets from logs and extracted memories`.
3. PR body includes: (a) the patterns covered, (b) before/after grep of `~/.memos/logs/memos.log` after the integration test, (c) test counts (30+ unit, 4+ integration), (d) any patterns you considered but skipped.
4. Do NOT merge yourself.

## When you are done

Reply with: branch name, PR number, the unit + integration test output, and any patterns/sites you flagged for follow-up.
