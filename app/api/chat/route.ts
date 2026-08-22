import { NextResponse, after } from "next/server";
import { embed } from "@/lib/ollama";
import {
  parseLog,
  insertAttempt,
  matchAttempts,
  synthesizeAnswer,
  synthesizeAdaptation,
  synthesizeGenerated,
  synthesizeCookRecipe,
  classifyAskIntent,
  classifyChatIntent,
  detectCookAlongIntent,
  regenerateDishMemory,
  RELEVANCE_THRESHOLD,
  EMBED_MODEL,
  OllamaUnavailableError,
  type Attempt,
  type AttemptMatch,
  type AskPath,
  type CookRecipe,
} from "@/lib/cooking";

export type ChatResponse =
  | { type: "log"; saved: boolean; reply: string; attempt?: Attempt }
  | { type: "cook"; recipe: CookRecipe }
  | { type: "ask"; path: AskPath; answer: string; matches: AttemptMatch[]; savable: boolean };

const MATCH_COUNT = 8;

// Shown instead of the generic failure message specifically when Ollama
// itself couldn't be reached (not running, wrong port) — calmer and more
// accurate than "couldn't answer that".
const UNAVAILABLE_MESSAGE = "Local model unavailable — is Ollama running?";

function askError(answer: string): ChatResponse {
  return { type: "ask", path: "RETRIEVE", answer, matches: [], savable: false };
}

/**
 * POST /api/chat — body { message: string, dish?: string }
 * v1d unified chat: one endpoint for both logging and asking. Classifies
 * the message as LOG or QUERY, then runs the existing logging path or the
 * existing 3-path ask agent (+ cook-mode pre-check) — this is a router in
 * front of lib/cooking.ts, not a rewrite of any of it.
 *
 * `dish`, when present, scopes this to one dish's chat (dish detail page):
 * - QUERY: match_attempts is constrained to that dish, and the model calls
 *   are given the dish as context.
 * - LOG: the message is parsed with that dish as context, and the saved
 *   attempt is force-tagged with it regardless of what the parser inferred
 *   — "logging from here auto-tags the dish."
 */
export async function POST(request: Request) {
  let message: unknown;
  let dish: unknown;
  try {
    const body = await request.json();
    message = body?.message;
    dish = body?.dish;
  } catch {
    return NextResponse.json<ChatResponse>(
      askError("That request didn't look right — try again.")
    );
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json<ChatResponse>(askError("Type something to get started."));
  }

  const trimmed = message.trim();
  const dishFilter = typeof dish === "string" && dish.trim().length > 0 ? dish.trim() : undefined;
  // Only used for LLM-facing calls (classify/synthesize), not for embedding
  // — biases the model's reasoning toward the scoped dish without changing
  // what gets embedded/matched.
  const contextualMessage = dishFilter
    ? `[Context: this conversation is about "${dishFilter}"] ${trimmed}`
    : trimmed;

  try {
    const intent = await classifyChatIntent(contextualMessage);

    if (intent === "LOG") {
      const forParser = dishFilter ? `Regarding ${dishFilter}: ${trimmed}` : trimmed;

      let parsed;
      try {
        parsed = await parseLog(forParser);
      } catch (err) {
        console.error("chat parseLog failed:", err);
        return NextResponse.json<ChatResponse>({
          type: "log",
          saved: false,
          reply: err instanceof OllamaUnavailableError ? UNAVAILABLE_MESSAGE : "Couldn't parse that one — mind rephrasing it?",
        });
      }

      const effectiveDish = dishFilter ?? parsed.dish;
      if (parsed.skip || !effectiveDish) {
        return NextResponse.json<ChatResponse>({
          type: "log",
          saved: false,
          reply: "Doesn't look like a cook — nothing saved.",
        });
      }

      try {
        const attempt = await insertAttempt(trimmed, {
          dish: effectiveDish,
          changes: parsed.changes,
          outcome: parsed.outcome,
          analysis: parsed.analysis,
          rating: parsed.rating,
        });

        // Refresh this dish's cached "memory" summary after the response is
        // sent — Vercel-safe background work, doesn't add latency here.
        after(() => regenerateDishMemory(effectiveDish).catch((err) => {
          console.error("regenerateDishMemory failed:", err);
        }));

        return NextResponse.json<ChatResponse>({ type: "log", saved: true, reply: "Logged.", attempt });
      } catch (err) {
        console.error("chat insertAttempt failed:", err);
        return NextResponse.json<ChatResponse>({
          type: "log",
          saved: false,
          reply: "That parsed fine, but saving it failed — try again in a bit.",
        });
      }
    }

    // QUERY — mirrors the /api/ask agent, optionally scoped to one dish.
    const queryEmbedding = await embed(trimmed, EMBED_MODEL);
    const [candidates, cookAlong] = await Promise.all([
      matchAttempts(queryEmbedding, MATCH_COUNT, dishFilter),
      detectCookAlongIntent(contextualMessage),
    ]);
    const relevant = candidates.filter((m) => m.similarity >= RELEVANCE_THRESHOLD);

    if (cookAlong) {
      const bestMatch = relevant.length > 0 ? relevant[0] : null;
      const recipe = await synthesizeCookRecipe(contextualMessage, bestMatch);
      return NextResponse.json<ChatResponse>({ type: "cook", recipe });
    }

    const path: AskPath =
      relevant.length === 0 ? "GENERATE" : await classifyAskIntent(contextualMessage, relevant);

    if (path === "GENERATE") {
      const answer = await synthesizeGenerated(contextualMessage);
      return NextResponse.json<ChatResponse>({
        type: "ask",
        path: "GENERATE",
        answer,
        matches: [],
        savable: true,
      });
    }

    if (path === "ADAPT") {
      const answer = await synthesizeAdaptation(contextualMessage, relevant);
      return NextResponse.json<ChatResponse>({
        type: "ask",
        path: "ADAPT",
        answer,
        matches: relevant,
        savable: false,
      });
    }

    const answer = await synthesizeAnswer(contextualMessage, relevant);
    return NextResponse.json<ChatResponse>({
      type: "ask",
      path: "RETRIEVE",
      answer,
      matches: relevant,
      savable: false,
    });
  } catch (err) {
    console.error("chat failed:", err);
    return NextResponse.json<ChatResponse>(
      askError(err instanceof OllamaUnavailableError ? UNAVAILABLE_MESSAGE : "Couldn't answer that — try again in a bit.")
    );
  }
}
