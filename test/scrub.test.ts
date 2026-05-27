import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubText, hasSecret, PLACEHOLDER } from "../src/scrub.js";

test("masks an AWS access key id", () => {
  const out = scrubText("export AWS_KEY=AKIAIOSFODNN7EXAMPLE in the script");
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(out.includes(PLACEHOLDER));
});

test("masks GitHub, OpenAI, Slack, Stripe, Google tokens", () => {
  const cases = [
    "ghp_0123456789abcdef0123456789abcdef0123",
    "sk-proj-abcdefABCDEF0123456789abcdefABCDEF",
    "xoxb-1234567890-abcdefghij",
    "sk_live_0123456789abcdef0123",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  ];
  for (const secret of cases) {
    const out = scrubText(`value is ${secret} ok`);
    assert.ok(!out.includes(secret), `should mask ${secret}`);
    assert.ok(out.includes(PLACEHOLDER));
  }
});

test("masks a PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  const out = scrubText(`here ${pem} done`);
  assert.ok(!out.includes("MIIEpAIBAAKCAQEA"));
  assert.equal(out, `here ${PLACEHOLDER} done`);
});

test("masks the value of a generic secret assignment but keeps the name", () => {
  const out = scrubText('DATABASE_PASSWORD = "s3cr3tP@ssw0rd_long_enough"');
  assert.ok(out.includes("DATABASE_PASSWORD"));
  assert.ok(!out.includes("s3cr3tP@ssw0rd_long_enough"));
  assert.ok(out.includes(PLACEHOLDER));
});

test("masks credentials in a connection URL", () => {
  const out = scrubText("postgres://admin:hunter2supersecret@db.example.com:5432/app");
  assert.ok(!out.includes("hunter2supersecret"));
  assert.ok(out.includes("postgres://admin:"));
  assert.ok(out.includes(PLACEHOLDER));
});

test("masks modern Supabase keys (sb_secret_ / sb_publishable_)", () => {
  for (const secret of [
    "sb_secret_EXAMPLEonly0000aaaabbbbccccdddd",
    "sb_publishable_EXAMPLE-only_0000aaaa1111bbbb_",
  ]) {
    const out = scrubText(`key is ${secret} here`);
    assert.ok(!out.includes(secret), `should mask ${secret}`);
    assert.ok(out.includes(PLACEHOLDER));
  }
});

test("masks a JWT / Supabase service key", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.dumm_signature_value_123";
  assert.ok(hasSecret(jwt));
  assert.ok(!scrubText(jwt).includes(jwt));
});

test("does not trip on ordinary prose mentioning keys", () => {
  const prose =
    "We rotate the API key monthly and store the token in the secret manager. The password policy is strict.";
  assert.equal(scrubText(prose), prose);
  assert.equal(hasSecret(prose), false);
});

test("leaves code and file paths untouched", () => {
  const code = "const repo = basename(cwd); // src/parse/claude.ts handles tool_use blocks";
  assert.equal(scrubText(code), code);
});
