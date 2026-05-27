import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseClaude } from "../src/parse/claude.js";
import { parseCodex } from "../src/parse/codex.js";
import { toExchanges } from "../src/normalize.js";
import type { ParseResult } from "../src/types.js";

function newestJsonl(root: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return null;
  }
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl")) continue;
    const path = join(root, rel);
    let m: number;
    try {
      m = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (!best || m > best.mtime) best = { path, mtime: m };
  }
  return best?.path ?? null;
}

function assertExchangesWellFormed(parsed: ParseResult) {
  assert.ok(parsed.sessionId, "should recover a sessionId from the file");
  const exchanges = toExchanges(parsed, { author: "tester" });
  assert.ok(exchanges.length > 0, "should produce at least one exchange");

  // indices are contiguous from 0
  exchanges.forEach((ex, i) => assert.equal(ex.index, i, "indices contiguous from 0"));

  // timestamps are valid and non-decreasing
  let prev = -Infinity;
  for (const ex of exchanges) {
    const t = Date.parse(ex.ts);
    assert.ok(!Number.isNaN(t), `ts is a valid date: ${ex.ts}`);
    assert.ok(t >= prev, "exchange timestamps are non-decreasing");
    prev = t;
  }

  // tool summaries are genuinely one-liners
  for (const ex of exchanges) {
    for (const s of ex.toolSummaries) {
      assert.ok(!s.includes("\n"), "tool summary is a single line");
      assert.ok(s.length <= 160, "tool summary is short");
    }
  }

  // at least one exchange carries a human prompt
  assert.ok(
    exchanges.some((ex) => ex.reasoningText.startsWith("User:")),
    "at least one exchange opens with a human prompt",
  );

  // raw tool_result JSON never leaks into reasoning text
  for (const ex of exchanges) {
    assert.ok(!ex.reasoningText.includes("tool_use_id"), "no raw tool_result blocks");
  }

  return exchanges;
}

test("parses a real Claude session into clean exchanges", () => {
  const path = newestJsonl(join(homedir(), ".claude", "projects"));
  if (!path) return; // no local sessions — skip
  const parsed = parseClaude(readFileSync(path, "utf8"));
  const exchanges = assertExchangesWellFormed(parsed);
  for (const ex of exchanges) assert.equal(ex.tool, "claude");
});

test("parses a real Codex session into clean exchanges (no raw exec output)", () => {
  const path = newestJsonl(join(homedir(), ".codex", "sessions"));
  if (!path) return; // no local sessions — skip
  const parsed = parseCodex(readFileSync(path, "utf8"));
  const exchanges = assertExchangesWellFormed(parsed);
  for (const ex of exchanges) {
    assert.equal(ex.tool, "codex");
    // "Process exited with code" only appears in raw function_call_output,
    // so its absence proves we dropped raw tool output.
    assert.ok(
      !ex.reasoningText.includes("Process exited with code"),
      "raw exec output is dropped",
    );
  }
});
