// Shared helpers for the per-tool parsers.

/** First line of a value, truncated to `n` chars with an ellipsis. */
export function firstLine(s: unknown, n = 100): string {
  const line = String(s ?? "").split("\n")[0] ?? "";
  return line.length > n ? line.slice(0, n) + "…" : line;
}

/**
 * Remove harness-injected wrapper blocks (and their contents) by tag name, so
 * we keep the person's actual prompt and drop machinery like slash-command
 * stdout, system reminders, and Codex's environment/permissions preamble.
 */
export function stripWrapperBlocks(text: string, tags: string[]): string {
  let t = text;
  for (const tag of tags) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`<${esc}>[\\s\\S]*?</${esc}>`, "gi"), " ");
    t = t.replace(new RegExp(`</?${esc}>`, "gi"), " "); // dangling/unclosed
  }
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
