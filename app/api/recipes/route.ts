import { NextResponse } from "next/server";
import { listRecipesForDish, upsertRecipe, OllamaUnavailableError, type Recipe } from "@/lib/cooking";
import { extractRecipeForSave } from "@/lib/parseRecipeMarkdown";

export type RecipesGetResponse = { ok: true; recipes: Recipe[] } | { ok: false; error: string };
export type RecipesPostResponse = { ok: true; recipe: Recipe } | { ok: false; error: string };

/**
 * GET /api/recipes?dish=<name> — lists every saved variation for a dish,
 * most recently updated first. Used by the dish page's variation switcher.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dish = searchParams.get("dish")?.trim();
  if (!dish) {
    return NextResponse.json<RecipesGetResponse>({ ok: false, error: "dish is required." }, { status: 400 });
  }

  try {
    const recipes = await listRecipesForDish(dish);
    return NextResponse.json<RecipesGetResponse>({ ok: true, recipes });
  } catch (err) {
    console.error("recipes GET failed:", err);
    return NextResponse.json<RecipesGetResponse>(
      { ok: false, error: "Couldn't load recipes — try again." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/recipes — body { sourceAnswer: string, dish?: string,
 * variationLabel?: string | null }. Distills sourceAnswer (an assistant
 * chat answer already showing "Save as recipe") into structured ingredients
 * + steps + a summary (lib/parseRecipeMarkdown's extractRecipeForSave), then
 * inserts a new recipe or updates the existing one for that exact
 * dish + variationLabel pair — keeping it "current" rather than
 * accumulating duplicates every time the same variation is re-saved.
 * `dish`, when passed, overrides whatever the answer's own heading says
 * (same "logging from here auto-tags the dish" convention as /api/chat's
 * dish-scoped LOG path) — used when saving from a dish-scoped chat.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<RecipesPostResponse>({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const sourceAnswer = typeof b.sourceAnswer === "string" ? b.sourceAnswer : "";
  if (!sourceAnswer.trim()) {
    return NextResponse.json<RecipesPostResponse>({ ok: false, error: "Nothing to save." }, { status: 400 });
  }
  const dishOverride = typeof b.dish === "string" && b.dish.trim().length > 0 ? b.dish.trim() : undefined;
  const variationLabel =
    typeof b.variationLabel === "string" && b.variationLabel.trim().length > 0 ? b.variationLabel.trim() : null;

  const extracted = extractRecipeForSave(sourceAnswer);
  if (!extracted || extracted.steps.length === 0) {
    return NextResponse.json<RecipesPostResponse>(
      { ok: false, error: "That answer doesn't look like a recipe — nothing to save." },
      { status: 400 }
    );
  }

  try {
    const recipe = await upsertRecipe({
      dish: dishOverride ?? extracted.dish,
      variationLabel,
      ingredients: extracted.ingredients,
      steps: extracted.steps,
      summary: extracted.summary,
      sourceAnswer,
    });
    return NextResponse.json<RecipesPostResponse>({ ok: true, recipe });
  } catch (err) {
    console.error("recipes POST failed:", err);
    const message = err instanceof OllamaUnavailableError ? "Local model unavailable — is Ollama running?" : "Couldn't save that recipe — try again.";
    return NextResponse.json<RecipesPostResponse>({ ok: false, error: message }, { status: 500 });
  }
}
