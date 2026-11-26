import type { Message, ProviderTurn } from "../core/types.ts";
import type { Provider } from "../provider/provider.ts";

export const SUMMARY_PREFIX = "[compaction summary]";

export interface CompactOptions {
  messages: Message[];
  provider: Provider;
  signal: AbortSignal;
  /** Fraction of the context window that triggers compaction. */
  threshold?: number;
  /** Always keep at least this many of the newest messages verbatim. */
  keepTail?: number;
  /** Rough tokens per character. Code is ~3.5-4 chars/token. */
  charsPerToken?: number;
}

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  removedMessages: number;
  summaryTokens: number;
}

/**
 * Threshold compaction:
 *  - fire at a fixed fraction of the window (default 0.72)
 *  - keep a verbatim recent tail
 *  - merge into the *previous* summary instead of re-summarizing from scratch
 *
 * Re-summarizing from scratch loses early decisions; merging keeps them.
 */
export async function maybeCompact(opts: CompactOptions): Promise<CompactResult> {
  const threshold = opts.threshold ?? 0.72;
  const keepTail = opts.keepTail ?? 12;
  const cpt = opts.charsPerToken;
  const charsPerToken = cpt === undefined ? 3.6 : cpt;

  const budget = Math.floor(opts.provider.contextWindow * threshold);
  const used = estimateTokens(opts.messages, charsPerToken);
  if (used <= budget) {
    return { messages: opts.messages, compacted: false, removedMessages: 0, summaryTokens: 0 };
  }

  const previous = opts.messages.find(
    (m) => m.role === "system" && m.content.startsWith(SUMMARY_PREFIX),
  );
  const conversation = opts.messages.filter((m) => m !== previous && m.role !== "system");

  const cut = safeCutIndex(conversation, keepTail);
  const older = conversation.slice(0, cut);
  const tail = conversation.slice(cut);
  if (older.length === 0) {
    return { messages: opts.messages, compacted: false, removedMessages: 0, summaryTokens: 0 };
  }

  const summary = await summarize({ older, previous: previous?.content, provider: opts.provider, signal: opts.signal });
  const summaryMessage: Message = { role: "system", content: `${SUMMARY_PREFIX}\n${summary}` };
  const head = opts.messages.filter((m) => m.role === "system" && m !== previous);

  return {
    messages: [...head, summaryMessage, ...tail],
    compacted: true,
    removedMessages: older.length,
    summaryTokens: estimateTokens([summaryMessage], charsPerToken),
  };
}

export function estimateTokens(messages: Message[], charsPerToken = 3.6): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    for (const call of m.toolCalls ?? []) chars += call.rawArgs.length + call.name.length + 8;
    chars += 8;
  }
  return Math.ceil(chars / charsPerToken);
}

/**
 * Pick a cut point that never separates an assistant tool call from its
 * tool results. We cut at a user turn boundary when possible.
 */
function safeCutIndex(messages: Message[], keepTail: number): number {
  let cut = Math.max(0, messages.length - keepTail);

  // Move the cut backwards to the nearest user message boundary.
  while (cut > 0 && messages[cut]?.role !== "user") cut--;

  // If that removed everything, fall back to a tool-safe boundary.
  if (cut === 0) {
    cut = Math.max(0, messages.length - keepTail);
    while (cut < messages.length && messages[cut]?.role === "tool") cut++;
  }
  return cut;
}

async function summarize(opts: {
  older: Message[];
  previous?: string;
  provider: Provider;
  signal: AbortSignal;
}): Promise<string> {
  const previousBlock = opts.previous
    ? `\n\nPrevious summary to merge (keep every still-relevant fact):\n${opts.previous.replace(SUMMARY_PREFIX, "").trim()}`
    : "";

  const transcript = opts.older
    .map((m) => {
      const calls = m.toolCalls?.length
        ? `\n[tool calls: ${m.toolCalls.map((c) => `${c.name}(${c.rawArgs.slice(0, 400)})`).join(", ")}]`
        : "";
      return `${m.role}: ${m.content.slice(0, 4000)}${calls}`;
    })
    .join("\n\n");

  const turn: ProviderTurn = await opts.provider.complete({
    signal: opts.signal,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You compress an agent transcript. Return a compact briefing, not prose. " +
          "Sections: GOAL, DECISIONS, FILES TOUCHED, OPEN ISSUES, NEXT STEP. " +
          "Keep exact paths, commands, identifiers and error messages. Never invent facts.",
      },
      { role: "user", content: `Transcript:\n\n${transcript}${previousBlock}` },
    ],
    tools: [],
  });
  return turn.text.trim() || "(summary unavailable)";
}