import { NextResponse, after } from "next/server";
import { embed } from "@/lib/ollama";
import {
  parseLog,
  insertAttempt,
  matchAttempts,
  synthesizeAnswerStream,
  synthesizeAdaptationStream,
  synthesizeGeneratedStream,
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

// Everything about an "ask" response except the answer text itself — sent
// as the first SSE event, before the answer starts streaming in behind it.
export type ChatStreamMeta = Omit<Extract<ChatResponse, { type: "ask" }>, "answer">;

const MATCH_COUNT = 8;

// Shown instead of the generic failure message specifically when Ollama
// itself couldn't be reached (not running, wrong port) — calmer and more
// accurate than "couldn't answer that".
const UNAVAILABLE_MESSAGE = "Local model unavailable — is Ollama running?";

function askError(answer: string): ChatResponse {
  return { type: "ask", path: "RETRIEVE", answer, matches: [], savable: false };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Streams a prose answer as Server-Sent Events: a "meta" event with
 * everything but the answer text, then one "delta" event per chunk as the
 * model generates, then "done" — or an "error" event in place of "done" if
 * the model call fails mid-stream (headers are already committed 200 by
 * the time streaming starts, so a failure can't become an HTTP error status
 * — the client treats an "error" event as the terminal state instead).
 * Only the final prose answer generation streams; intent classification and
 * retrieval already ran (synchronously, above) before this is called.
 */
function streamAskResponse(meta: ChatStreamMeta, chunks: AsyncGenerator<string, void, unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(sseEvent("meta", meta)));
      try {
        for await (const chunk of chunks) {
          controller.enqueue(encoder.encode(sseEvent("delta", { text: chunk })));
        }
        controller.enqueue(encoder.encode(sseEvent("done", {})));
      } catch (err) {
        console.error("chat answer stream failed:", err);
        const message =
          err instanceof OllamaUnavailableError ? UNAVAILABLE_MESSAGE : "Couldn't answer that — try again in a bit.";
        controller.enqueue(encoder.encode(sseEvent("error", { message })));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
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

    // From here on, only the prose answer itself streams — intent
    // classification and retrieval already happened above.
    if (path === "GENERATE") {
      return streamAskResponse(
        { type: "ask", path: "GENERATE", matches: [], savable: true },
        synthesizeGeneratedStream(contextualMessage)
      );
    }

    if (path === "ADAPT") {
      return streamAskResponse(
        { type: "ask", path: "ADAPT", matches: relevant, savable: false },
        synthesizeAdaptationStream(contextualMessage, relevant)
      );
    }

    return streamAskResponse(
      { type: "ask", path: "RETRIEVE", matches: relevant, savable: false },
      synthesizeAnswerStream(contextualMessage, relevant)
    );
  } catch (err) {
    console.error("chat failed:", err);
    return NextResponse.json<ChatResponse>(
      askError(err instanceof OllamaUnavailableError ? UNAVAILABLE_MESSAGE : "Couldn't answer that — try again in a bit.")
    );
  }
}
