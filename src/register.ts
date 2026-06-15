// Register Oh's capture hooks + the `ask` MCP server in Claude and Codex, and
// the `ask` MCP server in Copilot CLI (which has no hook system — see
// registerCopilot / mcp.ts for how Copilot capture is triggered instead).
//
// Both tools share the same hook-config schema (hooks.<Event> = [{ hooks:
// [{ type:"command", command }] }]), so one code path merges into both. We
// MERGE (never overwrite) so existing hooks survive, back up every file we
// touch, and stay idempotent via a marker in our hook command.
//
// Paths are injectable so this is testable against temp files — it never has
// to touch the real ~/.claude or ~/.codex during tests.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Tool } from "./types.js";

export interface RegisterPaths {
  claudeSettings: string;
  claudeJson: string;
  codexHooks: string;
  codexConfig: string;
  copilotMcp: string;
}

export function defaultPaths(): RegisterPaths {
  const h = homedir();
  return {
    claudeSettings: join(h, ".claude", "settings.json"),
    claudeJson: join(h, ".claude.json"),
    codexHooks: join(h, ".codex", "hooks.json"),
    codexConfig: join(h, ".codex", "config.toml"),
    copilotMcp: join(h, ".copilot", "mcp-config.json"),
  };
}

const HOOK_MARKER = "OH_HOOK=1";

export function hookCommand(node: string, cli: string, tool: Tool): string {
  return `${HOOK_MARKER} "${node}" "${cli}" hook --tool ${tool}`;
}

export interface RegisterResult {
  changed: string[];
  skipped: string[];
  backups: string[];
  notes: string[];
}

function emptyResult(): RegisterResult {
  return { changed: [], skipped: [], backups: [], notes: [] };
}

function readJson(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function backup(path: string, into: RegisterResult): void {
  if (!existsSync(path)) return;
  const b = `${path}.oh-backup-${Date.now()}`;
  copyFileSync(path, b);
  into.backups.push(b);
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildOhTomlBlock(node: string, cli: string): string {
  return (
    `[mcp_servers.oh]\n` +
    `command = "${tomlEscape(node)}"\n` +
    `args = ["${tomlEscape(cli)}", "mcp"]\n` +
    `startup_timeout_sec = 60\n`
  );
}

/**
 * Add or path-correct the [mcp_servers.oh] block in a config.toml's text,
 * preserving the rest of the file. If the block exists but points elsewhere
 * (e.g. an old install path), it's replaced.
 */
export function upsertCodexMcp(
  text: string,
  node: string,
  cli: string,
): { text: string; changed: boolean } {
  const desired = buildOhTomlBlock(node, cli);
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[mcp_servers\.oh\]\s*$/.test(lines[i]!)) {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\[/.test(lines[j]!)) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start === -1) {
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    return { text: `${text}${sep}\n${desired}`, changed: true };
  }
  if (lines.slice(start, end).join("\n").includes(cli)) {
    return { text, changed: false }; // already current
  }
  const rebuilt = [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  const sep = rebuilt.endsWith("\n") ? "" : "\n";
  return { text: `${rebuilt}${sep}\n${desired}`, changed: true };
}

/**
 * Ensure exactly our command hook is under config.hooks[event]. Drops any stale
 * Oh hooks (e.g. one pointing at an old install path) and adds the current one.
 * Returns true if anything changed — so re-running after moving the install
 * corrects the path, while a no-op re-run reports no change.
 */
function addHookToConfig(config: any, event: string, command: string): boolean {
  config.hooks ??= {};
  config.hooks[event] ??= [];
  const groups = config.hooks[event] as Array<{
    hooks?: Array<{ type?: string; command?: string }>;
  }>;
  let changed = false;
  let hasExact = false;
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter((h) => {
      if (typeof h.command === "string" && h.command.includes(HOOK_MARKER)) {
        if (h.command === command) {
          hasExact = true;
          return true; // ours, already correct — keep
        }
        return false; // stale Oh hook (old path) — drop
      }
      return true; // someone else's hook — keep
    });
    if (group.hooks.length !== before) changed = true;
  }
  // Remove any groups our pruning left empty.
  config.hooks[event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
  if (!hasExact) {
    config.hooks[event].push({ hooks: [{ type: "command", command }] });
    changed = true;
  }
  return changed;
}

/** Register Claude: Stop+SessionEnd capture hooks and the `ask` MCP server.
 *  `insightsOnly` (ADR 0014) wires capture + statusline only — no `ask` MCP. */
export function registerClaude(
  node: string,
  cli: string,
  apply: boolean,
  paths: RegisterPaths = defaultPaths(),
  insightsOnly = false,
): RegisterResult {
  const result = emptyResult();
  const cmd = hookCommand(node, cli, "claude");

  // --- hooks (settings.json) ---
  // Stop/SessionEnd capture the session; SessionStart shows the daily brief
  // (same entrypoint — it branches on the payload's hook_event_name).
  const settings = readJson(paths.claudeSettings);
  const addedStop = addHookToConfig(settings, "Stop", cmd);
  const addedEnd = addHookToConfig(settings, "SessionEnd", cmd);
  const addedStart = addHookToConfig(settings, "SessionStart", cmd);
  if (addedStop || addedEnd || addedStart) {
    if (apply) {
      backup(paths.claudeSettings, result);
      writeJson(paths.claudeSettings, settings);
    }
    result.changed.push(`${paths.claudeSettings} (hooks: Stop/SessionEnd/SessionStart)`);
  } else {
    result.skipped.push(`${paths.claudeSettings} (hooks already present)`);
  }

  // --- statusline (settings.json) — visible before the first message ---
  // Respect an existing statusline: only install ours when none is set, or
  // when an older Oh install path needs correcting.
  const desiredStatus = { type: "command", command: `"${node}" "${cli}" statusline` };
  const cur = settings.statusLine as { command?: string } | undefined;
  const isOurs = typeof cur?.command === "string" && cur.command.endsWith(" statusline");
  if (!cur || (isOurs && cur.command !== desiredStatus.command)) {
    settings.statusLine = desiredStatus;
    if (apply) {
      backup(paths.claudeSettings, result);
      writeJson(paths.claudeSettings, settings);
    }
    result.changed.push(`${paths.claudeSettings} (statusLine → oh statusline)`);
  } else if (!isOurs) {
    result.skipped.push(`${paths.claudeSettings} (statusLine: kept your existing one)`);
  } else {
    result.skipped.push(`${paths.claudeSettings} (statusLine already current)`);
  }

  // --- MCP server (~/.claude.json) — the `ask` front door; skipped insights-only ---
  if (insightsOnly) {
    result.skipped.push(`${paths.claudeJson} (mcpServers.oh — insights-only, no ask)`);
    return result;
  }
  const claudeJson = readJson(paths.claudeJson);
  claudeJson.mcpServers ??= {};
  const desired = { command: node, args: [cli, "mcp"] };
  const current = claudeJson.mcpServers.oh;
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    claudeJson.mcpServers.oh = desired;
    if (apply) {
      backup(paths.claudeJson, result);
      writeJson(paths.claudeJson, claudeJson);
    }
    result.changed.push(`${paths.claudeJson} (mcpServers.oh)`);
  } else {
    result.skipped.push(`${paths.claudeJson} (mcpServers.oh already set)`);
  }

  return result;
}

/** Register Codex: Stop capture hook and the `ask` MCP server.
 *  `insightsOnly` (ADR 0014) wires the capture hook only — no `ask` MCP. */
export function registerCodex(
  node: string,
  cli: string,
  apply: boolean,
  paths: RegisterPaths = defaultPaths(),
  insightsOnly = false,
): RegisterResult {
  const result = emptyResult();
  const cmd = hookCommand(node, cli, "codex");

  // --- hooks (hooks.json) ---
  // Codex (≥0.13x) mirrors Claude's hook contract: stdin JSON payload with
  // hook_event_name/session_id/transcript_path, systemMessage output rendered
  // to the user. Stop captures; SessionStart shows the daily brief.
  const hooks = readJson(paths.codexHooks);
  const addedStop = addHookToConfig(hooks, "Stop", cmd);
  const addedStart = addHookToConfig(hooks, "SessionStart", cmd);
  if (addedStop || addedStart) {
    if (apply) {
      backup(paths.codexHooks, result);
      writeJson(paths.codexHooks, hooks);
    }
    result.changed.push(`${paths.codexHooks} (hooks: Stop/SessionStart)`);
    result.notes.push(
      "Codex may ask you to trust the new hook on its next run (hook-trust prompt).",
    );
  } else {
    result.skipped.push(`${paths.codexHooks} (hooks already present)`);
  }

  // --- MCP server (config.toml) — the `ask` front door; skipped insights-only ---
  if (insightsOnly) {
    result.skipped.push(`${paths.codexConfig} ([mcp_servers.oh] — insights-only, no ask)`);
    return result;
  }
  const configText = existsSync(paths.codexConfig)
    ? readFileSync(paths.codexConfig, "utf8")
    : "";
  const upsert = upsertCodexMcp(configText, node, cli);
  if (upsert.changed) {
    if (apply) {
      backup(paths.codexConfig, result);
      mkdirSync(dirname(paths.codexConfig), { recursive: true });
      writeFileSync(paths.codexConfig, upsert.text);
    }
    result.changed.push(`${paths.codexConfig} ([mcp_servers.oh])`);
  } else {
    result.skipped.push(`${paths.codexConfig} ([mcp_servers.oh] already current)`);
  }

  return result;
}

/**
 * Register Copilot: the `ask` MCP server in ~/.copilot/mcp-config.json.
 *
 * Copilot CLI is a first-class CONSUMER through MCP (it has no Claude/Codex-style
 * Stop/SessionStart hook system, and no skills dir — so there's no hook or skill
 * to install here). Capture for Copilot-only devs is instead kicked from the MCP
 * server's own startup (see mcp.ts), the one Copilot-launched process we own.
 * Config shape matches `copilot mcp add` (stdio/local server). Merge-preserving.
 */
export function registerCopilot(
  node: string,
  cli: string,
  apply: boolean,
  paths: RegisterPaths = defaultPaths(),
): RegisterResult {
  const result = emptyResult();
  const conf = readJson(paths.copilotMcp);
  conf.mcpServers ??= {};
  const desired = { type: "local", command: node, args: [cli, "mcp"], tools: ["*"] };
  const current = conf.mcpServers.oh;
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    conf.mcpServers.oh = desired;
    if (apply) {
      backup(paths.copilotMcp, result);
      writeJson(paths.copilotMcp, conf);
    }
    result.changed.push(`${paths.copilotMcp} (mcpServers.oh)`);
  } else {
    result.skipped.push(`${paths.copilotMcp} (mcpServers.oh already set)`);
  }
  return result;
}

/**
 * Install the `ask-why` Claude skill (the proactive front-door) into the user's
 * skills dir. Idempotent: rewrites only when the content differs, backing up any
 * existing file first.
 */
export function installSkill(
  sourceFile: string,
  skillsDir: string,
  apply: boolean,
): RegisterResult {
  const result = emptyResult();
  const dest = join(skillsDir, "ask-why", "SKILL.md");
  if (!existsSync(sourceFile)) {
    result.notes.push(`ask-why skill source not found (${sourceFile}) — skipped`);
    return result;
  }
  const desired = readFileSync(sourceFile, "utf8");
  const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (current === desired) {
    result.skipped.push(`${dest} (ask-why skill already installed)`);
    return result;
  }
  if (apply) {
    if (current !== null) backup(dest, result);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, desired);
  }
  result.changed.push(`${dest} (ask-why skill)`);
  return result;
}

export function registerAll(
  node: string,
  cli: string,
  apply: boolean,
  paths: RegisterPaths = defaultPaths(),
  insightsOnly = false,
): RegisterResult {
  const a = registerClaude(node, cli, apply, paths, insightsOnly);
  const b = registerCodex(node, cli, apply, paths, insightsOnly);
  // Copilot is a pure MCP consumer (no hooks/skills) — insights-only has no `ask`
  // MCP to register, so there's nothing to wire there. Its capture still works
  // via `oh backfill` / `oh capture --all`.
  const c = insightsOnly ? emptyResult() : registerCopilot(node, cli, apply, paths);
  return {
    changed: [...a.changed, ...b.changed, ...c.changed],
    skipped: [...a.skipped, ...b.skipped, ...c.skipped],
    backups: [...a.backups, ...b.backups, ...c.backups],
    notes: [...a.notes, ...b.notes, ...c.notes],
  };
}
