import { NextResponse } from "next/server";
import { embed } from "@/lib/ollama";
import { matchAttempts, EMBED_MODEL, OllamaUnavailableError, type AttemptMatch } from "@/lib/cooking";

export type SearchResponse = {
  ok: boolean;
  reply?: string;
  matches?: AttemptMatch[];
};

/**
 * POST /api/search — body { query: string }
 * Embeds the query, runs vector search over attempts via match_attempts,
 * returns the top matches. v1a: search only, no routing/answer-generation.
 */
export async function POST(request: Request) {
  let query: unknown;
  try {
    const body = await request.json();
    query = body?.query;
  } catch {
    return NextResponse.json<SearchResponse>({
      ok: false,
      reply: "That request didn't look right — try searching again.",
    });
  }

  if (typeof query !== "string" || query.trim().length === 0) {
    return NextResponse.json<SearchResponse>({
      ok: false,
      reply: "Type something to search for.",
    });
  }

  try {
    const queryEmbedding = await embed(query.trim(), EMBED_MODEL);
    const matches = await matchAttempts(queryEmbedding);
    return NextResponse.json<SearchResponse>({ ok: true, matches });
  } catch (err) {
    console.error("search failed:", err);
    return NextResponse.json<SearchResponse>({
      ok: false,
      reply: err instanceof OllamaUnavailableError ? "Local model unavailable — is Ollama running?" : "Search failed — try again in a bit.",
    });
  }
}
