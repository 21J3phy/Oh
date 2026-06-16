// Insights — the first Flags-family View (ADR 0007). Pure functions over
// exchange_metrics rows: time anatomy, token economy, friction, fun stats, and
// the rabbit-hole detector shared with capture's Nudge writer. No LLM, no
// embeddings — everything here must stay mechanical and explainable.
//
// Individual-only (ADR 0008): reports are always scoped to the caller's own
// Sessions. Do not add per-author roll-ups or team views here.

import type { MetricsRow } from "./db.js";
import { shortRepo } from "./normalize.js";

/** Think-gaps up to this long count as "you prompting/thinking". */
export const PROMPT_GAP_MAX_MS = 5 * 60_000;
/** Gaps up to this long count as "away while the agent waited"; longer = left for the day, excluded. */
export const AWAY_GAP_MAX_MS = 30 * 60_000;
/** Trailing correction/error streak that triggers the rabbit-hole Nudge. */
export const RABBIT_HOLE_MIN_STREAK = 4;

/** Tokens the exchange actually paid for (cache reads excluded). */
function freshTokens(r: { input_tokens: number; output_tokens: number; cache_write_tokens: number }): number {
  return r.input_tokens + r.output_tokens + r.cache_write_tokens;
}

/** The minimal shape the rabbit-hole detector needs (Exchange or MetricsRow). */
export interface StreakItem {
  isCorrection: boolean;
  errors: number;
  freshTokens: number;
}

export function streakItemFromRow(r: MetricsRow): StreakItem {
  return { isCorrection: r.is_correction, errors: r.errors, freshTokens: freshTokens(r) };
}

/**
 * The rabbit-hole signature: the *trailing* run of exchanges (in session order)
 * that are corrections or contain tool errors. Null until the run reaches
 * RABBIT_HOLE_MIN_STREAK.
 */
export function detectRabbitHole(items: StreakItem[]): { streak: number; tokens: number } | null {
  let streak = 0;
  let tokens = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (!it.isCorrection && it.errors === 0) break;
    streak++;
    tokens += it.freshTokens;
  }
  return streak >= RABBIT_HOLE_MIN_STREAK ? { streak, tokens } : null;
}

/** Count maximal correction/error runs of qualifying length — the retrospective view. */
export function countRabbitHoleEpisodes(items: StreakItem[]): number {
  let episodes = 0;
  let run = 0;
  for (const it of items) {
    if (it.isCorrection || it.errors > 0) {
      run++;
      if (run === RABBIT_HOLE_MIN_STREAK) episodes++;
    } else {
      run = 0;
    }
  }
  return episodes;
}

export function formatNudge(streak: number, tokens: number): string {
  const k = Math.round(tokens / 1000);
  return (
    `Oh: the last ${streak} turns in this session look like a loop ` +
    `(corrections/errors back to back, ~${k}k tokens). ` +
    `A fresh start — /clear and restating the goal with what you've learned — is often cheaper than turn ${streak + 1}.`
  );
}

/** One repo's slice of a report — time tracked separately per project. */
export interface RepoStat {
  repo: string;
  /** Time anatomy (ms). wall = prompt + away + work. */
  promptMs: number;
  awayMs: number;
  workMs: number;
  exchanges: number;
  sessions: number;
  /** input + output + cacheWrite (cache reads excluded), like the report total. */
  freshTokens: number;
}

export interface InsightsReport {
  author: string | null;
  sinceIso: string | null;
  exchanges: number;
  sessions: number;
  /** Time anatomy (ms). wall = prompt + away + work. */
  promptMs: number;
  awayMs: number;
  workMs: number;
  /** Per-repo breakdown, busiest (by wall time) first. Totals above are the sum. */
  byRepo: RepoStat[];
  /** Token economy. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite); null when no input at all. */
  cacheHitRate: number | null;
  topExchange: { sessionId: string; ts: string; repo: string | null; freshTokens: number } | null;
  /** Friction. */
  corrections: number;
  errors: number;
  interrupts: number;
  rabbitHoleEpisodes: number;
  /** Fun. */
  peakHour: number | null; // 0-23 local, by exchange count
  busiestDay: string | null; // YYYY-MM-DD local
  /** ms is ACTIVE time (work + counted gaps), not wall span — resumed sessions can span days. */
  longestSession: { sessionId: string; ms: number } | null;
}

export function computeInsights(
  rows: MetricsRow[],
  opts: { author?: string | null; sinceIso?: string | null } = {},
): InsightsReport {
  const report: InsightsReport = {
    author: opts.author ?? null,
    sinceIso: opts.sinceIso ?? null,
    exchanges: rows.length,
    sessions: 0,
    promptMs: 0,
    awayMs: 0,
    workMs: 0,
    byRepo: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: null,
    topExchange: null,
    corrections: 0,
    errors: 0,
    interrupts: 0,
    rabbitHoleEpisodes: 0,
    peakHour: null,
    busiestDay: null,
    longestSession: null,
  };
  if (rows.length === 0) return report;

  const sessions = new Map<string, MetricsRow[]>();
  const hourCounts = new Array<number>(24).fill(0);
  const dayCounts = new Map<string, number>();
  // Time tracked separately per repo; sessions counted per repo via a Set.
  interface RepoAcc { promptMs: number; awayMs: number; workMs: number; exchanges: number; freshTokens: number; sessions: Set<string> }
  const repoAcc = new Map<string, RepoAcc>();

  for (const r of rows) {
    const list = sessions.get(r.session_id);
    if (list) list.push(r);
    else sessions.set(r.session_id, [r]);

    // Bucket this row's think gap once, then fold into both the total and repo.
    let promptInc = 0;
    let awayInc = 0;
    if (r.think_ms != null) {
      if (r.think_ms <= PROMPT_GAP_MAX_MS) promptInc = r.think_ms;
      else if (r.think_ms <= AWAY_GAP_MAX_MS) awayInc = r.think_ms;
      // longer gaps = left for the day; excluded by design
    }
    report.promptMs += promptInc;
    report.awayMs += awayInc;
    report.workMs += r.work_ms;

    report.inputTokens += r.input_tokens;
    report.outputTokens += r.output_tokens;
    report.cacheReadTokens += r.cache_read_tokens;
    report.cacheWriteTokens += r.cache_write_tokens;
    const fresh = freshTokens(r);
    if (!report.topExchange || fresh > report.topExchange.freshTokens) {
      report.topExchange = { sessionId: r.session_id, ts: r.ts, repo: r.repo, freshTokens: fresh };
    }

    const repoKey = r.repo ?? "unknown";
    let acc = repoAcc.get(repoKey);
    if (!acc) {
      acc = { promptMs: 0, awayMs: 0, workMs: 0, exchanges: 0, freshTokens: 0, sessions: new Set() };
      repoAcc.set(repoKey, acc);
    }
    acc.promptMs += promptInc;
    acc.awayMs += awayInc;
    acc.workMs += r.work_ms;
    acc.exchanges++;
    acc.freshTokens += fresh;
    acc.sessions.add(r.session_id);

    if (r.is_correction) report.corrections++;
    report.errors += r.errors;
    if (r.interrupted) report.interrupts++;

    const d = new Date(r.ts);
    if (!Number.isNaN(d.getTime())) {
      hourCounts[d.getHours()]!++;
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }
  }

  report.sessions = sessions.size;

  report.byRepo = [...repoAcc.entries()]
    .map(([repo, a]): RepoStat => ({
      repo,
      promptMs: a.promptMs,
      awayMs: a.awayMs,
      workMs: a.workMs,
      exchanges: a.exchanges,
      sessions: a.sessions.size,
      freshTokens: a.freshTokens,
    }))
    .sort((x, y) => y.promptMs + y.awayMs + y.workMs - (x.promptMs + x.awayMs + x.workMs));

  const denom = report.inputTokens + report.cacheReadTokens + report.cacheWriteTokens;
  report.cacheHitRate = denom > 0 ? report.cacheReadTokens / denom : null;

  for (const [sessionId, list] of sessions) {
    // rows arrive ts-ordered; the per-session detector + wall clock rely on exchange order
    list.sort((a, b) => a.exchange_index - b.exchange_index);
    report.rabbitHoleEpisodes += countRabbitHoleEpisodes(list.map(streakItemFromRow));
    let active = 0;
    for (const r of list) {
      active += r.work_ms;
      if (r.think_ms != null && r.think_ms <= AWAY_GAP_MAX_MS) active += r.think_ms;
    }
    if (!report.longestSession || active > report.longestSession.ms) {
      report.longestSession = { sessionId, ms: active };
    }
  }

  let peak = 0;
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h]! > peak) {
      peak = hourCounts[h]!;
      report.peakHour = h;
    }
  }
  let busiest = 0;
  for (const [day, n] of dayCounts) {
    if (n > busiest) {
      busiest = n;
      report.busiestDay = day;
    }
  }

  return report;
}

// ---- Oh Tips — the mechanical evidence finder -------------------------------
// These rules locate the *real* moments worth a tip (the priciest exchange with
// the user's own quote, the rabbit-hole spiral, the cache-hit number) and phrase
// a grounded draft line for each. The SessionStart hook hands one draft to the
// user's OWN running agent to personalize at render — Oh itself makes no LLM
// call (so it works the same in hosted, keyless mode and costs Oh nothing). If
// the agent doesn't rewrite it, the grounded draft ships as-is. Either way the
// thing ADR 0007 rejected — an LLM *judge* of "good principles" — stays out:
// the agent only rewords facts found here, it never scores the user.

export interface Tip {
  /** Ranking weight ≈ estimated wasted tokens (or attention). */
  score: number;
  text: string;
}

/** "thanks!", "ok cool", "perfect" — a whole context resend to say goodbye. */
const PLEASANTRY_RE =
  /^(ok(ay)?|k|thanks?( you| u)?( so much)?|thx|ty|great|nice( one)?|cool|perfect|awesome|amazing|love (it|this)|lgtm|good (job|work)|well done|sounds good|got it|gotcha)[.!?\s]*$/i;

export function promptOf(chunkText: string): string {
  return (chunkText.split("\n")[0] ?? "").replace(/^User:\s*/, "").trim();
}

function quote(p: string, max = 60): string {
  const t = p.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 14:02" — enough to place the moment without a full timestamp. */
function when(tsIso: string): string {
  const d = new Date(tsIso);
  if (Number.isNaN(d.getTime())) return "";
  return `${WEEKDAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Every tip must point at a specific moment, quoting the user's own words —
 * a generic tip is a fortune cookie; a verbatim one is a mirror.
 */
export function generateTips(
  rows: MetricsRow[],
  chunkTexts: Array<{ id: string; text: string }>,
): Tip[] {
  const tips: Tip[] = [];
  if (rows.length === 0) return tips;
  const fresh = (r: MetricsRow) => r.input_tokens + r.output_tokens + r.cache_write_tokens;
  const promptById = new Map(chunkTexts.map((c) => [c.id, promptOf(c.text)]));

  // 1. Pleasantry-only turns — each one re-sends the whole conversation.
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
        `the agent re-read the whole conversation to hear it. You did that ${pleasantries.length}× this week (~${fmtTokens(tok)}). ` +
        `Your AI doesn't need closure; fold the thanks into your next real ask.`,
    });
  }

  // 2. Rabbit holes — quote the message that started the longest spiral.
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
        `On the third "still broken", /clear and restate the goal with what you've learned — turn ${longest.rows.length + 1} is rarely cheaper than a fresh start.`,
    });
  }

  // 3. One monster exchange — quote the ask that bought it.
  let top: MetricsRow | null = null;
  for (const r of rows) if (!top || fresh(r) > fresh(top)) top = r;
  if (top && fresh(top) >= 300_000) {
    const p = promptById.get(top.id);
    tips.push({
      score: fresh(top) / 2,
      text:
        `Your priciest moment this week: ${p ? `"${quote(p)}"` : "one exchange"} (${top.repo ?? "?"} · ${when(top.ts)}) → ` +
        `${fmtTokens(fresh(top))} fresh tokens in a single turn. Whatever got pasted there stayed in context for the rest of the session — ` +
        `trim heavy pastes, or /clear after the heavy lift.`,
    });
  }

  // 4. Cache-hit rate — context churn is the silent spend.
  const input = rows.reduce((s, r) => s + r.input_tokens, 0);
  const cacheRead = rows.reduce((s, r) => s + r.cache_read_tokens, 0);
  const cacheWrite = rows.reduce((s, r) => s + r.cache_write_tokens, 0);
  const denom = input + cacheRead + cacheWrite;
  if (denom > 1_000_000 && cacheRead / denom < 0.7) {
    tips.push({
      score: Math.round(input * 0.3),
      text:
        `Your cache hit is ${Math.round((cacheRead / denom) * 100)}% this week — fresh context costs ~10× cached. ` +
        `Gaps over ~5 minutes mid-session re-buy the same context; finish a thread while it's warm.`,
    });
  }

  // 5. Interrupting late — point at the most recent one.
  const interrupted = rows.filter((r) => r.interrupted);
  if (interrupted.length >= 3) {
    const lastInt = interrupted[interrupted.length - 1]!;
    tips.push({
      score: 20_000 * interrupted.length,
      text:
        `You hit Esc ${interrupted.length} times this week (latest ${when(lastInt.ts)}). Interrupting is healthy — do it EARLIER: ` +
        `every token before the Esc is already spent, and a wrong direction rarely fixes itself by turn three.`,
    });
  }

  // 6. Corrections outside holes — quote the priciest do-over.
  const corrections = rows.filter((r) => r.is_correction);
  if (corrections.length >= 5) {
    const priciest = corrections.reduce((a, b) => (fresh(b) > fresh(a) ? b : a));
    const p = promptById.get(priciest.id);
    tips.push({
      score: 15_000 * corrections.length,
      text:
        `${corrections.length} do-overs this week${p ? ` — like "${quote(p)}" (${when(priciest.ts)})` : ""}. ` +
        `Front-load the specifics — paste the exact error, name the file, state the constraint — and the first answer lands more often than the third.`,
    });
  }

  return tips.sort((a, b) => b.score - a.score);
}

function fmtDuration(msTotal: number): string {
  const mins = Math.round(msTotal / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function formatInsights(r: InsightsReport, today?: InsightsReport | null): string {
  const who = r.author ? `${r.author}'s` : "Your";
  const since = r.sinceIso ? ` since ${r.sinceIso.slice(0, 10)}` : "";
  const lines: string[] = [`${who} vibecoding${since}`, ""];

  if (r.exchanges === 0) {
    lines.push("No captured exchanges in this window. (Run `oh backfill`, or widen --since.)");
    return lines.join("\n");
  }

  // Today first — the at-a-glance "how's today going" before the full window.
  if (today && today.exchanges > 0) {
    const tWall = today.promptMs + today.awayMs + today.workMs;
    const tFresh = today.inputTokens + today.outputTokens + today.cacheWriteTokens;
    lines.push(
      `Today  ~${fmtDuration(tWall)}  (${fmtDuration(today.promptMs)} you · ${fmtDuration(today.workMs)} agent) · ` +
        `${fmtTokens(tFresh)} fresh tokens · ${today.sessions} session${today.sessions === 1 ? "" : "s"}` +
        (today.rabbitHoleEpisodes > 0
          ? ` · ${today.rabbitHoleEpisodes} rabbit hole${today.rabbitHoleEpisodes === 1 ? "" : "s"}`
          : ""),
    );
    lines.push("");
  }

  const wall = r.promptMs + r.awayMs + r.workMs;
  lines.push(`Sessions: ${r.sessions}   Exchanges: ${r.exchanges}`);
  lines.push("");
  lines.push(`Time at the wheel  ~${fmtDuration(wall)}`);
  lines.push(`  you prompting/thinking   ${fmtDuration(r.promptMs)}`);
  lines.push(`  agent working            ${fmtDuration(r.workMs)}`);
  lines.push(`  you away (agent waited)  ${fmtDuration(r.awayMs)}`);
  lines.push("");
  if (r.byRepo.length >= 2) {
    lines.push(`By repo  (the total above is the sum)`);
    const labels = new Map(r.byRepo.map((b) => [b.repo, shortRepo(b.repo)]));
    const nameW = Math.min(24, Math.max(...[...labels.values()].map((l) => l.length)));
    for (const b of r.byRepo) {
      const repoWall = b.promptMs + b.awayMs + b.workMs;
      lines.push(
        `  ${labels.get(b.repo)!.padEnd(nameW)}  ${fmtDuration(repoWall).padStart(8)}  ` +
          `(${fmtDuration(b.promptMs)} you · ${fmtDuration(b.workMs)} agent)  ` +
          `${b.sessions} session${b.sessions === 1 ? "" : "s"} · ${fmtTokens(b.freshTokens)} tok`,
      );
    }
    lines.push("");
  }
  lines.push(
    `Tokens  ${fmtTokens(r.inputTokens + r.outputTokens + r.cacheWriteTokens)} fresh ` +
      `(${fmtTokens(r.outputTokens)} out) + ${fmtTokens(r.cacheReadTokens)} cache reads` +
      (r.cacheHitRate != null ? `   cache hit ${pct(r.cacheHitRate)}` : ""),
  );
  if (r.topExchange) {
    lines.push(
      `  most expensive exchange  ${fmtTokens(r.topExchange.freshTokens)} fresh tokens` +
        `  (${r.topExchange.repo ?? "?"}, ${r.topExchange.ts.slice(0, 16).replace("T", " ")})`,
    );
  }
  lines.push("");
  lines.push(
    `Friction  ${r.corrections} corrections · ${r.errors} tool errors · ` +
      `${r.interrupts} interrupts · ${r.rabbitHoleEpisodes} rabbit-hole episode${r.rabbitHoleEpisodes === 1 ? "" : "s"}`,
  );
  lines.push("");
  const fun: string[] = [];
  if (r.peakHour != null) fun.push(`peak hour ${String(r.peakHour).padStart(2, "0")}:00`);
  if (r.busiestDay) fun.push(`busiest day ${r.busiestDay}`);
  if (r.longestSession) fun.push(`longest session ${fmtDuration(r.longestSession.ms)}`);
  if (fun.length > 0) lines.push(`Fun  ${fun.join(" · ")}`);
  lines.push("");
  lines.push(
    `(gaps ≤5m count as prompting, 5–30m as away, >30m excluded; ` +
      `tokens are counts, not cost; all from your own captured sessions)`,
  );
  return lines.join("\n");
}
