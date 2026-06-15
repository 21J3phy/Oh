import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// Exercises the real stdio MCP path: spawn `oh mcp` with a throwaway HOME (so
// it loads a dummy config, no network), connect a client, list tools. Skips if
// the package hasn't been built yet.
test(
  "MCP server advertises the ask tool over stdio",
  { skip: existsSync(DIST_CLI) ? false : "run `npm run build` first" },
  async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const home = mkdtempSync(join(tmpdir(), "oh-mcp-"));
    mkdirSync(join(home, ".oh"), { recursive: true });
    writeFileSync(
      join(home, ".oh", "config.json"),
      JSON.stringify({
        author: "tester",
        supabaseUrl: "https://example.supabase.co",
        supabaseKey: "dummy",
        openaiKey: "dummy",
      }),
    );

    // Run the server with its cwd inside a repo named "myproj" — repo scoping
    // (on by default) should pin the ask tool to that repo.
    const projDir = join(home, "myproj");
    mkdirSync(projDir, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, "mcp"],
      cwd: projDir,
      env: { ...process.env, HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "oh-test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const ask = tools.find((t) => t.name === "ask");
      assert.ok(ask, "ask tool is advertised");
      assert.match(ask!.description ?? "", /most recent/i, "description carries the recency rule");
      assert.match(ask!.description ?? "", /cite/i, "description tells the agent to cite");
      assert.match(ask!.description ?? "", /current repo \("myproj"\)/, "scoped to the server's repo");
      const props = (ask!.inputSchema as any)?.properties ?? {};
      assert.ok(props.question, "ask takes a question");
      assert.ok(props.who && props.repo && props.since, "ask exposes who/repo/since filters");
    } finally {
      await client.close();
    }
  },
);

test(
  "MCP server: repoScopedAsk=false leaves ask unscoped",
  { skip: existsSync(DIST_CLI) ? false : "run `npm run build` first" },
  async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const home = mkdtempSync(join(tmpdir(), "oh-mcp-noscope-"));
    mkdirSync(join(home, ".oh"), { recursive: true });
    writeFileSync(
      join(home, ".oh", "config.json"),
      JSON.stringify({
        author: "tester",
        supabaseUrl: "https://example.supabase.co",
        supabaseKey: "dummy",
        openaiKey: "dummy",
        repoScopedAsk: false,
      }),
    );
    const projDir = join(home, "myproj");
    mkdirSync(projDir, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, "mcp"],
      cwd: projDir,
      env: { ...process.env, HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "oh-test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const ask = tools.find((t) => t.name === "ask");
      assert.ok(ask, "ask tool is advertised");
      assert.doesNotMatch(ask!.description ?? "", /current repo/, "no scope note when disabled");
    } finally {
      await client.close();
    }
  },
);
