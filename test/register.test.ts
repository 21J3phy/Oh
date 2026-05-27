import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAll, installSkill, type RegisterPaths } from "../src/register.js";

const NODE = "/usr/bin/node";
const CLI = "/opt/oh/dist/cli.js";

function setup(): RegisterPaths {
  const dir = mkdtempSync(join(tmpdir(), "oh-reg-"));
  const paths: RegisterPaths = {
    claudeSettings: join(dir, "claude-settings.json"),
    claudeJson: join(dir, "claude.json"),
    codexHooks: join(dir, "codex-hooks.json"),
    codexConfig: join(dir, "codex-config.toml"),
  };
  // Pre-existing content that must survive the merge.
  writeFileSync(
    paths.claudeSettings,
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-notify.sh" }] }] },
    }),
  );
  writeFileSync(paths.claudeJson, JSON.stringify({ mcpServers: { posthog: { command: "ph" } } }));
  writeFileSync(
    paths.codexHooks,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "codex-notify.sh" }] }] } }),
  );
  writeFileSync(paths.codexConfig, 'notify = ["x"]\n\n[mcp_servers.other]\ncommand = "y"\n');
  return paths;
}

const occurrences = (s: string, needle: string) => s.split(needle).length - 1;

test("registerAll merges into existing configs without clobbering them", () => {
  const paths = setup();
  const res = registerAll(NODE, CLI, true, paths);

  assert.ok(res.changed.length >= 4, "all four files changed");
  assert.ok(res.backups.length >= 4, "all four files backed up");

  // Claude hooks: original survives, ours added to Stop + SessionEnd.
  const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8"));
  const stopCommands = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.ok(stopCommands.includes("existing-notify.sh"), "existing hook preserved");
  assert.ok(stopCommands.some((c: string) => c.includes("OH_HOOK=1") && c.includes("--tool claude")));
  assert.ok(settings.hooks.SessionEnd.length >= 1, "SessionEnd hook added");

  // Claude MCP: posthog preserved, oh added.
  const cj = JSON.parse(readFileSync(paths.claudeJson, "utf8"));
  assert.equal(cj.mcpServers.posthog.command, "ph");
  assert.deepEqual(cj.mcpServers.oh, { command: NODE, args: [CLI, "mcp"] });

  // Codex hooks: original survives, ours added.
  const ch = JSON.parse(readFileSync(paths.codexHooks, "utf8"));
  const codexStop = ch.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.ok(codexStop.includes("codex-notify.sh"));
  assert.ok(codexStop.some((c: string) => c.includes("OH_HOOK=1") && c.includes("--tool codex")));

  // Codex MCP: appended, existing block preserved.
  const toml = readFileSync(paths.codexConfig, "utf8");
  assert.ok(toml.includes("[mcp_servers.other]"), "existing toml block preserved");
  assert.ok(toml.includes("[mcp_servers.oh]"));
  assert.ok(toml.includes(`args = ["${CLI}", "mcp"]`));
});

test("re-running is idempotent — no duplicates", () => {
  const paths = setup();
  registerAll(NODE, CLI, true, paths);
  const second = registerAll(NODE, CLI, true, paths);

  assert.equal(second.changed.length, 0, "second run changes nothing");
  assert.ok(second.skipped.length >= 4);

  const settings = readFileSync(paths.claudeSettings, "utf8");
  assert.equal(occurrences(settings, "OH_HOOK=1"), 2, "one Stop + one SessionEnd, no dupes");
  const toml = readFileSync(paths.codexConfig, "utf8");
  assert.equal(occurrences(toml, "[mcp_servers.oh]"), 1, "mcp block appended once");
});

test("re-registering from a new install path replaces the old hook (no dupes)", () => {
  const paths = setup();
  registerAll(NODE, "/old/place/dist/cli.js", true, paths);
  const second = registerAll(NODE, "/new/place/dist/cli.js", true, paths);

  assert.ok(
    second.changed.some((c) => c.includes("settings.json")),
    "the new path is registered as a change",
  );
  const settings = readFileSync(paths.claudeSettings, "utf8");
  assert.ok(settings.includes("/new/place/dist/cli.js"), "new path present");
  assert.ok(!settings.includes("/old/place/dist/cli.js"), "old path removed");
  assert.equal(occurrences(settings, "OH_HOOK=1"), 2, "still exactly Stop + SessionEnd");
  assert.ok(settings.includes("existing-notify.sh"), "pre-existing hook preserved");

  const toml = readFileSync(paths.codexConfig, "utf8");
  assert.ok(toml.includes("/new/place/dist/cli.js"), "codex mcp points to new path");
  assert.ok(!toml.includes("/old/place/dist/cli.js"), "codex mcp old path removed");
  assert.equal(occurrences(toml, "[mcp_servers.oh]"), 1, "codex mcp block not duplicated");
  assert.ok(toml.includes("[mcp_servers.other]"), "existing toml block preserved");
});

test("installSkill copies the ask-why skill, idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-skill-"));
  const src = join(dir, "src", "SKILL.md");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(src, "---\nname: ask-why\n---\nbody\n");
  const skillsDir = join(dir, "skills");

  const first = installSkill(src, skillsDir, true);
  assert.equal(first.changed.length, 1);
  const dest = join(skillsDir, "ask-why", "SKILL.md");
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, "utf8"), /name: ask-why/);

  const second = installSkill(src, skillsDir, true);
  assert.equal(second.changed.length, 0, "no change on re-run");
  assert.equal(second.skipped.length, 1);

  const missing = installSkill(join(dir, "nope.md"), skillsDir, true);
  assert.equal(missing.changed.length, 0);
  assert.equal(missing.notes.length, 1, "missing source is noted, not fatal");
});
