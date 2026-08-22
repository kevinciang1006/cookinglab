/**
 * Standalone one-off backfill: embeds every attempts row with a null
 * embedding and writes it back.
 *
 * Self-contained on purpose — does NOT import lib/ollama.ts, because that
 * module has `import "server-only"` at the top, which throws when loaded
 * outside Next's server bundler (confirmed: plain tsx/node hits the throw
 * in node_modules/server-only/index.js). Same reason scripts/import-journey.ts
 * doesn't import lib/cooking.ts. The embed() call and composeEmbedText()
 * formula here are kept in sync with lib/ollama.ts by hand.
 *
 * Run after 0008_switch_to_ollama_embeddings.sql, which nulls every
 * existing (Gemini, 1536-dim) embedding — this script re-embeds every row
 * at nomic-embed-text's native 768 dims via a local Ollama instance. No
 * rate-limit pacing needed (local, not a metered API).
 *
 * Idempotent: only selects rows where embedding is null, so re-running only
 * touches whatever hasn't been embedded yet.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text"; // 768 dims — matches vector(768) in the schema

type AttemptRow = {
  id: string;
  dish: string;
  target: string | null;
  analysis: string | null;
  outcome: string | null;
  changes: string | null;
};

// Kept identical to lib/ollama.ts's composeEmbedText — dish and analysis
// lead deliberately so analysis (the most commonly searched reasoning)
// isn't diluted by the shorter changes/outcome fields.
function composeEmbedText(row: AttemptRow): string {
  const { dish, target, analysis, outcome, changes } = row;
  return `${dish}${target ? " (imitating " + target + ")" : ""}. ${analysis ?? ""} ${outcome ?? ""} ${changes ?? ""}`;
}

/** L2-normalizes a vector to unit length. */
function l2Normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return values;
  return values.map((v) => v / magnitude);
}

// Kept identical to lib/ollama.ts's embed().
async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embeddings request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { embedding?: number[] };
  if (!json.embedding) throw new Error("Ollama returned an empty embedding");
  return l2Normalize(json.embedding);
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set (check .env.local)");
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: rows, error: selectError } = await supabase
    .from("attempts")
    .select("id, dish, target, analysis, outcome, changes")
    .is("embedding", null);

  if (selectError) throw selectError;

  const pending = (rows ?? []) as AttemptRow[];

  if (pending.length === 0) {
    console.log("No rows with a null embedding — nothing to do.");
    return;
  }

  console.log(`Found ${pending.length} row(s) with a null embedding. Embedding via ${OLLAMA_URL} (${EMBED_MODEL})...`);

  let done = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const text = composeEmbedText(row);
    process.stdout.write(`[${i + 1}/${pending.length}] ${row.dish} — `);

    try {
      const embedding = await embed(text);
      const { error: updateError } = await supabase
        .from("attempts")
        .update({ embedding })
        .eq("id", row.id);

      if (updateError) throw updateError;

      console.log("embedded");
      done++;
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
    // No delay — local Ollama, not a metered cloud API.
  }

  console.log("\n--- Summary ---");
  console.log(`Embedded: ${done}`);
  console.log(`Failed:   ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
