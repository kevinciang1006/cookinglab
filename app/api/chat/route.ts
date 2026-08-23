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
  checkSavedRecipe,
  buildAnswerFromSavedRecipe,
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
// as a "meta" event, before the answer starts streaming in behind it.
export type ChatStreamMeta = Omit<Extract<ChatResponse, { type: "ask" }>, "answer">;

/** Progress markers sent before/between the silent pre-generation steps (classify, embed+search, model call) so the client never sits on dead air. */
export type ChatPhase = "classifying" | "searching" | "thinking" | "logging";

// The whole POST /api/chat response is one of these lines, uniformly, for
// every outcome (log, cook, ask) — not just the token-streamed answer.
export type ChatStreamEvent =
  | { type: "status"; phase: ChatPhase }
  | { type: "meta"; meta: ChatStreamMeta }
  | { type: "token"; text: string }
  | { type: "result"; response: ChatResponse }
  | { type: "error"; message: string }
  | { type: "done" };

const MATCH_COUNT = 8;

// Shown instead of the generic failure message specifically when Ollama
// itself couldn't be reached (not running, wrong port) — calmer and more
// accurate than "couldn't answer that".
const UNAVAILABLE_MESSAGE = "Local model unavailable — is Ollama running?";

function askError(answer: string): ChatResponse {
  return { type: "ask", path: "RETRIEVE", answer, matches: [], savable: false };
}

/**
 * Wraps the whole classify → retrieve → generate pipeline in one SSE
 * response. `run` emits status/meta/token/result events as each phase
 * happens — including status events for the silent pre-generation steps
 * (classifying, searching) that used to leave the client with no signal at
 * all until the answer was already fully ready. "done" is appended
 * automatically once `run` resolves, unless it already emitted "error"
 * (headers are committed 200 by the time streaming starts, so a failure
 * can't become an HTTP error status — the client treats "error" as terminal
 * instead of waiting for "done").
 */
function streamChat(run: (emit: (event: ChatStreamEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let errored = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: ChatStreamEvent) {
        if (event.type === "error") errored = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      try {
        await run(emit);
      } finally {
        if (!errored) emit({ type: "done" });
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

  return streamChat(async (emit) => {
    try {
      emit({ type: "status", phase: "classifying" });
      const intent = await classifyChatIntent(contextualMessage);

      if (intent === "LOG") {
        emit({ type: "status", phase: "logging" });
        const forParser = dishFilter ? `Regarding ${dishFilter}: ${trimmed}` : trimmed;

        let parsed;
        try {
          parsed = await parseLog(forParser);
        } catch (err) {
          console.error("chat parseLog failed:", err);
          emit({
            type: "result",
            response: {
              type: "log",
              saved: false,
              reply:
                err instanceof OllamaUnavailableError
                  ? UNAVAILABLE_MESSAGE
                  : "Couldn't parse that one — mind rephrasing it?",
            },
          });
          return;
        }

        const effectiveDish = dishFilter ?? parsed.dish;
        if (parsed.skip || !effectiveDish) {
          emit({
            type: "result",
            response: { type: "log", saved: false, reply: "Doesn't look like a cook — nothing saved." },
          });
          return;
        }

        try {
          const attempt = await insertAttempt(trimmed, {
            dish: effectiveDish,
            changes: parsed.changes,
            outcome: parsed.outcome,
            analysis: parsed.analysis,
            rating: parsed.rating,
          });

          // Refresh this dish's cached "memory" summary after the response
          // is sent — Vercel-safe background work, doesn't add latency here.
          after(() => regenerateDishMemory(effectiveDish).catch((err) => {
            console.error("regenerateDishMemory failed:", err);
          }));

          emit({ type: "result", response: { type: "log", saved: true, reply: "Logged.", attempt } });
        } catch (err) {
          console.error("chat insertAttempt failed:", err);
          emit({
            type: "result",
            response: {
              type: "log",
              saved: false,
              reply: "That parsed fine, but saving it failed — try again in a bit.",
            },
          });
        }
        return;
      }

      // QUERY — mirrors the /api/ask agent, optionally scoped to one dish.
      emit({ type: "status", phase: "searching" });
      const queryEmbedding = await embed(trimmed, EMBED_MODEL);
      const [candidates, cookAlong] = await Promise.all([
        matchAttempts(queryEmbedding, MATCH_COUNT, dishFilter),
        detectCookAlongIntent(contextualMessage),
      ]);
      const relevant = candidates.filter((m) => m.similarity >= RELEVANCE_THRESHOLD);

      if (cookAlong) {
        emit({ type: "status", phase: "thinking" });
        const bestMatch = relevant.length > 0 ? relevant[0] : null;
        const recipe = await synthesizeCookRecipe(contextualMessage, bestMatch);
        emit({ type: "result", response: { type: "cook", recipe } });
        return;
      }

      // Saved recipe check — takes priority over RETRIEVE/ADAPT/GENERATE
      // entirely: if this dish already has a saved recipe, return exactly
      // what was saved (no model call, so it can't invent ingredients)
      // instead of letting classifyAskIntent route to a reconstruction.
      const savedRecipe = await checkSavedRecipe(contextualMessage, queryEmbedding, dishFilter);
      if (savedRecipe) {
        const answer = await buildAnswerFromSavedRecipe(savedRecipe);
        emit({ type: "meta", meta: { type: "ask", path: "RECIPE", matches: relevant, savable: false } });
        emit({ type: "token", text: answer });
        return;
      }

      const path: AskPath =
        relevant.length === 0 ? "GENERATE" : await classifyAskIntent(contextualMessage, relevant);

      emit({ type: "status", phase: "thinking" });

      // From here on, only the prose answer itself streams — intent
      // classification and retrieval already happened above.
      if (path === "GENERATE") {
        emit({ type: "meta", meta: { type: "ask", path: "GENERATE", matches: [], savable: true } });
        for await (const chunk of synthesizeGeneratedStream(contextualMessage)) {
          emit({ type: "token", text: chunk });
        }
        return;
      }

      if (path === "ADAPT") {
        emit({ type: "meta", meta: { type: "ask", path: "ADAPT", matches: relevant, savable: false } });
        for await (const chunk of synthesizeAdaptationStream(contextualMessage, relevant)) {
          emit({ type: "token", text: chunk });
        }
        return;
      }

      emit({ type: "meta", meta: { type: "ask", path: "RETRIEVE", matches: relevant, savable: false } });
      for await (const chunk of synthesizeAnswerStream(contextualMessage, relevant)) {
        emit({ type: "token", text: chunk });
      }
    } catch (err) {
      console.error("chat failed:", err);
      emit({
        type: "error",
        message: err instanceof OllamaUnavailableError ? UNAVAILABLE_MESSAGE : "Couldn't answer that — try again in a bit.",
      });
    }
  });
}
