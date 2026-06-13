// Oh Tips — the mechanical evidence finder, ported from src/insights.ts.
// Each tip points at a specific moment and quotes the user's own words; the
// rules find the priciest exchange / rabbit hole / cache number and phrase a
// grounded draft. No LLM judgment of "good principles" (ADR 0007) — these are
// facts about your own captured sessions, surfaced as prose.

import type { MetricsRow } from "./types";
import { countRabbitHoleEpisodes, streakItemFromRow, RABBIT_HOLE_MIN_STREAK } from "./insights";

export interface Tip {
  score: number;
  text: string;
}

const PLEASANTRY_RE =
  /^(ok(ay)?|k|thanks?( you| u)?( so much)?|thx|ty|great|nice( one)?|cool|perfect|awesome|amazing|love (it|this)|lgtm|good (job|work)|well done|sounds good|got it|gotcha)[.!?\s]*$/i;

function promptOf(chunkText: string): string {
  return (chunkText.split("\n")[0] ?? "").replace(/^User:\s*/, "").trim();
}

function quote(p: string, max = 60): string {
  const t = p.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function when(tsIso: string): string {
  const d = new Date(tsIso);
  if (Number.isNaN(d.getTime())) return "";
  return `${WEEKDAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function generateTips(
  rows: MetricsRow[],
  chunkTexts: Array<{ id: string; text: string }>,
): Tip[] {
  const tips: Tip[] = [];
  if (rows.length === 0) return tips;
  const fresh = (r: MetricsRow) => r.input_tokens + r.output_tokens + r.cache_write_tokens;
  const promptById = new Map(chunkTexts.map((c) => [c.id, promptOf(c.text)]));

  const pleasantries = rows.filter((r) => {
    const p = promptById.get(r.id);
    return p != null && p.length > 0 && p.length <= 40 && PLEASANTRY_RE.test(p);
  });
  if (pleasantries.length >= 2) {
    const tok = pleasantries.reduce((s, r) => s + fresh(r), 0);
    const priciest = pleasantries.reduce((a, b) => (fresh(b) > fresh(a) ? b : a));
    tips.push({
      score: tok,
      text:
        `That "${quote(promptById.get(priciest.id) ?? "thanks")}" on ${when(priciest.ts)} cost ${fmtTokens(fresh(priciest))} tokens — ` +
        `the agent re-read the whole conversation to hear it. You did that ${pleasantries.length}× this window (~${fmtTokens(tok)}). ` +
        `Your AI doesn't need closure; fold the thanks into your next real ask.`,
    });
  }

  const bySession = new Map<string, MetricsRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session_id);
    if (list) list.push(r);
    else bySession.set(r.session_id, [r]);
  }
  let episodes = 0;
  let longest: { rows: MetricsRow[]; tokens: number } | null = null;
  for (const list of bySession.values()) {
    list.sort((a, b) => a.exchange_index - b.exchange_index);
    episodes += countRabbitHoleEpisodes(list.map(streakItemFromRow));
    let run: MetricsRow[] = [];
    for (const r of [...list, null as unknown as MetricsRow]) {
      if (r && (r.is_correction || r.errors > 0)) {
        run.push(r);
      } else {
        if (run.length >= RABBIT_HOLE_MIN_STREAK) {
          const tokens = run.reduce((s, x) => s + fresh(x), 0);
          if (!longest || tokens > longest.tokens) longest = { rows: run, tokens };
        }
        run = [];
      }
    }
  }
  if (episodes > 0 && longest) {
    const first = longest.rows.find((r) => promptById.get(r.id)) ?? longest.rows[0]!;
    const p = promptById.get(first.id);
    tips.push({
      score: longest.tokens,
      text:
        `${when(first.ts).split(" ")[0]}'s spiral: ${longest.rows.length} correction/error turns ` +
        `(~${fmtTokens(longest.tokens)} tokens)${p ? `, starting around "${quote(p)}"` : ""}. ` +
        `On the third "still broken", clear context and restate the goal with what you've learned — turn ${longest.rows.length + 1} is rarely cheaper than a fresh start.`,
    });
  }

  let top: MetricsRow | null = null;
  for (const r of rows) if (!top || fresh(r) > fresh(top)) top = r;
  if (top && fresh(top) >= 300_000) {
    const p = promptById.get(top.id);
    tips.push({
      score: fresh(top) / 2,
      text:
        `Your priciest moment: ${p ? `"${quote(p)}"` : "one exchange"} (${top.repo ?? "?"} · ${when(top.ts)}) → ` +
        `${fmtTokens(fresh(top))} fresh tokens in a single turn. Whatever got pasted there stayed in context for the rest of the session — ` +
        `trim heavy pastes, or clear context after the heavy lift.`,
    });
  }

  const input = rows.reduce((s, r) => s + r.input_tokens, 0);
  const cacheRead = rows.reduce((s, r) => s + r.cache_read_tokens, 0);
  const cacheWrite = rows.reduce((s, r) => s + r.cache_write_tokens, 0);
  const denom = input + cacheRead + cacheWrite;
  if (denom > 1_000_000 && cacheRead / denom < 0.7) {
    tips.push({
      score: Math.round(input * 0.3),
      text:
        `Your cache hit is ${Math.round((cacheRead / denom) * 100)}% this window — fresh context costs ~10× cached. ` +
        `Gaps over ~5 minutes mid-session re-buy the same context; finish a thread while it's warm.`,
    });
  }

  const interrupted = rows.filter((r) => r.interrupted);
  if (interrupted.length >= 3) {
    const lastInt = interrupted[interrupted.length - 1]!;
    tips.push({
      score: 20_000 * interrupted.length,
      text:
        `You hit Esc ${interrupted.length} times this window (latest ${when(lastInt.ts)}). Interrupting is healthy — do it EARLIER: ` +
        `every token before the Esc is already spent, and a wrong direction rarely fixes itself by turn three.`,
    });
  }

  const corrections = rows.filter((r) => r.is_correction);
  if (corrections.length >= 5) {
    const priciest = corrections.reduce((a, b) => (fresh(b) > fresh(a) ? b : a));
    const p = promptById.get(priciest.id);
    tips.push({
      score: 15_000 * corrections.length,
      text:
        `${corrections.length} do-overs this window${p ? ` — like "${quote(p)}" (${when(priciest.ts)})` : ""}. ` +
        `Front-load the specifics — paste the exact error, name the file, state the constraint — and the first answer lands more often than the third.`,
    });
  }

  return tips.sort((a, b) => b.score - a.score);
}
