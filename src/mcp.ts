// Stdio MCP server exposing the single tool `ask`. Thin by design: it returns
// ranked, cited excerpts and the calling agent synthesizes the answer (no LLM
// key lives here). The tool description is load-bearing — it tells the agent
// how to use the excerpts (cite, prefer recent, admit when empty).

import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createEmbedder } from "./embed.js";
import { ask, formatAskResult } from "./ask.js";
import { gitRepoIdentity } from "./capture.js";
import { shortRepo } from "./normalize.js";
import { log } from "./log.js";

const ASK_DESCRIPTION = `Query Oh — the verbatim memory of all past AI-coding Sessions, the user's own AND their teammates', across Claude and Codex. Unlike summarized agent memory, it returns the exact original reasoning: ranked, cited excerpts with quotes and code. Use it (a) to recall the user's own earlier work — "what was my plan for X?", "how did I fix Y last time?" — and (b) to answer "why is this code/plan the way it is?" without interrupting the author.

How to use the results:
- Answer ONLY from the returned excerpts. Do not invent reasons that aren't there.
- On conflict, PREFER THE MOST RECENT excerpt — a later Session may have reversed an earlier decision. Each excerpt carries a timestamp; "Most recent relevant context" is called out at the top.
- ALWAYS cite who + session + when for each claim you make.
- If results are empty or weak, say "no relevant context found" rather than guessing.

Use this instead of re-deriving context or asking a teammate to re-explain. Optional filters narrow the search: who (a person's name — including the user's own, for self-recall), repo (working-dir basename), since (ISO date or a window like "7d"/"30d").`;

/**
 * Copilot CLI has no Stop/SessionStart hook (unlike Claude/Codex), so a
 * Copilot-only dev would never auto-capture. The MCP server is the one process
 * Copilot launches that we control, so on startup we kick a DETACHED Copilot
 * sweep: it captures the previous Copilot session(s) and any prior unswept ones.
 * Cheap — capture short-circuits unchanged files via offsets and respects
 * incognito. Never blocks or breaks the server. Harmless when launched by
 * Claude/Codex too (they also sweep Copilot via their own hooks).
 */
function kickCopilotCapture(cliPath: string): void {
  try {
    const child = spawn(process.execPath, [cliPath, "capture", "--all", "--tool", "copilot", "--since", "2d"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log("mcp", "kicked detached copilot capture sweep on startup");
  } catch (err) {
    log("mcp", `copilot capture kick failed — ${(err as Error).message}`);
  }
}

export async function runMcpServer(cliPath?: string): Promise<void> {
  const cfg = loadConfig();
  if (cfg.insightsOnly) {
    // Insights-only installs never register this server (ADR 0014); if one is
    // launched anyway, refuse rather than advertise an `ask` we can't answer.
    throw new Error("Oh is in insights-only mode — the `ask` MCP server is disabled. Run `oh init --local` for memory + ask.");
  }
  const db = createDb(cfg);
  const embedder = createEmbedder(cfg);
  if (cliPath) kickCopilotCapture(cliPath);

  // Repo isolation (default on): the server runs with the agent's working dir as
  // its cwd, so we pin every query to that git repo and an agent can't read
  // another project's memory. `gitRepoIdentity` is the same value stored on each
  // chunk (the git remote, or a basename fallback for non-git dirs).
  const scopedRepo =
    cfg.repoScopedAsk === false ? null : gitRepoIdentity(process.cwd());
  if (scopedRepo && scopedRepo !== "unknown") {
    log("mcp", `ask scoped to repo "${scopedRepo}" (repoScopedAsk)`);
  }

  const server = new McpServer({ name: "oh", version: "0.0.1" });

  server.registerTool(
    "ask",
    {
      title: "Ask Oh — verbatim memory of your and your team's sessions",
      description:
        scopedRepo && scopedRepo !== "unknown"
          ? `${ASK_DESCRIPTION}\n\nScope: results are limited to the current repo ("${shortRepo(scopedRepo)}") — the \`repo\` filter is ignored. If nothing is found, say so rather than reaching into other repos.`
          : ASK_DESCRIPTION,
      inputSchema: {
        question: z
          .string()
          .describe("What you want to know, e.g. 'why did we switch from REST to gRPC?'"),
        who: z.string().optional().describe("Filter to a teammate's Sessions by name."),
        repo: z.string().optional().describe("Filter to a repo (basename of the working dir)."),
        since: z
          .string()
          .optional()
          .describe("Only consider Sessions since an ISO date or a window like '7d' / '30d'."),
      },
    },
    async (args) => {
      try {
        // Force the current-repo scope when enabled — the model can't widen it.
        const params =
          scopedRepo && scopedRepo !== "unknown" ? { ...args, repo: scopedRepo } : args;
        const result = await ask(cfg, db, embedder, params);
        log("mcp", `ask ${JSON.stringify(args.question).slice(0, 80)} -> ${result.hits.length} hits`);
        return { content: [{ type: "text" as const, text: formatAskResult(result) }] };
      } catch (err) {
        const message = (err as Error).message;
        log("mcp", `ask error: ${message}`, true);
        return {
          content: [{ type: "text" as const, text: `Oh: ask failed — ${message}` }],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
  log("mcp", "oh MCP server ready (ask)");
}
