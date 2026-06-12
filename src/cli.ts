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
  OFFSETS_DIR,
  SCHEMA_OUT_PATH,
  ensureDirs,
  loadConfig,
  readPartialConfig,
  saveConfig,
} from "./config.js";
import { SCHEMA_SQL } from "./schema.js";
import { createDb } from "./db.js";
import { createEmbedder } from "./embed.js";
import { captureAll, captureFile } from "./capture.js";
import { ask, formatAskResult, parseSince } from "./ask.js";
import { computeInsights, formatInsights } from "./insights.js";
import { refreshInsightsCache } from "./brief.js";
import { runMcpServer } from "./mcp.js";
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

/** Hook + MCP registration plus the ask-why skill, installed for both agents. */
function wire(apply: boolean) {
  const parts = [
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
  return v === "claude" || v === "codex" ? v : undefined;
}

function inferTool(file: string): Tool {
  return /[/\\]\.codex[/\\]/.test(file) ? "codex" : "claude";
}

function sinceMsFrom(s: string | undefined): number | null {
  const iso = parseSince(s);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const USAGE = `Oh — give your AI a past.

Hosted (no keys — ADR 0010):
  oh signup [--email E]   Create your hosted Oh account (then confirm via email).
  oh login [--email E]    Log in; stores your session in ~/.oh.
  oh team create "<name>" Create a team; prints the invite code for teammates.
  oh team join <code>     Join a team by invite code.
  oh team                 Show your team + invite code.
  (then) oh init --yes    Wire Claude+Codex hooks/MCP/skill, and oh backfill.

Self-host (your own Supabase + OpenAI keys):
  oh init [flags]         Configure ~/.oh, write the schema, wire Claude+Codex
                          (hooks + ask MCP server + ask-why skill). Run with no
                          flags to be prompted, or non-interactively with:
                          --author --supabase-url --supabase-key --openai-key --yes
                          (--no-wire skips editing tool configs; --repos "name"
                          limits capture to one or more git projects).
  oh migrate              (Re)write the schema SQL to paste into Supabase.
  oh backfill [--since W] Seed the store from your existing Claude+Codex sessions.
  oh ask "<question>"     Query the store from the terminal (--who --repo --since W).
  oh insights             Your last 7 days of vibecoding: time anatomy, tokens,
                          friction, fun stats (--since W, --repo R). Always
                          your own sessions — Insights are individual-only.
  oh status               Show config + how much is in the Team Brain.

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
}

function printInitNextSteps(): void {
  console.log("\nNext:");
  console.log("  1. Ensure the schema is applied once in Supabase (SQL editor → paste ~/.oh/schema.sql → Run).");
  console.log("  2. `oh backfill` to seed the store from your existing sessions.");
  console.log("  3. Restart Claude/Codex to load the MCP server + hooks + skill.");
  console.log('  4. Use the `ask` tool from either: "why did we …?"');
}

async function cmdInit(opts: InitOpts): Promise<void> {
  ensureDirs();
  const existing = readPartialConfig();
  const interactive = process.stdin.isTTY === true;

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
    console.log("\nPlanned wiring (capture hooks + `ask` MCP server + ask-why skill, Claude & Codex):");
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

async function cmdBackfill(since: string | undefined): Promise<void> {
  const cfg = loadConfig();
  const { db, embedder } = makeClients(cfg);
  const sinceMs = sinceMsFrom(since);
  console.log(
    `Backfilling as "${cfg.author}"${sinceMs ? ` since ${new Date(sinceMs).toISOString()}` : ""} …`,
  );
  const r = await captureAll(cfg, db, embedder, { sinceMs });
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
    const r = await captureFile(opts.file, tool, cfg, db, embedder);
    log("capture", `file ${opts.file}: +${r.embedded} chunks (skipped=${r.skipped})`);
    try {
      await refreshInsightsCache(cfg, db); // keep the session-start brief warm
    } catch (err) {
      log("capture", `insights cache refresh skipped — ${(err as Error).message}`);
    }
    if (process.stdout.isTTY) {
      console.log(`${tool} ${r.sessionId ?? "?"}: +${r.embedded} chunks (skipped=${r.skipped}).`);
    }
    return;
  }
  throw new Error("capture needs --file <path> or --all");
}

async function cmdAsk(
  question: string,
  opts: { who?: string; repo?: string; since?: string },
): Promise<void> {
  if (!question.trim()) throw new Error('ask needs a question, e.g. oh ask "why did we choose X?"');
  const cfg = loadConfig();
  const { db, embedder } = makeClients(cfg);
  const result = await ask(cfg, db, embedder, {
    question,
    who: opts.who,
    repo: opts.repo,
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

async function cmdInsights(opts: { since?: string; repo?: string }): Promise<void> {
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
  console.log(formatInsights(computeInsights(rows, { author, sinceIso })));
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  let host = cfg.supabaseUrl ?? "";
  try {
    host = new URL(cfg.supabaseUrl).host;
  } catch {
    /* keep raw */
  }
  console.log(`author:    ${cfg.author}`);
  if (cfg.mode === "hosted") {
    console.log(`mode:      hosted (${cfg.hosted?.email ?? "?"})`);
    console.log(`team:      ${cfg.hosted?.teamId ?? "none"} (invite: ${cfg.hosted?.inviteCode ?? "—"})`);
  } else {
    console.log(`mode:      self-host`);
    console.log(`supabase:  ${host}`);
  }
  console.log(`model:     ${cfg.embeddingModel}`);
  console.log(`thinking:  ${cfg.includeThinking ? "included" : "excluded"}`);
  console.log(`recency:   half-life ${cfg.recencyHalfLifeDays}d, weight ${cfg.recencyWeight}`);
  console.log(`brief:     ${cfg.brief ?? "daily"} (session-start insights brief)`);
  console.log(
    `projects:  ${cfg.repos && cfg.repos.length > 0 ? cfg.repos.join(", ") : "ALL (no git-project filter)"}`,
  );
  const tracked = existsSync(OFFSETS_DIR)
    ? readdirSync(OFFSETS_DIR).filter((f) => f.endsWith(".json")).length
    : 0;
  console.log(`captured:  ${tracked} sessions tracked locally`);
  try {
    const { db } = makeClients(cfg);
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
  } catch (err) {
    console.error(`team brain: unavailable — ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string" },
      tool: { type: "string" },
      all: { type: "boolean" },
      since: { type: "string" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      author: { type: "string" },
      "supabase-url": { type: "string" },
      "supabase-key": { type: "string" },
      "openai-key": { type: "string" },
      "no-wire": { type: "boolean" },
      repos: { type: "string" },
      who: { type: "string" },
      repo: { type: "string" },
      email: { type: "string" },
    },
  });

  const cmd = positionals[0] ?? (values.help ? "help" : "");
  const tool = asTool(values.tool);
  if (values.tool && !tool) throw new Error(`--tool must be "claude" or "codex"`);

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
        repos: values.repos
          ? values.repos.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      });
      break;
    case "migrate":
      cmdMigrate();
      break;
    case "backfill":
      await cmdBackfill(values.since);
      break;
    case "ask":
      await cmdAsk(positionals.slice(1).join(" "), {
        who: values.who,
        repo: values.repo,
        since: values.since,
      });
      break;
    case "insights":
      await cmdInsights({ since: values.since, repo: values.repo });
      break;
    case "capture":
      await cmdCapture({ file: values.file, all: values.all, tool, since: values.since });
      break;
    case "mcp":
      await runMcpServer();
      break;
    case "hook":
      await runHook(tool ?? "claude", CLI_PATH);
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
