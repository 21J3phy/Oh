// Read/write ~/.oh/config.json and the local-state paths under ~/.oh.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { Config } from "./types.js";

export const OH_DIR = join(homedir(), ".oh");
export const CONFIG_PATH = join(OH_DIR, "config.json");
export const OFFSETS_DIR = join(OH_DIR, "offsets");
export const LOGS_DIR = join(OH_DIR, "logs");
export const SCHEMA_OUT_PATH = join(OH_DIR, "schema.sql");

const DEFAULTS = {
  embeddingModel: "text-embedding-3-small",
  includeThinking: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.25,
} satisfies Partial<Config>;

const REQUIRED_KEYS = ["author", "supabaseUrl", "supabaseKey", "openaiKey"] as const;

export function ensureDirs(): void {
  for (const dir of [OH_DIR, OFFSETS_DIR, LOGS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

/** Load config, applying defaults and validating that required fields are present. */
export function loadConfig(): Config {
  if (!configExists()) {
    throw new Error(
      `No Oh config at ${CONFIG_PATH}. Run \`oh init\` first.`,
    );
  }
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  const cfg = { ...DEFAULTS, ...raw } as Config;
  const missing = REQUIRED_KEYS.filter((k) => !cfg[k]);
  if (missing.length > 0) {
    throw new Error(
      `Oh config is missing required field(s): ${missing.join(", ")}. Run \`oh init\`.`,
    );
  }
  return cfg;
}

/** Read whatever config exists (or {}) without validating — used by `oh init`. */
export function readPartialConfig(): Partial<Config> {
  if (!configExists()) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

/** Merge `partial` into the existing config and write it back (pretty-printed). */
export function saveConfig(partial: Partial<Config>): Config {
  ensureDirs();
  const merged = { ...DEFAULTS, ...readPartialConfig(), ...partial } as Config;
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  return merged;
}
