// Stdio MCP server exposing the single tool `ask`. Thin by design: it returns
// ranked, cited excerpts and the calling agent synthesizes the answer (no LLM
// key lives here). The tool description is load-bearing — it tells the agent
// how to use the excerpts (cite, prefer recent, admit when empty).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createEmbedder } from "./embed.js";
import { ask, formatAskResult } from "./ask.js";
import { log } from "./log.js";

const ASK_DESCRIPTION = `Query the team's shared memory (Oh) — past AI-coding Sessions across Claude and Codex — to answer "why is this code/plan the way it is?" without interrupting the author. Returns ranked, cited excerpts of teammates' (and your own) reasoning.

How to use the results:
- Answer ONLY from the returned excerpts. Do not invent reasons that aren't there.
- On conflict, PREFER THE MOST RECENT excerpt — a later Session may have reversed an earlier decision. Each excerpt carries a timestamp; "Most recent relevant context" is called out at the top.
- ALWAYS cite who + session + when for each claim you make.
- If results are empty or weak, say "no relevant context found" rather than guessing.

Use this instead of asking a teammate to re-explain. Optional filters narrow the search: who (a teammate's name), repo (working-dir basename), since (ISO date or a window like "7d"/"30d").`;

export async function runMcpServer(): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg);
  const embedder = createEmbedder(cfg);

  const server = new McpServer({ name: "oh", version: "0.0.1" });

  server.registerTool(
    "ask",
    {
      title: "Ask the team's shared memory",
      description: ASK_DESCRIPTION,
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
        const result = await ask(cfg, db, embedder, args);
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
