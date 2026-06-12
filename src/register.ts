// Register Oh's capture hooks + the `ask` MCP server in Claude and Codex.
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
}

export function defaultPaths(): RegisterPaths {
  const h = homedir();
  return {
    claudeSettings: join(h, ".claude", "settings.json"),
    claudeJson: join(h, ".claude.json"),
    codexHooks: join(h, ".codex", "hooks.json"),
    codexConfig: join(h, ".codex", "config.toml"),
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

/** Register Claude: Stop+SessionEnd capture hooks and the `ask` MCP server. */
export function registerClaude(
  node: string,
  cli: string,
  apply: boolean,
  paths: RegisterPaths = defaultPaths(),
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

  // --- MCP server (~/.claude.json) ---
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

/** Register Codex: Stop capture hook and the `ask` MCP server. */
export function registerCodex(
  node: string,
  cli: string,
  apply: boolean,
  paths: RegisterPaths = defaultPaths(),
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

  // --- MCP server (config.toml, add or path-correct, preserving the file) ---
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
): RegisterResult {
  const a = registerClaude(node, cli, apply, paths);
  const b = registerCodex(node, cli, apply, paths);
  return {
    changed: [...a.changed, ...b.changed],
    skipped: [...a.skipped, ...b.skipped],
    backups: [...a.backups, ...b.backups],
    notes: [...a.notes, ...b.notes],
  };
}
