import { NextResponse } from "next/server";
import { embed } from "@/lib/ollama";
import {
  matchAttempts,
  synthesizeAnswer,
  synthesizeAdaptation,
  synthesizeGenerated,
  synthesizeCookRecipe,
  classifyAskIntent,
  detectCookAlongIntent,
  RELEVANCE_THRESHOLD,
  EMBED_MODEL,
  OllamaUnavailableError,
  type AttemptMatch,
  type AskPath,
  type CookRecipe,
} from "@/lib/cooking";

export type AskResponse =
  | { mode: "cook"; recipe: CookRecipe }
  | {
      mode: "ask";
      path: AskPath;
      answer: string;
      matches: AttemptMatch[];
      savable: boolean;
    };

const MATCH_COUNT = 8;

// Shown instead of the generic failure message specifically when Ollama
// itself couldn't be reached (not running, wrong port).
const UNAVAILABLE_MESSAGE = "Local model unavailable — is Ollama running?";

function askError(answer: string): AskResponse {
  return { mode: "ask", path: "RETRIEVE", answer, matches: [], savable: false };
}

/**
 * POST /api/ask — body { question: string }
 * v1c: a 3-path agent (RETRIEVE/ADAPT/GENERATE), plus a cook-mode pre-check.
 * Embeds the question, retrieves the top 8 attempts, and in parallel checks
 * for "cook along with me right now" intent. If that's detected, returns a
 * structured { mode: "cook", recipe } instead of prose, grounded in the
 * best-matching attempt (or generated from scratch if nothing matches).
 * Otherwise, filters matches to those clearing RELEVANCE_THRESHOLD, forces
 * GENERATE if nothing clears it, and classifies intent otherwise. Only
 * GENERATE is allowed to use outside knowledge, and only GENERATE is
 * `savable` (offer a "Save to log" action via POST /api/ask/save).
 */
export async function POST(request: Request) {
  let question: unknown;
  try {
    const body = await request.json();
    question = body?.question;
  } catch {
    return NextResponse.json<AskResponse>(
      askError("That request didn't look right — try asking again.")
    );
  }

  if (typeof question !== "string" || question.trim().length === 0) {
    return NextResponse.json<AskResponse>(askError("Type a question to ask."));
  }

  const trimmed = question.trim();

  try {
    const queryEmbedding = await embed(trimmed, EMBED_MODEL);
    const [candidates, cookAlong] = await Promise.all([
      matchAttempts(queryEmbedding, MATCH_COUNT),
      detectCookAlongIntent(trimmed),
    ]);
    const relevant = candidates.filter((m) => m.similarity >= RELEVANCE_THRESHOLD);

    if (cookAlong) {
      const bestMatch = relevant.length > 0 ? relevant[0] : null;
      const recipe = await synthesizeCookRecipe(trimmed, bestMatch);
      return NextResponse.json<AskResponse>({ mode: "cook", recipe });
    }

    const path: AskPath =
      relevant.length === 0 ? "GENERATE" : await classifyAskIntent(trimmed, relevant);

    if (path === "GENERATE") {
      const answer = await synthesizeGenerated(trimmed);
      return NextResponse.json<AskResponse>({
        mode: "ask",
        path: "GENERATE",
        answer,
        matches: [],
        savable: true,
      });
    }

    if (path === "ADAPT") {
      const answer = await synthesizeAdaptation(trimmed, relevant);
      return NextResponse.json<AskResponse>({
        mode: "ask",
        path: "ADAPT",
        answer,
        matches: relevant,
        savable: false,
      });
    }

    const answer = await synthesizeAnswer(trimmed, relevant);
    return NextResponse.json<AskResponse>({
      mode: "ask",
      path: "RETRIEVE",
      answer,
      matches: relevant,
      savable: false,
    });
  } catch (err) {
    console.error("ask failed:", err);
    return NextResponse.json<AskResponse>(
      askError(err instanceof OllamaUnavailableError ? UNAVAILABLE_MESSAGE : "Couldn't answer that — try again in a bit.")
    );
  }
}
