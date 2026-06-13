// @ts-nocheck
// Hosted Oh's embedding proxy (ADR 0010). Users bring zero keys: the CLI sends
// scrubbed reasoning text with the user's Supabase JWT; we verify the JWT
// against the hosted project, then embed via OpenAI with OUR key (the COGS the
// Team tier prices in). No memory content is logged or stored here.

const MAX_TEXTS = 200;
const MAX_CHARS = 16_000;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const supabaseUrl = process.env.OH_SUPABASE_URL;
  const anonKey = process.env.OH_SUPABASE_ANON_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!supabaseUrl || !anonKey || !openaiKey) {
    res.status(500).json({ error: "embed proxy not configured" });
    return;
  }

  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }

  // Verify the caller is a real hosted-Oh user.
  const who = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: auth },
  });
  if (who.status !== 200) {
    res.status(401).json({ error: "invalid token" });
    return;
  }

  const texts = req.body?.texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) {
    res.status(400).json({ error: `texts must be 1..${MAX_TEXTS} strings` });
    return;
  }
  const input = texts.map((t: unknown) =>
    String(t ?? "").slice(0, MAX_CHARS) || " ",
  );

  const oa = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  if (!oa.ok) {
    const detail = await oa.text();
    res.status(502).json({ error: `embedding upstream ${oa.status}`, detail: detail.slice(0, 300) });
    return;
  }
  const data = (await oa.json()) as { data: Array<{ index: number; embedding: number[] }> };
  const embeddings = data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

  res.status(200).json({ embeddings });
}
