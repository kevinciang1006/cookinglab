import { NextResponse } from "next/server";
import { insertAttempt, parseLog, OllamaUnavailableError, type Attempt } from "@/lib/cooking";

export type LogResponse = {
  saved: boolean;
  reply: string;
  attempt?: Attempt;
};

/**
 * POST /api/log — body { message: string }
 * Parses the message, decides skip/save, inserts on a valid cook.
 * Always responds 200 with { saved, reply, attempt? } — errors are surfaced
 * as a friendly `reply`, never as an unhandled 500 / stack trace (FR5).
 */
export async function POST(request: Request) {
  let message: unknown;
  try {
    const body = await request.json();
    message = body?.message;
  } catch {
    return NextResponse.json<LogResponse>({
      saved: false,
      reply: "That request didn't look right — try sending your log again.",
    });
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json<LogResponse>({
      saved: false,
      reply: "Write a line about what you cooked and send it over.",
    });
  }

  let parsed;
  try {
    parsed = await parseLog(message);
  } catch (err) {
    console.error("parseLog failed:", err);
    return NextResponse.json<LogResponse>({
      saved: false,
      reply:
        err instanceof OllamaUnavailableError
          ? "Local model unavailable — is Ollama running?"
          : "Couldn't parse that one — mind rephrasing it?",
    });
  }

  if (parsed.skip || !parsed.dish) {
    return NextResponse.json<LogResponse>({
      saved: false,
      reply: "Doesn't look like a cook — nothing saved.",
    });
  }

  try {
    const attempt = await insertAttempt(message, {
      dish: parsed.dish,
      changes: parsed.changes,
      outcome: parsed.outcome,
      analysis: parsed.analysis,
      rating: parsed.rating,
    });
    return NextResponse.json<LogResponse>({
      saved: true,
      reply: "Logged.",
      attempt,
    });
  } catch (err) {
    console.error("insertAttempt failed:", err);
    return NextResponse.json<LogResponse>({
      saved: false,
      reply: "That parsed fine, but saving it failed — try again in a bit.",
    });
  }
}
