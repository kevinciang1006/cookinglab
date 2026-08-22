import { NextResponse } from "next/server";
import { insertGeneratedAttempt, OllamaUnavailableError, type Attempt } from "@/lib/cooking";

export type AskSaveResponse = {
  ok: boolean;
  error?: string;
  attempt?: Attempt;
};

/**
 * POST /api/ask/save — body { answer: string }
 * Distill-back for the GENERATE path: saves the generated recipe/suggestion
 * as a new attempt row (source: "generated"), classifying dish + kind from
 * its content and embedding it so it's findable by future search/ask.
 */
export async function POST(request: Request) {
  let answer: unknown;
  try {
    const body = await request.json();
    answer = body?.answer;
  } catch {
    return NextResponse.json<AskSaveResponse>(
      { ok: false, error: "Bad request." },
      { status: 400 }
    );
  }

  if (typeof answer !== "string" || answer.trim().length === 0) {
    return NextResponse.json<AskSaveResponse>(
      { ok: false, error: "Nothing to save." },
      { status: 400 }
    );
  }

  try {
    const attempt = await insertGeneratedAttempt(answer.trim());
    return NextResponse.json<AskSaveResponse>({ ok: true, attempt });
  } catch (err) {
    console.error("ask save failed:", err);
    if (err instanceof OllamaUnavailableError) {
      return NextResponse.json<AskSaveResponse>(
        { ok: false, error: "Local model unavailable — is Ollama running?" },
        { status: 503 }
      );
    }
    return NextResponse.json<AskSaveResponse>(
      { ok: false, error: "Couldn't save — try again." },
      { status: 500 }
    );
  }
}
