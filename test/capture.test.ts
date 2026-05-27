import { test } from "node:test";
import assert from "node:assert/strict";
import { repoAllowed, resolveProjectKey } from "../src/capture.js";

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
