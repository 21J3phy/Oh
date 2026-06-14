import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveFromIndex, repoAllowed, resolveProjectKey } from "../src/capture.js";
import { isIncognito } from "../src/config.js";

test("no allowlist captures everything", () => {
  assert.equal(repoAllowed("/whatever", undefined), true);
  assert.equal(repoAllowed("/whatever", []), true);
  assert.equal(repoAllowed(null, undefined), true);
});

test("with an allowlist, unknown/missing cwds are excluded", () => {
  assert.equal(repoAllowed(null, ["oh"]), false);
  assert.equal(repoAllowed("/definitely/not/a/repo", ["oh"]), false);
});

test("matches the current repo's git remote by substring", () => {
  const key = resolveProjectKey(process.cwd());
  if (!key) return; // not in a git repo with an origin remote — skip
  const name = key.split("/").pop()!;
  assert.equal(repoAllowed(process.cwd(), [name]), true, `should match ${name} in ${key}`);
  assert.equal(repoAllowed(process.cwd(), [key]), true, "full remote matches");
  assert.equal(repoAllowed(process.cwd(), ["zzz-not-a-real-project"]), false);
});

// --- Incognito (ADR 0011) -------------------------------------------------

test("effectiveFromIndex: no private boundary behaves like the tail-overlap start", () => {
  assert.equal(effectiveFromIndex(null, 0), 0);
  assert.equal(effectiveFromIndex(null, 5), 5);
  assert.equal(effectiveFromIndex({ bytes: 0, mtimeMs: 0, processed: 6, updatedAt: "" }, 5), 5);
});

test("effectiveFromIndex: never reaches back across a private boundary", () => {
  const prev = { bytes: 0, mtimeMs: 0, processed: 4, updatedAt: "", privateThrough: 3 };
  // The normal overlap would re-embed index 3 (the last private one) — forbidden.
  assert.equal(effectiveFromIndex(prev, 3), 4);
  // A larger legitimate start still wins.
  assert.equal(effectiveFromIndex(prev, 10), 10);
  // privateThrough: -1 means "no boundary".
  assert.equal(effectiveFromIndex({ ...prev, privateThrough: -1 }, 0), 0);
});

test("isIncognito: respects the OH_INCOGNITO env switch", () => {
  const saved = process.env.OH_INCOGNITO;
  try {
    delete process.env.OH_INCOGNITO;
    const baseline = isIncognito(); // depends on a real ~/.oh/incognito marker
    process.env.OH_INCOGNITO = "1";
    assert.equal(isIncognito(), true);
    process.env.OH_INCOGNITO = "0";
    assert.equal(isIncognito(), baseline, "'0' is off");
    process.env.OH_INCOGNITO = "false";
    assert.equal(isIncognito(), baseline, "'false' is off");
  } finally {
    if (saved === undefined) delete process.env.OH_INCOGNITO;
    else process.env.OH_INCOGNITO = saved;
  }
});
