// Secret guard — a cheap regex net applied before any text is embedded or
// stored. Per the plan this is "net, not wall": catch the obvious credential
// shapes, replace them with a placeholder, and move on. A full entropy/Scrub
// engine is deferred until another team's data is in play.

export const PLACEHOLDER = "«secret»";

type Rule = {
  re: RegExp;
  replace: string | ((substring: string, ...args: any[]) => string);
};

// Secret-ish identifier names, allowing an optional prefix (DATABASE_PASSWORD,
// MY_API_KEY) via the [A-Za-z0-9_]* in the generic rule below.
const SECRET_NAME =
  "(?:password|passwd|pwd|secret|secret[_-]?key|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|private[_-]?key)";

// Order matters: multi-line key blocks and specific token shapes first, then
// the generic "<secret-ish name> = <high-entropy value>" catch-all.
const RULES: Rule[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/DSA/PGP/plain).
  {
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replace: PLACEHOLDER,
  },
  // AWS access key IDs (AKIA/ASIA/AGPA/...).
  { re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[0-9A-Z]{16}\b/g, replace: PLACEHOLDER },
  // GitHub personal access / OAuth / app tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replace: PLACEHOLDER },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replace: PLACEHOLDER },
  // OpenAI / Anthropic style keys (sk-, sk-proj-, sk-ant-...).
  { re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, replace: PLACEHOLDER },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: PLACEHOLDER },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: PLACEHOLDER },
  // Stripe secret/restricted keys.
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: PLACEHOLDER },
  // JWTs (header.payload.signature) — covers legacy Supabase anon/service keys, etc.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: PLACEHOLDER },
  // Modern Supabase API keys (sb_secret_… must never leak; sb_publishable_… is
  // semi-public but masked anyway).
  { re: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g, replace: PLACEHOLDER },
  // Credentials embedded in a connection URL (postgres://user:pass@host).
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:)[^@/\s]+@/gi,
    replace: (_m: string, prefix: string) => `${prefix}${PLACEHOLDER}@`,
  },
  // Bearer tokens in headers.
  {
    re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
    replace: (_m: string, prefix: string) => `${prefix}${PLACEHOLDER}`,
  },
  // Generic "<secret-ish name> = <value>" assignments. Keep the name, mask the
  // value. Requires a delimiter so prose like "the API key rotates" never trips
  // it. Quoted values mask their full contents (any symbols); unquoted values
  // mask a 12+ char non-whitespace run.
  {
    re: new RegExp(
      `\\b([A-Za-z0-9_]*${SECRET_NAME}\\b\\s*[:=]\\s*)(?:"([^"\\n]{6,})"|'([^'\\n]{6,})'|([A-Za-z0-9/+_.=~@!#$%^&*-]{12,}))`,
      "gi",
    ),
    replace: (_m: string, prefix: string, dq?: string, sq?: string) => {
      if (typeof dq === "string") return `${prefix}"${PLACEHOLDER}"`;
      if (typeof sq === "string") return `${prefix}'${PLACEHOLDER}'`;
      return `${prefix}${PLACEHOLDER}`;
    },
  },
];

/** Replace credential-shaped substrings with the placeholder. */
export function scrubText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) {
    out = out.replace(re, replace as any);
  }
  return out;
}

/** True if scrubbing would change the text (i.e. a secret was detected). */
export function hasSecret(text: string): boolean {
  return scrubText(text) !== text;
}
