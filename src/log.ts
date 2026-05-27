// Tiny append-only file logger. Detached capture processes have no terminal,
// so everything they do lands in ~/.oh/logs/oh.log for debugging.
//
// IMPORTANT: never write to stdout here — the MCP server speaks JSON-RPC over
// stdout, so any stray stdout byte corrupts the protocol. We write to the log
// file and (optionally) stderr.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, LOGS_DIR } from "./config.js";

const LOG_PATH = join(LOGS_DIR, "oh.log");

export function log(scope: string, msg: string, mirrorStderr = false): void {
  const line = `${new Date().toISOString()} [${scope}] ${msg}\n`;
  try {
    ensureDirs();
    appendFileSync(LOG_PATH, line);
  } catch {
    // Logging must never throw.
  }
  if (mirrorStderr) process.stderr.write(line);
}
