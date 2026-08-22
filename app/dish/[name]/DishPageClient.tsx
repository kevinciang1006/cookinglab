"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CookRecipe } from "@/lib/cooking";
import { ChatPanel, CookModeScreen, renderMarkdownLite } from "@/app/components/shared";
import type { DishMemoryResponse } from "@/app/api/dish/[name]/memory/route";

export default function DishPageClient({ dish }: { dish: string }) {
  const router = useRouter();
  const [cookRecipe, setCookRecipe] = useState<CookRecipe | null>(null);
  const [memory, setMemory] = useState<DishMemoryResponse | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(true);

  async function refreshMemory() {
    setMemoryLoading(true);
    try {
      const res = await fetch(`/api/dish/${encodeURIComponent(dish)}/memory`);
      if (res.ok) setMemory(await res.json());
    } finally {
      setMemoryLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard refetch-on-param-change; refreshMemory guards itself via `finally`.
    refreshMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dish]);

  // Regeneration happens server-side in the background (see app/api/chat's
  // `after()` call) after a log succeeds — it isn't done the instant the
  // client hears back, so give it a moment before refetching.
  function handleLogged() {
    setTimeout(refreshMemory, 4000);
  }

  if (cookRecipe) {
    return <CookModeScreen recipe={cookRecipe} onExit={() => setCookRecipe(null)} />;
  }

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="mx-auto w-full max-w-5xl px-4 pt-4 pb-4 sm:pt-8">
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
          {memory && (
            <span className="font-mono text-sm text-ink-faint">
              {memory.attemptCount} attempt{memory.attemptCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 w-16 shrink-0 rounded-xl border border-dashed border-hairline bg-card"
            />
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 pb-10 lg:grid-cols-[1fr_20rem]">
          <div className="flex min-h-[60vh] flex-col">
            <ChatPanel
              dish={dish}
              onLogged={handleLogged}
              onCookRecipe={setCookRecipe}
              placeholder={`Log another attempt at ${dish}, or ask about it…`}
              emptyTitle={`Log another attempt at ${dish}, or ask about it — try either:`}
              emptyExample="another go today, tweaked the timing, turned out great, 8/10"
            />
          </div>

          <aside className="pb-6 lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-2xl border border-hairline bg-card px-5 py-4 shadow-card">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                Memory
              </h2>
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
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
