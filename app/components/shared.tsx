"use client";

import { useEffect, useState } from "react";
import type { Attempt, AttemptMatch, AskPath, CookRecipe } from "@/lib/cooking";
import type { ChatResponse } from "@/app/api/chat/route";
import { generateId } from "@/lib/id";

// ---------------------------------------------------------------------------
// Shared across the main Chat tab and dish detail pages (v1d): the chat
// panel itself, its message rendering, cook-mode, and small display bits.
// ---------------------------------------------------------------------------

// Lightweight bold/italic (markdown-style) rendering for model output — not
// a full markdown parser by design.
export function renderMarkdownLite(text: string): React.ReactNode {
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    }
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={key++} className="font-semibold text-ink">
          {match[1]}
        </strong>
      );
    } else if (match[2] !== undefined) {
      nodes.push(<em key={key++}>{match[2]}</em>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }
  return nodes;
}

export function RatingChip({ rating }: { rating: number | null }) {
  if (rating == null) return null;
  return (
    <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-xs font-semibold text-accent">
      {rating}/10
    </span>
  );
}

export function AttemptCard({ attempt }: { attempt: Attempt }) {
  return (
    <div className="rounded-2xl border border-hairline bg-card px-5 py-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-base font-medium text-ink">{attempt.dish}</span>
        <RatingChip rating={attempt.rating} />
      </div>
      {(attempt.changes || attempt.outcome || attempt.analysis) && (
        <div className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          {attempt.changes && (
            <>
              <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                changes
              </span>
              <span className="text-ink">{attempt.changes}</span>
            </>
          )}
          {attempt.outcome && (
            <>
              <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                outcome
              </span>
              <span className="text-ink">{attempt.outcome}</span>
            </>
          )}
          {attempt.analysis && (
            <>
              <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                analysis
              </span>
              <span className="italic text-ink-muted">{attempt.analysis}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function PathTag({ path }: { path: AskPath }) {
  const label =
    path === "GENERATE"
      ? "New — not from your log"
      : path === "ADAPT"
        ? "Adapted from your log"
        : "From your log";
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wide ${
        path === "GENERATE"
          ? "bg-accent-soft text-accent"
          : "border border-hairline text-ink-muted"
      }`}
    >
      {label}
    </span>
  );
}

export function SourcesStrip({ matches }: { matches: AttemptMatch[] }) {
  if (matches.length === 0) return null;
  return (
    <div className="mt-6">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
        Sources
      </p>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {matches.map((match) => (
          <div
            key={match.id}
            className="flex shrink-0 items-center gap-2 rounded-full border border-hairline bg-paper px-3 py-1.5"
          >
            <span className="font-mono text-xs text-ink">{match.dish}</span>
            <span className="font-mono text-[11px] text-ink-faint">
              {(match.similarity * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified chat panel (v1d) — one message box, one endpoint (/api/chat).
// Used both unscoped (main Chat tab) and dish-scoped (dish detail page).
// ---------------------------------------------------------------------------

// "cook" responses never become a turn — ChatPanel intercepts them and
// hands off to onCookRecipe instead (see handleSend below).
type AssistantResponse = Exclude<ChatResponse, { type: "cook" }>;

type ChatTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; response: AssistantResponse };

export function ChatPanel({
  dish,
  onLogged,
  onCookRecipe,
  placeholder,
  emptyTitle,
  emptyExample,
}: {
  dish?: string;
  onLogged?: () => void;
  onCookRecipe: (recipe: CookRecipe) => void;
  placeholder: string;
  emptyTitle: string;
  emptyExample: string;
}) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  async function handleSend() {
    const text = input.trim();
    if (!text || pending) return;

    setTurns((prev) => [...prev, { id: generateId(), role: "user", text }]);
    setInput("");
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dish ? { message: text, dish } : { message: text }),
      });
      const data: ChatResponse = await res.json();

      if (data.type === "cook") {
        onCookRecipe(data.recipe);
        return;
      }

      setTurns((prev) => [...prev, { id: generateId(), role: "assistant", response: data }]);
      if (data.type === "log" && data.saved) {
        onLogged?.();
      }
    } catch {
      setTurns((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "assistant",
          response: {
            type: "ask",
            path: "RETRIEVE",
            answer: "Couldn't reach the server — try again.",
            matches: [],
            savable: false,
          },
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSaveGenerated(turnId: string, answer: string) {
    if (savingId) return;
    setSavingId(turnId);
    try {
      const res = await fetch("/api/ask/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      const data = await res.json();
      if (data.ok) {
        setSavedIds((prev) => new Set(prev).add(turnId));
        onLogged?.();
      }
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4 py-4">
        {turns.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline px-5 py-5">
            <p className="text-sm text-ink-muted">{emptyTitle}</p>
            <p className="mt-2 font-mono text-sm leading-relaxed text-ink">{emptyExample}</p>
          </div>
        ) : (
          turns.map((turn) =>
            turn.role === "user" ? (
              <div key={turn.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-paper">
                  {turn.text}
                </div>
              </div>
            ) : (
              <AssistantTurn
                key={turn.id}
                response={turn.response}
                saving={savingId === turn.id}
                saved={savedIds.has(turn.id)}
                onSave={() =>
                  turn.response.type === "ask" && handleSaveGenerated(turn.id, turn.response.answer)
                }
              />
            )
          )
        )}
        {pending && (
          <div className="flex items-center gap-2 px-1 font-mono text-xs text-ink-muted">
            <span className="animate-pulse">●</span> thinking…
          </div>
        )}
      </div>

      <div className="sticky bottom-0 bg-paper pt-2 pb-4">
        <div className="flex items-end gap-2 rounded-2xl border border-hairline bg-card p-2 shadow-card">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={pending}
            placeholder={placeholder}
            className="flex-1 rounded-xl bg-transparent px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={pending || !input.trim()}
            className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({
  response,
  saving,
  saved,
  onSave,
}: {
  response: AssistantResponse;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  if (response.type === "log") {
    if (response.saved && response.attempt) {
      return <AttemptCard attempt={response.attempt} />;
    }
    return <p className="px-1 text-sm italic text-ink-muted">{response.reply}</p>;
  }

  // response.type === "ask"
  return (
    <div className="rounded-2xl border border-hairline bg-card px-6 py-6 shadow-lift">
      <PathTag path={response.path} />
      <p className="mt-4 text-lg leading-relaxed text-ink">{renderMarkdownLite(response.answer)}</p>

      {response.savable && (
        <button
          type="button"
          onClick={onSave}
          disabled={saving || saved}
          className="mt-5 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-60"
        >
          {saved ? "Saved to log ✓" : saving ? "Saving…" : "Save to log"}
        </button>
      )}

      <SourcesStrip matches={response.matches} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cook mode — a full-screen takeover, not another card in the feed.
// ---------------------------------------------------------------------------

type CookStepState = { text: string; minutes: number | null; done: boolean };

export function CookModeScreen({ recipe, onExit }: { recipe: CookRecipe; onExit: () => void }) {
  const [steps, setSteps] = useState<CookStepState[]>(() =>
    recipe.steps.map((s) => ({ ...s, done: false }))
  );
  const [checkedIngredients, setCheckedIngredients] = useState<Set<number>>(new Set());

  function toggleStep(index: number) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, done: !s.done } : s)));
  }

  function toggleIngredient(index: number) {
    setCheckedIngredients((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-paper">
      <div className="flex items-center gap-3 border-b border-hairline px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 sm:pt-4">
        <button
          type="button"
          onClick={onExit}
          aria-label="Exit cook mode"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-ink-muted shadow-card hover:text-accent"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Cook mode</p>
          <h1 className="truncate text-lg font-semibold tracking-tight text-ink sm:text-xl">
            {recipe.dish}
          </h1>
        </div>
        <span className="ml-auto shrink-0 font-mono text-xs text-ink-muted">
          {doneCount}/{steps.length} steps
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-5">
          {recipe.ingredients && recipe.ingredients.length > 0 && (
            <div className="mb-6 rounded-2xl border border-hairline bg-card px-5 py-4 shadow-card">
              <h2 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                Ingredients
              </h2>
              <ul className="mt-3 space-y-2">
                {recipe.ingredients.map((ingredient, i) => (
                  <li key={i}>
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={checkedIngredients.has(i)}
                        onChange={() => toggleIngredient(i)}
                        className="mt-0.5 h-4 w-4 accent-accent"
                      />
                      <span
                        className={
                          checkedIngredients.has(i) ? "text-ink-muted line-through" : "text-ink"
                        }
                      >
                        {ingredient}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
            Steps
          </h2>
          <ol className="space-y-3">
            {steps.map((step, i) => (
              <CookStepCard key={i} step={step} index={i} onToggle={() => toggleStep(i)} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function CookStepCard({
  step,
  index,
  onToggle,
}: {
  step: CookStepState;
  index: number;
  onToggle: () => void;
}) {
  return (
    <li
      className={`rounded-2xl border px-5 py-4 shadow-card transition-colors ${
        step.done ? "border-hairline bg-paper" : "border-hairline bg-card"
      }`}
    >
      <label className="flex items-start gap-4">
        <input
          type="checkbox"
          checked={step.done}
          onChange={onToggle}
          className="mt-1.5 h-5 w-5 shrink-0 accent-accent"
        />
        <div className="min-w-0 flex-1">
          <p
            className={`text-lg leading-relaxed ${
              step.done ? "text-ink-muted line-through" : "text-ink"
            }`}
          >
            <span className="mr-2 font-mono text-sm text-ink-faint">{index + 1}.</span>
            {renderMarkdownLite(step.text)}
          </p>
          {step.minutes != null && <StepTimer minutes={step.minutes} />}
        </div>
      </label>
    </li>
  );
}

function StepTimer({ minutes }: { minutes: number }) {
  const totalSeconds = Math.round(minutes * 60);
  const [remaining, setRemaining] = useState(totalSeconds);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setRunning(false);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const done = remaining <= 0;

  function toggle() {
    if (done) {
      setRemaining(totalSeconds);
      setRunning(true);
    } else {
      setRunning((r) => !r);
    }
  }

  function reset() {
    setRunning(false);
    setRemaining(totalSeconds);
  }

  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;

  return (
    <div className="mt-3 flex items-center gap-3">
      <span
        className={`rounded-full px-3 py-1 font-mono text-base tabular-nums ${
          done ? "bg-accent-soft font-semibold text-accent" : "bg-paper text-ink"
        }`}
      >
        {mm}:{String(ss).padStart(2, "0")}
      </span>
      <button
        type="button"
        onClick={toggle}
        className="rounded-full border border-hairline px-3 py-1 font-mono text-xs text-ink-muted hover:text-accent"
      >
        {done ? "restart" : running ? "pause" : "start"}
      </button>
      {!done && remaining !== totalSeconds && (
        <button
          type="button"
          onClick={reset}
          className="font-mono text-xs text-ink-muted underline decoration-dotted hover:text-accent"
        >
          reset
        </button>
      )}
    </div>
  );
}
