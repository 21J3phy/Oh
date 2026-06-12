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
import { runMcpServer } from "./mcp.js";
import { runHook } from "./hook.js";
import { registerAll, installSkill } from "./register.js";
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

const USAGE = `Oh — shared memory for AI-coding teams.

Usage:
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
  let host = cfg.supabaseUrl;
  try {
    host = new URL(cfg.supabaseUrl).host;
  } catch {
    /* keep raw */
  }
  console.log(`author:    ${cfg.author}`);
  console.log(`supabase:  ${host}`);
  console.log(`model:     ${cfg.embeddingModel}`);
  console.log(`thinking:  ${cfg.includeThinking ? "included" : "excluded"}`);
  console.log(`recency:   half-life ${cfg.recencyHalfLifeDays}d, weight ${cfg.recencyWeight}`);
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
    },
  });

  const cmd = positionals[0] ?? (values.help ? "help" : "");
  const tool = asTool(values.tool);
  if (values.tool && !tool) throw new Error(`--tool must be "claude" or "codex"`);

  switch (cmd) {
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
