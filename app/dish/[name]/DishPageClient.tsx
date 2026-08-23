"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatPanel, CookDrawer, RatingChip, renderMarkdownLite, type CookModeData } from "@/app/components/shared";
import type { DishMemoryResponse } from "@/app/api/dish/[name]/memory/route";
import type { RecipesGetResponse } from "@/app/api/recipes/route";
import type { Attempt, Recipe } from "@/lib/cooking";

function recipeToCookModeData(recipe: Recipe): CookModeData {
  return {
    dish: recipe.dish,
    ingredients:
      recipe.ingredients.length > 0
        ? recipe.ingredients.map((i) => (i.amount ? `${i.item} — ${i.amount}` : i.item))
        : null,
    steps: recipe.steps,
    learnings: [],
  };
}

export default function DishPageClient({ dish }: { dish: string }) {
  const router = useRouter();
  const [cookRecipe, setCookRecipe] = useState<CookModeData | null>(null);

  const [memory, setMemory] = useState<DishMemoryResponse | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(true);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(true);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);

  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(true);

  async function refreshMemory() {
    setMemoryLoading(true);
    try {
      const res = await fetch(`/api/dish/${encodeURIComponent(dish)}/memory`);
      if (res.ok) setMemory(await res.json());
    } finally {
      setMemoryLoading(false);
    }
  }

  async function refreshRecipes() {
    setRecipesLoading(true);
    try {
      const res = await fetch(`/api/recipes?dish=${encodeURIComponent(dish)}`);
      const data: RecipesGetResponse = await res.json();
      if (data.ok) {
        setRecipes(data.recipes);
        // Default to the most recently updated variation (the API already
        // orders that way) — but only when nothing's selected yet, or the
        // previously selected one no longer exists (e.g. it was deleted).
        setSelectedRecipeId((prev) =>
          prev && data.recipes.some((r) => r.id === prev) ? prev : (data.recipes[0]?.id ?? null)
        );
      }
    } finally {
      setRecipesLoading(false);
    }
  }

  async function refreshAttempts() {
    setAttemptsLoading(true);
    try {
      const res = await fetch(`/api/dish/${encodeURIComponent(dish)}/attempts`);
      if (res.ok) setAttempts(await res.json());
    } finally {
      setAttemptsLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard refetch-on-param-change; each refresh* guards itself via `finally`.
    refreshMemory();
    refreshRecipes();
    refreshAttempts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dish]);

  // Regeneration/embedding happen server-side in the background after a log
  // succeeds — not done the instant the client hears back, so give it a
  // moment before refetching (memory, and the attempt count/list).
  function handleLogged() {
    refreshAttempts();
    setTimeout(refreshMemory, 4000);
  }

  const selectedRecipe = recipes.find((r) => r.id === selectedRecipeId) ?? null;
  const attemptCount = memory?.attemptCount ?? attempts.length;

  return (
    // Cook mode is a drawer alongside this, not a takeover — see CookDrawer:
    // a flex sibling here, fixed full-screen on mobile via its own classes.
    <div className="flex h-dvh bg-paper">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="mx-auto w-full max-w-3xl px-4 pt-4 pb-4 sm:pt-8">
          <button
            type="button"
            onClick={() => router.back()}
            className="mb-3 inline-flex items-center gap-1.5 font-mono text-xs text-ink-muted hover:text-accent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 19l-7-7 7-7"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back
          </button>
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {dish}
            </h1>
            <span className="font-mono text-sm text-ink-faint">
              {attemptCount} attempt{attemptCount === 1 ? "" : "s"}
            </span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-10">
            {/* PRIMARY: the current recipe(s) for this dish. */}
            <section>
              {recipes.length > 1 && (
                <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                  {recipes.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRecipeId(r.id)}
                      className={`shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 font-mono text-xs transition-colors ${
                        r.id === selectedRecipeId
                          ? "bg-accent text-paper"
                          : "border border-hairline text-ink-muted hover:text-ink"
                      }`}
                    >
                      {r.variationLabel ?? "Original"}
                    </button>
                  ))}
                </div>
              )}

              {recipesLoading ? (
                <div className="rounded-2xl border border-hairline bg-card px-6 py-8 text-center">
                  <p className="text-sm text-ink-muted">Loading recipe…</p>
                </div>
              ) : selectedRecipe ? (
                <RecipeCard recipe={selectedRecipe} onCook={() => setCookRecipe(recipeToCookModeData(selectedRecipe))} />
              ) : (
                <div className="rounded-2xl border border-dashed border-hairline px-6 py-8 text-center">
                  <p className="text-sm text-ink-muted">
                    No saved recipe yet — ask how to make it in chat and save it here.
                  </p>
                </div>
              )}
            </section>

            {/* MEMORY: the distilled learnings summary. */}
            <section className="rounded-2xl border border-hairline bg-card px-5 py-4 shadow-card">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Memory</h2>
              {memoryLoading ? (
                <p className="mt-3 text-sm text-ink-muted">Thinking it over…</p>
              ) : memory?.unavailable ? (
                <p className="mt-3 text-sm text-ink-muted">Local model unavailable — is Ollama running?</p>
              ) : !memory?.bullets || memory.bullets.length === 0 ? (
                <p className="mt-3 text-sm text-ink-muted">Nothing distilled yet.</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {memory.bullets.map((bullet, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                      <span>{renderMarkdownLite(bullet)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ATTEMPT HISTORY: the flat log — secondary, collapsed by default. */}
            <AttemptHistorySection attempts={attempts} loading={attemptsLoading} />

            {/* Scoped ask/log — no longer the main focus, so bounded in height. */}
            <section className="flex h-[26rem] min-h-0 flex-col rounded-2xl border border-hairline bg-card px-4 pt-2 shadow-card">
              <ChatPanel
                dish={dish}
                onLogged={handleLogged}
                onRecipeSaved={refreshRecipes}
                onCookRecipe={setCookRecipe}
                placeholder={`Log another attempt at ${dish}, or ask about it…`}
                emptyTitle={`Log another attempt at ${dish}, or ask about it — try either:`}
                emptyExample="another go today, tweaked the timing, turned out great, 8/10"
              />
            </section>
          </div>
        </div>
      </div>

      {cookRecipe && <CookDrawer recipe={cookRecipe} onExit={() => setCookRecipe(null)} />}
    </div>
  );
}

function RecipeCard({ recipe, onCook }: { recipe: Recipe; onCook: () => void }) {
  return (
    <div className="rounded-2xl border border-hairline bg-card px-6 py-6 shadow-lift">
      {recipe.summary && <p className="mb-5 text-sm leading-relaxed text-ink-muted">{recipe.summary}</p>}

      {recipe.ingredients.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-faint">Ingredients</h3>
          <ul className="space-y-1.5">
            {recipe.ingredients.map((ingredient, i) => (
              <li key={i} className="text-sm text-ink">
                {ingredient.item}
                {ingredient.amount && <span className="text-ink-muted"> — {ingredient.amount}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recipe.steps.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-faint">Steps</h3>
          <ol className="space-y-2">
            {recipe.steps.map((step, i) => (
              <li key={i} className="text-sm leading-relaxed text-ink">
                <span className="mr-2 font-mono text-xs text-ink-faint">{i + 1}.</span>
                {step.text}
              </li>
            ))}
          </ol>
        </div>
      )}

      <button
        type="button"
        onClick={onCook}
        className="mt-6 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-paper transition-opacity hover:opacity-90"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3c1.5 2 1.5 3.5 0 5-1.5 1.5-1.5 3 0 4.5m-4-7c1.2 1.6 1.2 2.8 0 4-1.2 1.2-1.2 2.4 0 3.6M6 21c0-5 2.5-7 6-7s6 2 6 7"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Let&apos;s cook this
      </button>
    </div>
  );
}

function AttemptHistorySection({ attempts, loading }: { attempts: Attempt[]; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="rounded-2xl border border-hairline bg-card px-5 py-4 shadow-card">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          Attempt history{attempts.length > 0 && ` (${attempts.length})`}
        </h2>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className={`shrink-0 text-ink-faint transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded &&
        (loading ? (
          <p className="mt-3 text-sm text-ink-muted">Loading…</p>
        ) : attempts.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No attempts logged yet.</p>
        ) : (
          <div className="mt-3 divide-y divide-hairline">
            {attempts.map((attempt) => (
              <div key={attempt.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <RatingChip rating={attempt.rating} />
                  {(attempt.changes || attempt.outcome) && (
                    <p className="truncate text-sm text-ink">
                      {[attempt.changes, attempt.outcome].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                {attempt.analysis && (
                  <p className="mt-1 text-sm italic text-ink-muted">{attempt.analysis}</p>
                )}
                <span className="font-mono text-[11px] text-ink-faint">{attempt.cooked_at}</span>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
