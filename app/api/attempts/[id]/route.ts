import { NextResponse } from "next/server";
import { embed, composeEmbedText } from "@/lib/ollama";
import {
  getAttemptById,
  updateAttempt,
  deleteAttempt,
  EMBED_MODEL,
  OllamaUnavailableError,
  type AttemptKind,
  type AttemptPatch,
} from "@/lib/cooking";

const VALID_KINDS: AttemptKind[] = ["attempt", "experiment", "note"];

type RouteParams = { params: Promise<{ id: string }> };

/**
 * PATCH /api/attempts/[id] — body may include any of dish/changes/outcome/
 * analysis/rating/target/kind. Recomputes the embedding from the merged
 * (existing + patch) row so search/ask stay accurate after an edit.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const existing = await getAttemptById(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const patch: AttemptPatch = {};

  if ("dish" in b) {
    if (typeof b.dish !== "string" || b.dish.trim().length === 0) {
      return NextResponse.json({ error: "dish must be a non-empty string." }, { status: 400 });
    }
    patch.dish = b.dish.trim();
  }
  if ("changes" in b) patch.changes = b.changes === null ? null : String(b.changes);
  if ("outcome" in b) patch.outcome = b.outcome === null ? null : String(b.outcome);
  if ("analysis" in b) patch.analysis = b.analysis === null ? null : String(b.analysis);
  if ("target" in b) patch.target = b.target === null ? null : String(b.target);
  if ("rating" in b) {
    if (b.rating !== null && (typeof b.rating !== "number" || b.rating < 1 || b.rating > 10)) {
      return NextResponse.json({ error: "rating must be 1-10 or null." }, { status: 400 });
    }
    patch.rating = b.rating as number | null;
  }
  if ("kind" in b) {
    if (typeof b.kind !== "string" || !VALID_KINDS.includes(b.kind as AttemptKind)) {
      return NextResponse.json(
        { error: "kind must be attempt, experiment, or note." },
        { status: 400 }
      );
    }
    patch.kind = b.kind as AttemptKind;
  }

  const merged = { ...existing, ...patch };

  try {
    const embedding = await embed(
      composeEmbedText({
        dish: merged.dish,
        target: merged.target,
        analysis: merged.analysis,
        outcome: merged.outcome,
        changes: merged.changes,
      }),
      EMBED_MODEL
    );
    const updated = await updateAttempt(id, patch, embedding);
    return NextResponse.json(updated);
  } catch (err) {
    console.error("attempt PATCH failed:", err);
    if (err instanceof OllamaUnavailableError) {
      return NextResponse.json({ error: "Local model unavailable — is Ollama running?" }, { status: 503 });
    }
    return NextResponse.json({ error: "Couldn't save changes — try again." }, { status: 500 });
  }
}

/** DELETE /api/attempts/[id] — deletes one attempt row. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    await deleteAttempt(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("attempt DELETE failed:", err);
    return NextResponse.json({ error: "Couldn't delete — try again." }, { status: 500 });
  }
}
