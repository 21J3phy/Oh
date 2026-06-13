// Embedding proxy for the web app's semantic history search — a faithful
// mirror of ../../../site/api/embed.ts (ADR 0010), as a Next App Router route
// handler. The static landing project stays untouched; this app embeds search
// queries with Oh's OpenAI key after verifying the caller's Supabase JWT.
// No memory content is logged or stored here.

export const runtime = "nodejs";

const MAX_TEXTS = 200;
const MAX_CHARS = 16_000;

export async function POST(req: Request): Promise<Response> {
  const supabaseUrl = process.env.OH_SUPABASE_URL;
  const anonKey = process.env.OH_SUPABASE_ANON_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!supabaseUrl || !anonKey || !openaiKey) {
    return Response.json({ error: "embed proxy not configured" }, { status: 500 });
  }

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return Response.json({ error: "missing bearer token" }, { status: 401 });
  }

  // Verify the caller is a real hosted-Oh user.
  const who = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: auth },
  });
  if (who.status !== 200) {
    return Response.json({ error: "invalid token" }, { status: 401 });
  }

  let body: { texts?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const texts = body?.texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) {
    return Response.json({ error: `texts must be 1..${MAX_TEXTS} strings` }, { status: 400 });
  }
  const input = texts.map((t: unknown) => String(t ?? "").slice(0, MAX_CHARS) || " ");

  const oa = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  if (!oa.ok) {
    const detail = await oa.text();
    return Response.json({ error: `embedding upstream ${oa.status}`, detail: detail.slice(0, 300) }, { status: 502 });
  }
  const data = (await oa.json()) as { data: Array<{ index: number; embedding: number[] }> };
  const embeddings = data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return Response.json({ embeddings });
}
