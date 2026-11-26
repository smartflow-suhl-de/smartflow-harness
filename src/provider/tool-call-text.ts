/**
 * Some models "call" tools by writing the call as assistant text instead of
 * using the tool channel, e.g. `{"name": "bash", "arguments": {...}}`.
 * Recognising that shape lets the loop retry without tools instead of
 * returning the JSON blob as an answer.
 */
export function looksLikeToolCallText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes('"arguments"')) return false;
  const withoutFence = trimmed.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "").trim();
  if (!withoutFence.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(withoutFence) as { name?: unknown; arguments?: unknown };
    return typeof parsed.name === "string" && typeof parsed.arguments === "object";
  } catch {
    return false;
  }
}
