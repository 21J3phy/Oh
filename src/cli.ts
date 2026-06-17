#!/usr/bin/env node
// Oh CLI. Public: `oh init`, `oh migrate`, `oh backfill`, `oh status`.
// Internal (used by hooks/registration): `oh capture`, `oh mcp`, `oh hook`.

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  CONFIG_PATH,
  LOCAL_DIR,
  OFFSETS_DIR,
  SCHEMA_OUT_PATH,
  ensureDirs,
  incognitoSince,
  isIncognito,
  loadConfig,
  readPartialConfig,
  saveConfig,
  setIncognito,
} from "./config.js";
import { SCHEMA_SQL } from "./schema.js";
import { createDb } from "./db.js";
import { createEmbedder } from "./embed.js";
import { captureAll, captureFile, gitRepoIdentity } from "./capture.js";
import { shortRepo } from "./normalize.js";
import { ask, formatAskResult, parseSince } from "./ask.js";
import { computeInsights, formatInsights, generateTips } from "./insights.js";
import { formatDailyHistory, pickRepoBrief, readInsightsCache, refreshInsightsCache } from "./brief.js";
import { runMcpServer } from "./mcp.js";
import { DEFAULT_LOCAL_MODEL as LOCAL_MODEL } from "./local/embed.js";
import { runHook } from "./hook.js";
import { registerAll, installSkill } from "./register.js";
import { bareHostedClient, hostedClient, hostedConfigured } from "./hosted.js";
import { log } from "./log.js";
import type { Config, Tool } from "./types.js";

const CLI_PATH = fileURLToPath(import.meta.url);
const NODE_PATH = process.execPath;
// CLI_PATH is <repo>/dist/cli.js (built) or <repo>/src/cli.ts (dev); either way
// the repo root is two levels up, and the ask-why skill ships under skills/.
const REPO_ROOT = dirname(dirname(CLI_PATH));
const SKILL_SOURCE = join(REPO_ROOT, "skills", "ask-why", "SKILL.md");
const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");
const CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");

/** Hook + MCP registration plus the ask-why skill, installed for both agents.
 *  Insights-only (ADR 0014): capture hook + statusline only — no `ask` MCP and
 *  no ask-why skill (there's no `ask` to trigger). */
function wire(apply: boolean, insightsOnly = false) {
  const parts = insightsOnly
    ? [registerAll(NODE_PATH, CLI_PATH, apply, undefined, true)]
    : [
        registerAll(NODE_PATH, CLI_PATH, apply),
        installSkill(SKILL_SOURCE, CLAUDE_SKILLS_DIR, apply),
        installSkill(SKILL_SOURCE, CODEX_SKILLS_DIR, apply),
      ];
  return {
    changed: parts.flatMap((p) => p.changed),
    skipped: parts.flatMap((p) => p.skipped),
    backups: parts.flatMap((p) => p.backups),
    notes: parts.flatMap((p) => p.notes),
  };
}

function asTool(v: string | undefined): Tool | undefined {
  return v === "claude" || v === "codex" || v === "copilot" ? v : undefined;
}

function inferTool(file: string): Tool {
  if (/[/\\]\.codex[/\\]/.test(file)) return "codex";
  if (/[/\\]\.copilot[/\\]/.test(file)) return "copilot";
  return "claude";
}

function sinceMsFrom(s: string | undefined): number | null {
  const iso = parseSince(s);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const USAGE = `Oh — give your AI a past.

Insights-only (just count token/time usage — no ask, no stored text — ADR 0014):
  oh init --insights-only Lightest install: capture writes ONLY Metrics (tokens,
                  [--yes]  durations) to ~/.oh/local — no embeddings, no model, no
                          ask, no MCP, never stores your prompts or code. Wires
                          the capture hook + statusline only.
                          (then) oh backfill, restart agents, oh insights.

Local (fully offline — no cloud, no API, nothing leaves the machine — ADR 0013):
  oh init --local [--yes] Configure ~/.oh for an on-device store (~/.oh/local) and
                          an in-process embedding model, then wire Claude/Codex/
                          Copilot. No keys, no account, no Supabase. The easiest
                          thing for a security-locked org to approve.
                          (then) oh backfill, then restart your agents.

Hosted (no keys — ADR 0010):
  oh signup [--email E]   Create your hosted Oh account (then confirm via email).
  oh login [--email E]    Log in; stores your session in ~/.oh.
  oh team create "<name>" Create a team; prints the invite code for teammates.
  oh team join <code>     Join a team by invite code.
  oh team                 Show your team + invite code.
  (then) oh init --yes    Wire Claude/Codex/Copilot MCP+hooks+skill, and backfill.

Self-host (your own Supabase + OpenAI keys):
  oh init [flags]         Configure ~/.oh, write the schema, wire Claude/Codex
                          (hooks + ask MCP + ask-why skill) and Copilot (ask MCP).
                          Run with no
                          flags to be prompted, or non-interactively with:
                          --author --supabase-url --supabase-key --openai-key --yes
                          (--no-wire skips editing tool configs; --repos "name"
                          limits capture to one or more git projects).
  oh migrate              (Re)write the schema SQL to paste into Supabase.
  oh backfill [--since W] Seed the store from your existing Claude+Codex sessions.
                          --force re-processes every session (re-stamps each
                          row's git repo; use after changing repo identity).
  oh ask "<question>"     Query the store from the terminal (--who --repo --since W).
                          Scoped to the repo you're in by default; --all-repos
                          searches everywhere (off switch: repoScopedAsk=false).
  oh insights             A today summary, then your last 7 days of vibecoding:
                          time anatomy (incl. a per-repo breakdown), tokens,
                          friction, fun stats (--since W, --repo R). Always your
                          own sessions — Insights are individual-only.
  oh pause                Incognito: stop recording sessions into the Team Brain.
  oh resume               Resume recording (the paused stretch stays a hole).
  oh status               Show config + how much is in the Team Brain.

Capture spans Claude Code, Codex, and GitHub Copilot (CLI ~/.copilot + VS Code).

Internal (wired by 'oh init'):
  oh capture --file F --tool T | oh capture --all [--tool T] [--since W]
  oh mcp                  Start the stdio MCP server exposing the 'ask' tool.
  oh hook --tool T        Hook entrypoint (spawns detached capture).

W = ISO date or window like 7d / 24h / 2w.`;

interface InitOpts {
  author?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  openaiKey?: string;
  yes?: boolean;
  noWire?: boolean;
  repos?: string[];
  local?: boolean;
  insightsOnly?: boolean;
}

function printInitNextSteps(): void {
  console.log("\nNext:");
  console.log("  1. Ensure the schema is applied once in Supabase (SQL editor → paste ~/.oh/schema.sql → Run).");
  console.log("  2. `oh backfill` to seed the store from your existing sessions.");
  console.log("  3. Restart Claude/Codex/Copilot to load the MCP server + hooks + skill.");
  console.log('  4. Use the `ask` tool from either: "why did we …?"');
}

/** Wire (and optionally backfill) for a keyless mode — shared by hosted/local. */
async function wireOnly(
  interactive: boolean,
  yes: boolean,
  nextLine: string,
  insightsOnly = false,
): Promise<void> {
  const plan = wire(false, insightsOnly);
  for (const c of plan.changed) console.log(`  + ${c}`);
  for (const s of plan.skipped) console.log(`  · ${s}`);
  let apply = yes;
  if (!apply && interactive && plan.changed.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question("\nApply this wiring? (files are backed up first) [y/N] ")).trim().toLowerCase();
    rl.close();
    apply = a === "y" || a === "yes";
  }
  if (apply && plan.changed.length > 0) {
    const res = wire(true, insightsOnly);
    console.log("✓ wired:");
    for (const c of res.changed) console.log(`  + ${c}`);
    for (const n of res.notes) console.log(`note: ${n}`);
  }
  console.log(nextLine);
}

async function cmdInit(opts: InitOpts): Promise<void> {
  ensureDirs();
  const existing = readPartialConfig();
  const interactive = process.stdin.isTTY === true;

  // Insights-only (ADR 0014): the lightest Oh — counts token/time usage and
  // nothing else. No `ask`, no MCP, no embedding model, no stored text; capture
  // writes only Metrics. Implies local mode. Checked first so re-running plain
  // `oh init` on an insights-only install doesn't quietly add `ask`.
  if (opts.insightsOnly || existing.insightsOnly) {
    let author = opts.author ?? existing.author ?? "";
    if (!author && interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      author = (await rl.question("Your name (attributed to your Sessions): ")).trim() || "me";
      rl.close();
    }
    saveConfig({
      mode: "local",
      insightsOnly: true,
      author: author || "me",
      ...(opts.repos && opts.repos.length > 0 ? { repos: opts.repos } : {}),
    });
    console.log(`✓ wrote ${CONFIG_PATH} (insights-only — counts token/time usage; no ask, no stored text)`);
    if (opts.noWire) {
      console.log("Skipped wiring (--no-wire).");
    } else {
      console.log("\nPlanned wiring (Claude & Codex: capture hook + statusline only — no `ask` MCP, no skill):");
      await wireOnly(interactive, opts.yes === true, "", true);
    }
    console.log("\nNext:");
    console.log("  1. `oh backfill` — counts your existing sessions into ~/.oh/local (Metrics only, no text).");
    console.log("  2. Restart Claude/Codex so the capture hook + brief load.");
    console.log("  3. `oh insights` for the report; the session-start brief shows your daily numbers.");
    return;
  }

  // Local mode (ADR 0013): nothing leaves the machine — no keys, no schema, no
  // cloud. Just a name to attribute Sessions to, then wire + backfill locally.
  if (opts.local || existing.mode === "local") {
    let author = opts.author ?? existing.author ?? "";
    if (!author && interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      author = (await rl.question("Your name (attributed to your Sessions): ")).trim() || "me";
      rl.close();
    }
    saveConfig({
      mode: "local",
      author: author || "me",
      embeddingModel: LOCAL_MODEL,
      ...(opts.repos && opts.repos.length > 0 ? { repos: opts.repos } : {}),
    });
    console.log(`✓ wrote ${CONFIG_PATH} (mode: local — fully offline, nothing leaves this machine)`);
    if (opts.noWire) {
      console.log("Skipped wiring (--no-wire).");
    } else {
      console.log("\nPlanned wiring (Claude & Codex: hooks + `ask` MCP + ask-why skill; Copilot: `ask` MCP):");
      await wireOnly(interactive, opts.yes === true, "");
    }
    console.log("\nNext:");
    console.log("  1. `oh backfill` — seeds a LOCAL store under ~/.oh/local from your existing sessions.");
    console.log("     (first run fetches a ~23MB embedding model into ~/.oh/models, then never hits the network).");
    console.log("  2. Restart Claude/Codex/Copilot to load the MCP server + hooks + skill.");
    console.log('  3. Use the `ask` tool from either: "why did we …?" — answered entirely on-device.');
    return;
  }

  // Hosted mode: no keys, no schema — login/team already happened; just wire.
  if (existing.mode === "hosted") {
    if (!existing.hosted?.teamId) {
      throw new Error('hosted mode: create/join a team first (`oh team create "<name>"` or `oh team join <code>`)');
    }
    const plan = wire(false);
    for (const c of plan.changed) console.log(`  + ${c}`);
    for (const s of plan.skipped) console.log(`  · ${s}`);
    let apply = opts.yes === true;
    if (!apply && interactive && plan.changed.length > 0) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question("\nApply this wiring? (files are backed up first) [y/N] ")).trim().toLowerCase();
      rl.close();
      apply = a === "y" || a === "yes";
    }
    if (apply && plan.changed.length > 0) {
      const res = wire(true);
      console.log("✓ wired:");
      for (const c of res.changed) console.log(`  + ${c}`);
      for (const n of res.notes) console.log(`note: ${n}`);
    }
    console.log("\nNext: `oh backfill`, then fully restart Claude Code and Codex.");
    return;
  }

  // Flags win, then existing config; prompt only for the rest, only with a TTY.
  let author = opts.author ?? existing.author ?? "";
  let supabaseUrl = opts.supabaseUrl ?? existing.supabaseUrl ?? "";
  let supabaseKey = opts.supabaseKey ?? existing.supabaseKey ?? "";
  let openaiKey = opts.openaiKey ?? existing.openaiKey ?? "";

  if (interactive && (!author || !supabaseUrl || !supabaseKey || !openaiKey)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Oh setup — config is stored locally at ${CONFIG_PATH}.\n`);
    const prompt = async (label: string, def?: string): Promise<string> =>
      (await rl.question(`${label}${def ? ` [${def}]` : ""}: `)).trim() || def || "";
    if (!author) author = await prompt("Your name (attributed to your Sessions)", existing.author);
    if (!supabaseUrl) supabaseUrl = await prompt("Supabase project URL", existing.supabaseUrl);
    if (!supabaseKey) {
      console.log("(keys below are echoed in the terminal)");
      supabaseKey = await prompt("Supabase secret key", existing.supabaseKey);
    }
    if (!openaiKey) openaiKey = await prompt("OpenAI API key", existing.openaiKey);
    rl.close();
  }

  saveConfig({
    author,
    supabaseUrl,
    supabaseKey,
    openaiKey,
    ...(opts.repos && opts.repos.length > 0 ? { repos: opts.repos } : {}),
  });
  const missing = Object.entries({ author, supabaseUrl, supabaseKey, openaiKey })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(
      `Missing: ${missing.join(", ")}. Provide via flags ` +
        "(--author / --supabase-url / --supabase-key / --openai-key) or run `oh init` in a terminal.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✓ wrote ${CONFIG_PATH}`);

  writeFileSync(SCHEMA_OUT_PATH, SCHEMA_SQL);
  console.log(`✓ wrote schema to ${SCHEMA_OUT_PATH} (apply once in the Supabase SQL editor)`);

  if (opts.noWire) {
    console.log("Skipped wiring (--no-wire).");
    printInitNextSteps();
    return;
  }

  const plan = wire(false);
  if (plan.changed.length > 0) {
    console.log("\nPlanned wiring (Claude & Codex: hooks + `ask` MCP + ask-why skill; Copilot: `ask` MCP):");
    for (const c of plan.changed) console.log(`  + ${c}`);
  }
  for (const s of plan.skipped) console.log(`  · ${s}`);

  let apply = opts.yes === true;
  if (!apply && interactive && plan.changed.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question("\nApply this wiring? (files are backed up first) [y/N] "))
      .trim()
      .toLowerCase();
    rl.close();
    apply = a === "y" || a === "yes";
  }

  if (apply && plan.changed.length > 0) {
    const res = wire(true);
    console.log("\n✓ wired:");
    for (const c of res.changed) console.log(`  + ${c}`);
    if (res.backups.length > 0) {
      console.log("backups:");
      for (const b of res.backups) console.log(`  ${b}`);
    }
    for (const n of res.notes) console.log(`note: ${n}`);
  } else if (!apply && plan.changed.length > 0) {
    console.log("Skipped wiring — re-run with --yes (or `oh init` in a terminal) to apply.");
  }

  printInitNextSteps();
}

function cmdMigrate(): void {
  ensureDirs();
  writeFileSync(SCHEMA_OUT_PATH, SCHEMA_SQL);
  console.log(`Schema written to ${SCHEMA_OUT_PATH}`);
  console.log("Run it once in your Supabase project's SQL editor (paste → Run).");
  console.log("It is idempotent (create … if not exists), so re-running is safe.");
}

function makeClients(cfg: Config) {
  return { db: createDb(cfg), embedder: createEmbedder(cfg) };
}

async function cmdBackfill(since: string | undefined, force?: boolean): Promise<void> {
  const cfg = loadConfig();
  const { db, embedder } = makeClients(cfg);
  const sinceMs = sinceMsFrom(since);
  console.log(
    `Backfilling as "${cfg.author}"${sinceMs ? ` since ${new Date(sinceMs).toISOString()}` : ""}` +
      `${force ? " (--force: re-processing every session)" : ""} …`,
  );
  const r = await captureAll(cfg, db, embedder, { sinceMs, force });
  console.log(
    `Scanned ${r.files} files: ${r.sessions} updated, ${r.skipped} unchanged, ${r.embedded} chunks embedded, ${r.errors} errors.`,
  );
  try {
    console.log(`Team Brain now holds ${await db.chunkCount()} chunks.`);
  } catch (err) {
    console.error(
      `(could not count chunks — is the schema applied? ${(err as Error).message})`,
    );
  }
}

async function cmdCapture(opts: {
  file?: string;
  all?: boolean;
  tool?: Tool;
  since?: string;
}): Promise<void> {
  const cfg = loadConfig();
  const { db, embedder } = makeClients(cfg);
  if (opts.all) {
    const r = await captureAll(cfg, db, embedder, {
      tool: opts.tool,
      sinceMs: sinceMsFrom(opts.since),
    });
    log("capture", `sweep: ${r.sessions} updated, ${r.embedded} chunks, ${r.errors} errors`);
    if (process.stdout.isTTY) {
      console.log(`${r.sessions} updated, ${r.embedded} chunks embedded, ${r.errors} errors.`);
    }
    return;
  }
  if (opts.file) {
    const tool = opts.tool ?? inferTool(opts.file);
    let r: Awaited<ReturnType<typeof captureFile>> | null = null;
    try {
      r = await captureFile(opts.file, tool, cfg, db, embedder);
      log("capture", `file ${opts.file}: +${r.embedded} chunks (skipped=${r.skipped})`);
    } finally {
      // The statusline/brief cache is a local-only recompute — keep it warm even
      // when capture itself failed (parser error, network blip), so the numbers
      // never silently freeze. Best-effort: its own failure must not surface.
      try {
        await refreshInsightsCache(cfg, db);
      } catch (err) {
        log("capture", `insights cache refresh skipped — ${(err as Error).message}`);
      }
    }
    if (process.stdout.isTTY && r) {
      console.log(`${tool} ${r.sessionId ?? "?"}: +${r.embedded} chunks (skipped=${r.skipped}).`);
    }
    return;
  }
  throw new Error("capture needs --file <path> or --all");
}

async function cmdAsk(
  question: string,
  opts: { who?: string; repo?: string; since?: string; allRepos?: boolean },
): Promise<void> {
  if (!question.trim()) throw new Error('ask needs a question, e.g. oh ask "why did we choose X?"');
  const cfg = loadConfig();
  if (cfg.insightsOnly) {
    throw new Error(
      "this is an insights-only install — `ask` is disabled (no stored text to search). " +
        "Run `oh init --local` for the full memory + ask, or `oh insights` for your usage.",
    );
  }
  const { db, embedder } = makeClients(cfg);
  // Default to the repo you're in (config repoScopedAsk, on by default). An
  // explicit --repo wins; --all-repos searches everything.
  let repo = opts.repo;
  if (!repo && !opts.allRepos && cfg.repoScopedAsk !== false) {
    const here = gitRepoIdentity(process.cwd());
    if (here !== "unknown") {
      repo = here;
      if (process.stdout.isTTY) {
        console.error(`(scoped to repo "${shortRepo(here)}" — use --all-repos to search everywhere)`);
      }
    }
  }
  const result = await ask(cfg, db, embedder, {
    question,
    who: opts.who,
    repo,
    since: opts.since,
  });
  console.log(formatAskResult(result));
}

async function promptHidden(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("(input is echoed in the terminal)");
  const v = (await rl.question(`${label}: `)).trim();
  rl.close();
  return v;
}

async function resolveAuthor(fallback?: string): Promise<string> {
  const existing = readPartialConfig().author ?? fallback;
  if (existing) return existing;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const v = (await rl.question("Your name (attributed to your Sessions): ")).trim();
  rl.close();
  if (!v) throw new Error("a display name is required");
  return v;
}

async function cmdSignup(opts: { email?: string }): Promise<void> {
  if (!hostedConfigured()) throw new Error("hosted Oh is not available in this build");
  const email = opts.email ?? (await promptHidden("Email"));
  const password = await promptHidden("Choose a password (min 8 chars)");
  const sb = bareHostedClient();
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw new Error(`signup failed: ${error.message}`);
  if (data.session) {
    // Email confirmation disabled server-side — session granted immediately.
    saveHostedSession(email, data.session);
    console.log("✓ account created and logged in.");
    console.log('Next: `oh team create "<name>"` or `oh team join <code>`.');
  } else {
    console.log("✓ account created. Check your email and click the confirmation link,");
    console.log("then run `oh login`.");
  }
}

function saveHostedSession(
  email: string,
  session: { access_token: string; refresh_token: string; user: { id: string } },
): void {
  const prev = readPartialConfig().hosted;
  saveConfig({
    mode: "hosted",
    hosted: {
      ...(prev ?? {}),
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      email,
    },
  });
}

async function cmdLogin(opts: { email?: string }): Promise<void> {
  if (!hostedConfigured()) throw new Error("hosted Oh is not available in this build");
  const email = opts.email ?? (await promptHidden("Email"));
  const password = await promptHidden("Password");
  const sb = bareHostedClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`login failed: ${error?.message ?? "no session"} (unconfirmed email? check your inbox)`);
  }
  saveHostedSession(email, data.session);
  console.log(`✓ logged in as ${email}`);

  // If you already belong to exactly one team, adopt it silently.
  const { data: teams } = await sb.rpc("my_teams");
  const list = (teams ?? []) as Array<{ team_id: string; team_name: string; author_name: string; invite_code: string }>;
  if (list.length === 1) {
    const t = list[0]!;
    saveConfig({ author: t.author_name, hosted: { ...readPartialConfig().hosted!, teamId: t.team_id, inviteCode: t.invite_code } });
    console.log(`✓ team: ${t.team_name} (invite code: ${t.invite_code})`);
    console.log("Next: `oh init --yes` to wire Claude/Codex, then `oh backfill`.");
  } else if (list.length === 0) {
    console.log('Next: `oh team create "<name>"` or `oh team join <code>`.');
  } else {
    console.log(`You belong to ${list.length} teams — pick one with \`oh team join <code>\`.`);
  }
}

async function cmdTeam(
  sub: string | undefined,
  arg: string | undefined,
  authorFlag?: string,
): Promise<void> {
  const cfg = readPartialConfig();
  if (cfg.mode !== "hosted" || !cfg.hosted) throw new Error("run `oh login` first");
  const sb = await hostedClient(cfg as Config);

  if (sub === "create") {
    if (!arg) throw new Error('usage: oh team create "<team name>" [--author "Name"]');
    const author = await resolveAuthor(authorFlag);
    const { data, error } = await sb.rpc("create_team", { p_name: arg, p_author: author });
    if (error) throw new Error(`create_team failed: ${error.message}`);
    const r = data as { team_id: string; invite_code: string };
    saveConfig({ author, hosted: { ...cfg.hosted, teamId: r.team_id, inviteCode: r.invite_code } });
    console.log(`✓ team "${arg}" created.`);
    console.log(`Invite code for teammates: ${r.invite_code}`);
    console.log("Next: `oh init --yes`, then `oh backfill`.");
    return;
  }
  if (sub === "join") {
    if (!arg) throw new Error('usage: oh team join <invite-code> [--author "Name"]');
    const author = await resolveAuthor(authorFlag);
    const { data, error } = await sb.rpc("join_team", { p_code: arg, p_author: author });
    if (error) throw new Error(`join_team failed: ${error.message}`);
    const r = data as { team_id: string };
    saveConfig({ author, hosted: { ...cfg.hosted, teamId: r.team_id, inviteCode: arg } });
    console.log("✓ joined team.");
    console.log("Next: `oh init --yes`, then `oh backfill`.");
    return;
  }
  // show
  const { data, error } = await sb.rpc("my_teams");
  if (error) throw new Error(`my_teams failed: ${error.message}`);
  const list = (data ?? []) as Array<{ team_id: string; team_name: string; author_name: string; role: string; invite_code: string }>;
  if (list.length === 0) {
    console.log('No team yet — `oh team create "<name>"` or `oh team join <code>`.');
    return;
  }
  for (const t of list) {
    const current = t.team_id === cfg.hosted.teamId ? " (current)" : "";
    console.log(`${t.team_name}${current} — you are ${t.author_name} (${t.role}); invite code: ${t.invite_code}`);
  }
}

async function cmdInsights(opts: { since?: string; repo?: string; history?: boolean }): Promise<void> {
  if (opts.history) {
    // Saved per-day totals — survives the day rolling over (the live report and
    // the brief only cover today + this week).
    console.log("Daily history (local days — only you see these):\n");
    console.log(formatDailyHistory());
    return;
  }
  const cfg = loadConfig();
  const { db } = makeClients(cfg);
  const sinceIso = parseSince(opts.since ?? "7d");
  // Individual-only by design (ADR 0008): always and only the caller's Sessions.
  const author = cfg.author;
  const rows = await db.fetchMetrics({
    author,
    repo: opts.repo ?? null,
    since: sinceIso,
  });
  // "Today" = the local calendar day (resets at local midnight, like the brief),
  // shown as an at-a-glance summary above the full --since window.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayIso = dayStart.toISOString();
  const todayRows = rows.filter((r) => r.ts >= dayIso);
  const today = todayRows.length > 0 ? computeInsights(todayRows, { author, sinceIso: dayIso }) : null;
  console.log(formatInsights(computeInsights(rows, { author, sinceIso }), today));
  try {
    const texts = await db.fetchOwnChunkTexts(author, sinceIso ?? new Date(0).toISOString());
    const tips = generateTips(rows, texts).slice(0, 3);
    if (tips.length > 0) {
      console.log("\nOh tips (from your own sessions — only you see these):");
      tips.forEach((t, i) => console.log(`  ${i + 1}. ${t.text}`));
    }
  } catch {
    // tips are decoration; the report already printed
  }
}

/**
 * How long the statusline cache may sit un-refreshed before we mark it stale.
 * Capture refreshes it every turn, so during active work this is only crossed
 * when capture is failing; long enough that ordinary idle gaps don't trip it.
 */
const STATUSLINE_STALE_MS = 90 * 60_000;

/**
 * Claude Code statusline: a compact, always-visible line at the bottom of the
 * UI — the surface that needs no message to appear. Pure cache read.
 */
function cmdStatusline(): void {
  const now = Date.now();
  const cache = readInsightsCache(now);
  if (!cache) return; // print nothing — Claude Code shows nothing
  // Scope to the project this statusline is rendering in (default), so today's
  // numbers reflect the current repo only — and stay blank on an untracked one.
  const cfg = readPartialConfig();
  const scoped = cfg.repoScopedBrief !== false;
  const data = pickRepoBrief(cache, scoped ? gitRepoIdentity(process.cwd()) : null, scoped);
  if (!data) return; // untracked project — nothing to show
  const d = data.day;
  const parts: string[] = [];
  // No last-worked-on here: the status bar is tight, and the brief carries it.
  if (d.exchanges > 0) {
    const fresh = d.inputTokens + d.outputTokens + d.cacheWriteTokens;
    const mins = Math.round((d.promptMs + d.awayMs + d.workMs) / 60_000);
    const dur = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
    parts.push(`${dur} today`, `${fresh >= 1_000_000 ? (fresh / 1_000_000).toFixed(1) + "M" : Math.round(fresh / 1000) + "k"} tok`);
    if (d.rabbitHoleEpisodes > 0) parts.push(`${d.rabbitHoleEpisodes} 🕳`);
  }
  // The post-turn capture refreshes this cache every turn; if it hasn't advanced
  // in a while the numbers are frozen (commonly: capture is erroring — an expired
  // hosted token needs `oh login`). Flag it rather than pass stale counts off as
  // live. Only when there's something to be stale about (skip on an idle day).
  if (parts.length > 0) {
    const ageMs = now - Date.parse(cache.updatedAt);
    if (Number.isFinite(ageMs) && ageMs >= STATUSLINE_STALE_MS) {
      const m = Math.round(ageMs / 60_000);
      parts.push(`⚠ ${m < 90 ? `${m}m` : `${Math.round(m / 60)}h`} stale`);
    }
  }
  if (parts.length > 0) console.log(`Oh · ${parts.join(" · ")}`);
}

/** `oh pause` / `oh resume` — global incognito (ADR 0011). */
function cmdIncognito(on: boolean): void {
  setIncognito(on);
  if (on) {
    console.log("🔒 incognito ON — new sessions won't be recorded into the Team Brain.");
    console.log("   Nothing is stored or embedded until you run `oh resume`; the gap");
    console.log("   can't be backfilled later. (Per-session alt: OH_INCOGNITO=1.)");
  } else {
    console.log("● recording resumed — new sessions flow into the Team Brain again.");
    console.log("   What happened while paused stays a permanent hole, by design.");
  }
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  let host = cfg.supabaseUrl ?? "";
  try {
    host = new URL(cfg.supabaseUrl ?? "").host;
  } catch {
    /* keep raw */
  }
  console.log(`author:    ${cfg.author}`);
  if (cfg.insightsOnly) {
    console.log(`mode:      insights-only (counts token/time usage; no ask, no stored text)`);
    console.log(`store:     ${LOCAL_DIR} (Metrics only)`);
  } else if (cfg.mode === "local") {
    console.log(`mode:      local (fully offline — nothing leaves this machine)`);
    console.log(`store:     ${LOCAL_DIR}`);
  } else if (cfg.mode === "hosted") {
    console.log(`mode:      hosted (${cfg.hosted?.email ?? "?"})`);
    console.log(`team:      ${cfg.hosted?.teamId ?? "none"} (invite: ${cfg.hosted?.inviteCode ?? "—"})`);
  } else {
    console.log(`mode:      self-host`);
    console.log(`supabase:  ${host}`);
  }
  // Embedding/recency tuning is meaningless insights-only (nothing is embedded).
  if (!cfg.insightsOnly) {
    console.log(`model:     ${cfg.embeddingModel}`);
    console.log(`recency:   half-life ${cfg.recencyHalfLifeDays}d, weight ${cfg.recencyWeight}`);
  }
  console.log(`thinking:  ${cfg.includeThinking ? "included" : "excluded"}`);
  console.log(
    `brief:     ${cfg.brief ?? "daily"} (session-start insights brief)` +
      `${cfg.repoScopedBrief === false ? ", all repos" : ", current repo only (repoScopedBrief=false to widen)"}`,
  );
  console.log(
    `projects:  ${cfg.repos && cfg.repos.length > 0 ? cfg.repos.join(", ") : "ALL (no git-project filter)"}`,
  );
  console.log(
    `ask scope: ${cfg.repoScopedAsk === false ? "all repos" : "current repo only (--all-repos / repoScopedAsk=false to widen)"}`,
  );
  const tracked = existsSync(OFFSETS_DIR)
    ? readdirSync(OFFSETS_DIR).filter((f) => f.endsWith(".json")).length
    : 0;
  console.log(`captured:  ${tracked} sessions tracked locally`);
  if (isIncognito()) {
    const since = incognitoSince();
    const env = process.env.OH_INCOGNITO && process.env.OH_INCOGNITO !== "0" ? " (OH_INCOGNITO env)" : "";
    console.log(`recording: 🔒 INCOGNITO — not recording${since ? ` since ${since}` : ""}${env} (\`oh resume\` to re-enable)`);
  } else {
    console.log(`recording: ● on (\`oh pause\` for incognito)`);
  }
  try {
    const { db } = makeClients(cfg);
    if (cfg.insightsOnly) {
      // No chunks, no asks — just the metrics rows we count usage from.
      const rows = await db.fetchMetrics({ author: cfg.author });
      console.log(`metrics:   ${rows.length} exchanges counted (token/time)`);
    } else {
      console.log(`team brain: ${await db.chunkCount()} chunks`);
      try {
        const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
        const s = await db.askStats(week);
        console.log(
          `asks (7d):  ${s.total} asked, ${s.answered} answered — ${s.answered} interruption${s.answered === 1 ? "" : "s"} deflected`,
        );
      } catch {
        console.log("asks (7d):  unavailable (apply migrations/0003_asks.sql once)");
      }
    }
  } catch (err) {
    console.error(`team brain: unavailable — ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        file: { type: "string" },
        tool: { type: "string" },
        all: { type: "boolean" },
        force: { type: "boolean" },
        since: { type: "string" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        author: { type: "string" },
        "supabase-url": { type: "string" },
        "supabase-key": { type: "string" },
        "openai-key": { type: "string" },
        "no-wire": { type: "boolean" },
        local: { type: "boolean" },
        "insights-only": { type: "boolean" },
        repos: { type: "string" },
        who: { type: "string" },
        repo: { type: "string" },
        "all-repos": { type: "boolean" },
        email: { type: "string" },
        history: { type: "boolean" },
      },
    });
  } catch (err) {
    // Most commonly this fires when someone on an older release passes a flag
    // that didn't exist yet (e.g. `oh init --local` on a build before local
    // mode shipped). Node's raw "Unknown option" message sends people chasing
    // a bug that's really just a stale install — point them at the update.
    if ((err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      console.error(`oh: ${(err as Error).message}`);
      console.error(
        "\nIf you expected this flag to work, your installed Oh is out of date.\n" +
          "Update it:  npm i -g oh-brain@latest",
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const { values, positionals } = parsed;

  const cmd = positionals[0] ?? (values.help ? "help" : "");
  const tool = asTool(values.tool);
  if (values.tool && !tool) throw new Error(`--tool must be "claude", "codex", or "copilot"`);

  switch (cmd) {
    case "signup":
      await cmdSignup({ email: values.email });
      break;
    case "login":
      await cmdLogin({ email: values.email });
      break;
    case "team":
      await cmdTeam(positionals[1], positionals.slice(2).join(" ") || undefined, values.author);
      break;
    case "init":
      await cmdInit({
        author: values.author,
        supabaseUrl: values["supabase-url"],
        supabaseKey: values["supabase-key"],
        openaiKey: values["openai-key"],
        yes: Boolean(values.yes),
        noWire: Boolean(values["no-wire"]),
        local: Boolean(values.local),
        insightsOnly: Boolean(values["insights-only"]),
        repos: values.repos
          ? values.repos.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      });
      break;
    case "migrate":
      cmdMigrate();
      break;
    case "backfill":
      await cmdBackfill(values.since, Boolean(values.force));
      break;
    case "ask":
      await cmdAsk(positionals.slice(1).join(" "), {
        who: values.who,
        repo: values.repo,
        since: values.since,
        allRepos: Boolean(values["all-repos"]),
      });
      break;
    case "insights":
      await cmdInsights({ since: values.since, repo: values.repo, history: values.history });
      break;
    case "statusline":
      cmdStatusline();
      break;
    case "capture":
      await cmdCapture({ file: values.file, all: values.all, tool, since: values.since });
      break;
    case "mcp":
      await runMcpServer(CLI_PATH);
      break;
    case "hook":
      await runHook(tool ?? "claude", CLI_PATH);
      break;
    case "pause":
      cmdIncognito(true);
      break;
    case "resume":
      cmdIncognito(false);
      break;
    case "status":
      await cmdStatus();
      break;
    case "help":
    case "":
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`oh: ${(err as Error).message}`);
  log("cli", `fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exitCode = 1;
});
