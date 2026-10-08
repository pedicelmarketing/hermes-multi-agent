/**
 * Capture-side trace summarizer — produces the short, viewer-friendly
 * summary string that ends up in `traces.summary` and (downstream) in
 * the Memories panel / retrieval snippets.
 *
 * Design mirrors `memos-local-openclaw`'s `Summarizer`:
 *
 *   - Ask the configured LLM for a single-sentence distillation.
 *   - If the LLM is unavailable, times out, or returns malformed JSON,
 *     fall back to a deterministic heuristic so capture never blocks.
 *
 * The summary is what downstream retrieval embeds (see
 * `core/capture/embedder.ts::summaryText`) and what the Memories
 * viewer shows as the primary row text. Keeping it short (≤ 140
 * chars) keeps the viewer skim-able and the prompt-injection block
 * small.
 *
 * Hermes integration (2026-05-17): the summarizer reads
 * `MEMOS_HUMAN_NAME` from the environment and, when set, instructs the
 * LLM to attribute statements to that named human rather than to
 * "the user". This puts the speaker's identity into the embedding
 * space, giving better cross-user retrieval signal. Without the env
 * var, behaviour is unchanged.
 */

import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import { sanitizeDerivedText } from "../safety/content.js";
import type { NormalizedStep } from "./types.js";

const MAX_SUMMARY_CHARS = 140;
const MAX_INPUT_CHARS = 3_500;

// Hermes integration 2026-05-17: speaker attribution in memory summaries.
//
// We do NOT maintain a closed roster of "valid" speakers. Agents will see
// messages from people outside the team (clients, leads, group chats,
// quoted email). Instead the LLM is asked to identify the speaker from
// signal *inside the message itself* — primarily the `[handle]` marker
// the gateway prepends to user_text, secondarily natural-language
// self-introductions in the body.
//
// MEMOS_HUMANS (optional) provides an alias map so opaque handles
// resolve to friendly names. Anyone NOT in the map is still attributed
// by whatever name/handle appears in the message — the map is a help,
// not a gate.
//
//   MEMOS_HUMANS=Sergio:sergiopalacio96|sergiop,Krati,Mohammed:moh,Arinze
//
// Format:
//   - Entries comma-separated.
//   - Optional `:handle1|handle2|...` after the name, pipe-separated.
//   - A name without handles is fine — it still helps if the LLM sees
//     the name mentioned in the body, but it doesn't "claim" any handle.
//
// MEMOS_HUMAN_NAME (singular) is a back-compat fallback: treated as a
// single-entry MEMOS_HUMANS when MEMOS_HUMANS is absent.
//
// Resolved once at module load — restart the daemon after editing .env.
interface HumanEntry { name: string; handles: string[]; }
const HUMANS: HumanEntry[] = parseHumans(
  process.env.MEMOS_HUMANS ?? process.env.MEMOS_HUMAN_NAME ?? "",
);
function parseHumans(raw: string): HumanEntry[] {
  const out: HumanEntry[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const [name, handles] = trimmed.split(":", 2);
    out.push({
      name: name.trim(),
      handles: handles ? handles.split("|").map((h) => h.trim()).filter(Boolean) : [],
    });
  }
  return out;
}

export interface SummarizerOptions {
  llm: LlmClient | null;
  log?: Logger;
  timeoutMs?: number;
}

export interface Summarizer {
  summarize(step: NormalizedStep, context?: SummarizerContext): Promise<string>;
}

export interface SummarizerContext {
  episodeId?: string;
  phase?: string;
  /**
   * Skip the LLM and return the deterministic heuristic summary directly.
   * Used by the reflect-pass orphan-fallback insert: those rows would
   * otherwise fire one summarize LLM call PER orphan step at recovery
   * time — for a large recovered/closed episode that's hundreds of
   * synchronous calls during cold-boot reflection, which rate-limits and
   * stalls the bridge. The orphan rows' reflection is computed by the
   * main batch pass right after, so a heuristic `summary` is sufficient.
   */
  heuristicOnly?: boolean;
}

/**
 * Build a summarizer bound to the provided LLM client. When `llm` is
 * null the returned summarizer uses the heuristic path only — capture
 * still works, just with a more verbose summary.
 */
export function createSummarizer(opts: SummarizerOptions): Summarizer {
  const log = opts.log ?? rootLogger.child({ channel: "core.capture.summarizer" });
  const timeoutMs = opts.timeoutMs ?? 8_000;

  async function summarize(step: NormalizedStep, context?: SummarizerContext): Promise<string> {
    // Heuristic first pass — a safety net both when the LLM is off
    // and as the input we re-anchor the LLM call against (so even if
    // the LLM returns garbage we still have a sensible string).
    const heuristic = heuristicSummary(step);
    if (!opts.llm || context?.heuristicOnly) return heuristic;

    try {
      const result = await withTimeout(
        opts.llm.completeJson<{ summary?: unknown }>(
          [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: buildUserPrompt(step),
            },
          ],
          {
            op: "capture.summarize",
            episodeId: context?.episodeId,
            phase: context?.phase,
            schemaHint: '{"summary":"..."}',
            validate: (v) => {
              const s = (v as { summary?: unknown }).summary;
              if (typeof s !== "string" || s.trim().length === 0) {
                throw new Error("summary missing or empty");
              }
            },
            malformedRetries: 1,
            temperature: 0,
          },
        ),
        timeoutMs,
      );
      const llmSummary = sanitizeDerivedText((result?.value as { summary?: string })?.summary);
      if (!llmSummary) return heuristic;
      return clampLength(llmSummary, MAX_SUMMARY_CHARS);
    } catch (err) {
      log.debug("summarize.fallback", {
        err: err instanceof Error ? err.message : String(err),
      });
      return heuristic;
    }
  }

  return { summarize };
}

// ─── Prompts ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `You condense a single agent/user exchange into ONE short memory line.

Rules:
- Output MUST be a single JSON object: { "summary": "..." }
- The summary must be ≤ 100 characters, in the user's original language.
- Focus on the *fact worth remembering next time* — a preference, a name, a
  decision, a file path, an error signature, an answer that was confirmed.
- Do NOT prefix with "The user said" / "用户说了". Just state the fact.
- Do NOT quote whole sentences. Compress.
- If nothing is worth remembering, still produce a short summary (e.g. the
  main topic of the exchange) — never return an empty string.`;

// Speaker attribution: identify who's speaking from signal inside the
// message itself. Don't treat MEMOS_HUMANS as a closed roster — agents
// see messages from outside parties too (clients, leads, group chats).
// Use the alias map only to resolve known opaque handles to friendly
// names; otherwise extract the speaker from the message verbatim or
// omit the reference. Added 2026-05-17.
const ALIAS_LINE = HUMANS.length > 0
  ? HUMANS
      .filter((h) => h.handles.length > 0)
      .map((h) => `\`[${h.handles.join("]\` or \`[")}]\` → **${h.name}**`)
      .concat(
        HUMANS.filter((h) => h.handles.length === 0).map(
          (h) => `**${h.name}** (no known handle; recognise by name in body)`,
        ),
      )
      .join("; ")
  : "";

const SYSTEM_PROMPT = ALIAS_LINE
  ? `${SYSTEM_PROMPT_BASE}

Speaker attribution
- The USER block is one message from one human. Identify the speaker
  from signal **inside this message**:
    (a) a handle marker like \`[sergiopalacio96]\` at the very start of
        the USER text (added by the messaging gateway), or
    (b) a natural-language self-identification in the body
        ("I'm Mark", "— Anna from acme.io", an email "From:" header
        you can see in a quoted block).
- When the speaker is identifiable, use that **name** in the summary
  (e.g. "Sergio asked about X", "Anna requested a quote") — never echo
  raw handles like "sergiopalacio96" or "user1234".
- **Known handle aliases** (use these when you recognise a handle):
  ${ALIAS_LINE}.
- The above list is **not** a closed roster. Messages from people who
  aren't in it (clients, leads, group-chat participants, quoted email
  senders) are normal — use whatever name appears in the message itself.
- If you cannot confidently identify the speaker, omit the speaker
  reference entirely — just state the fact. Never invent a speaker.
  The assistant is never the speaker.`
  : `${SYSTEM_PROMPT_BASE}

Speaker attribution
- The USER block is one message from one human. If a name or handle
  appears in the message (a \`[handle]\` prefix added by the gateway,
  a self-introduction in the body, or a quoted byline), use that
  **name** in the summary — e.g. "Anna asked about X". Never echo raw
  opaque handles like "user1234". If no name is identifiable, omit the
  speaker reference — never invent one. The assistant is never the
  speaker.`;

function buildUserPrompt(step: NormalizedStep): string {
  const parts: string[] = [];
  if (step.userText) parts.push(`USER:\n${clampLength(step.userText, 1_400)}`);
  if (step.agentText) parts.push(`ASSISTANT:\n${clampLength(step.agentText, 1_400)}`);
  if (step.toolCalls.length > 0) {
    const toolSig = step.toolCalls
      .map((t) => `${t.name}(${shortInput(t.input)})`)
      .join("; ");
    parts.push(`TOOLS:\n${clampLength(toolSig, 400)}`);
  }
  if (step.rawReflection) {
    parts.push(`REFLECTION:\n${clampLength(step.rawReflection, 300)}`);
  }
  return clampLength(parts.join("\n\n"), MAX_INPUT_CHARS);
}

function shortInput(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.slice(0, 120);
  try {
    return JSON.stringify(v).slice(0, 120);
  } catch {
    return String(v).slice(0, 120);
  }
}

// ─── Heuristic fallback ────────────────────────────────────────────────────

function heuristicSummary(step: NormalizedStep): string {
  const user = (step.userText ?? "").trim();
  const assistant = (step.agentText ?? "").trim();
  // Prefer the user's line — that's what they'll recognise in the
  // Memories panel. Fall back to the assistant's reply when we only
  // have an agent-initiated turn (subagent, recall probe, etc.).
  const base = user || assistant || "(empty turn)";
  return clampLength(oneLine(base), MAX_SUMMARY_CHARS);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clampLength(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`summarize timeout ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
