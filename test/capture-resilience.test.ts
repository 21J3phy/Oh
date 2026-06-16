import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaude } from "../src/parse/claude.js";
import { toExchanges } from "../src/normalize.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * Find the newest real Claude session that actually parses into ≥1 exchange,
 * so the capture below reaches the network-write path (an empty session would
 * short-circuit before it). Returns null when there's nothing local to use —
 * same skip idiom as parse.test.ts.
 */
function newestNonEmptyClaudeSession(): string | null {
  const root = join(homedir(), ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return null;
  }
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl")) continue;
    const path = join(root, rel);
    try {
      candidates.push({ path, mtime: statSync(path).mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, 25)) {
    try {
      const parsed = parseClaude(readFileSync(c.path, "utf8"));
      if (toExchanges(parsed, { author: "tester" }).length > 0) return c.path;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

test("capture survives an unreachable backend: no crash, offset un-advanced, retry preserved", () => {
  const session = newestNonEmptyClaudeSession();
  if (!session) return; // no local Claude sessions — skip (matches parse.test.ts)

  // A throwaway HOME so capture's ~/.oh writes (offsets, logs, last-session)
  // land in a temp dir and the real config is never read or touched.
  const home = mkdtempSync(join(tmpdir(), "oh-cap-"));
  const ohDir = join(home, ".oh");
  mkdirSync(ohDir, { recursive: true });
  // Self-host mode pointed at a port that refuses instantly: upsertSession's
  // first network write fails fast, exercising the hardened catch — without
  // any real credentials. The dummy openaiKey is never used (the session
  // write throws before any embedding call).
  writeFileSync(
    join(ohDir, "config.json"),
    JSON.stringify({
      author: "tester",
      supabaseUrl: "http://127.0.0.1:1",
      supabaseKey: "dummy-key",
      openaiKey: "sk-dummy",
      includeThinking: false,
    }),
  );

  const res = spawnSync(process.execPath, [CLI, "capture", "--file", session, "--tool", "claude"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OH_INCOGNITO: "0" },
    encoding: "utf8",
    timeout: 60_000,
  });

  // 1. The regression: a dead backend must not crash capture. Before the fix
  //    the thrown upsertSession propagated to main() → exitCode 1.
  assert.equal(res.status, 0, `capture should exit cleanly; stderr:\n${res.stderr}`);

  // 2. The new branch actually ran (not some unrelated failure): the graceful
  //    skip is logged and mirrored to stderr.
  assert.match(
    res.stderr,
    /session\/chunks not persisted/,
    `expected the graceful remote-failure log; got:\n${res.stderr}`,
  );

  // 3. Retry is preserved: with the remote write unlanded, the processed-offset
  //    must NOT be advanced — otherwise the next sweep would skip these
  //    exchanges forever. No offset state file should have been written.
  const offsetsDir = join(ohDir, "offsets");
  const offsetFiles = existsSync(offsetsDir)
    ? readdirSync(offsetsDir).filter((f) => f.endsWith(".json"))
    : [];
  assert.equal(offsetFiles.length, 0, `offset must stay un-advanced; found: ${offsetFiles.join(", ")}`);
});
