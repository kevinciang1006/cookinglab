"use client";

import { useEffect, useRef, useState } from "react";
import type { Attempt, AttemptMatch, AskPath } from "@/lib/cooking";
import type { ChatResponse, ChatPhase, ChatStreamEvent, ChatStreamMeta } from "@/app/api/chat/route";
import { generateId } from "@/lib/id";
import { MarkdownMessage } from "@/app/components/MarkdownMessage";
import { parseRecipeMarkdown, type ParsedRecipe } from "@/lib/parseRecipeMarkdown";

// Cook-mode's own data shape — a superset of the backend's CookRecipe with
// the user's own logged learnings attached, whichever path produced it: the
// dedicated cook-along backend flow (learnings: [], nothing to attach) or
// "Let's cook this" on a regular answer card (learnings from that answer's
// blockquote callouts, via parseRecipeMarkdown).
export type CookModeData = ParsedRecipe;

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
  | {
      id: string;
      role: "assistant";
      // null while waiting on a silent pre-generation step — the status
      // pill (see StatusPill) renders instead of a response in that state.
      response: AssistantResponse | null;
      phase: ChatPhase | null;
      streaming: boolean;
    };

// If the stream goes fully silent for this long (no event at all — not
// even a status update), something's stuck server-side; give up rather
// than spin forever. Generation, once it starts, sends chunks far more
// often than this, so a real gap this long only happens on a genuine
// stall/hang, not normal slowness.
const STREAM_STALL_MS = 45_000;

// Fallback if a "token" somehow arrives with no cached "meta" (shouldn't
// happen — the server always emits meta before the first token — but this
// keeps the turn renderable instead of throwing if it ever does).
const DEFAULT_ASK_META: ChatStreamMeta = { type: "ask", path: "RETRIEVE", matches: [], savable: false };

/**
 * Reads the unified SSE stream from POST /api/chat and progressively
 * updates the one turn it belongs to: "status" sets the loading pill's
 * phase, "meta" fills in path/matches/savable the moment it arrives, each
 * "token" appends to the answer text (MarkdownMessage re-renders live),
 * "result" delivers a non-streamed outcome (log confirmation, or a cook
 * recipe — which never becomes a turn, see onCookRecipe below), "error"
 * replaces the pill/answer with a calm message, and "done"/stream-end/stall
 * clears the streaming flag. Malformed chunks are skipped rather than
 * crashing the turn.
 */
async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  turnId: string,
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>,
  onCookRecipe: (recipe: CookModeData) => void,
  onLogged: (() => void) | undefined
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  // "meta" arrives before the model has actually produced anything —
  // cached here rather than applied to the turn immediately, so the status
  // pill (not an empty answer card with just a path tag and no text) stays
  // on screen until the first token actually lands.
  let pendingMeta: ChatStreamMeta | null = null;
  let firstTokenSeen = false;

  function apply(event: ChatStreamEvent) {
    if (event.type === "status") {
      setTurns((prev) => prev.map((t) => (t.id === turnId && t.role === "assistant" ? { ...t, phase: event.phase } : t)));
    } else if (event.type === "meta") {
      pendingMeta = event.meta;
    } else if (event.type === "token") {
      answer += event.text;
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turnId || t.role !== "assistant") return t;
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            return { ...t, phase: null, response: { ...(pendingMeta ?? DEFAULT_ASK_META), answer } };
          }
          return t.response?.type === "ask" ? { ...t, response: { ...t.response, answer } } : t;
        })
      );
    } else if (event.type === "result") {
      const response = event.response;
      if (response.type === "cook") {
        // Cook responses never become a turn — remove the placeholder pill
        // turn and hand off to cook mode instead, same as the plain-JSON
        // path below. No learnings field from this backend flow.
        setTurns((prev) => prev.filter((t) => t.id !== turnId));
        onCookRecipe({ ...response.recipe, learnings: [] });
        return;
      }
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId && t.role === "assistant" ? { ...t, phase: null, response, streaming: false } : t))
      );
      if (response.type === "log" && response.saved) onLogged?.();
    } else if (event.type === "error") {
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turnId || t.role !== "assistant") return t;
          const response: AssistantResponse =
            t.response?.type === "ask"
              ? { ...t.response, answer: event.message }
              : { type: "ask", path: "RETRIEVE", answer: event.message, matches: [], savable: false };
          return { ...t, phase: null, streaming: false, response };
        })
      );
    } else if (event.type === "done") {
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)));
    }
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      apply({ type: "error", message: "Taking too long — try again in a bit." });
      reader.cancel().catch(() => {});
    }, STREAM_STALL_MS);
  }

  try {
    resetWatchdog();
    while (true) {
      const { value, done } = await reader.read();
      if (stalled) break;
      resetWatchdog();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const dataMatch = rawEvent.match(/^data: (.+)$/m);
        if (!dataMatch) continue;
        try {
          apply(JSON.parse(dataMatch[1]) as ChatStreamEvent);
        } catch {
          // Malformed chunk — skip it rather than crashing the stream.
        }
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    // Belt-and-suspenders: clear the streaming flag even if the connection
    // dropped mid-flight without an explicit "done"/"error" event.
    setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)));
  }
}

export function ChatPanel({
  dish,
  onLogged,
  onRecipeSaved,
  onCookRecipe,
  placeholder,
  emptyTitle,
  emptyExample,
}: {
  dish?: string;
  onLogged?: () => void;
  /** Called after "Save as recipe" successfully saves — e.g. the dish page refetches its recipe list. */
  onRecipeSaved?: () => void;
  onCookRecipe: (recipe: CookModeData) => void;
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

      // Every real outcome streams now (status pills before/instead of
      // dead air); only the earliest, pre-classification failures (bad
      // request body, empty message) stay a single plain JSON response —
      // detect which this is.
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && res.body) {
        const turnId = generateId();
        // Optimistic initial phase — the server's own first event is
        // always "classifying" too, arriving a moment later; starting here
        // means the pill is on screen the instant the turn exists, with no
        // round-trip wait even for that first status update.
        setTurns((prev) => [
          ...prev,
          { id: turnId, role: "assistant", response: null, phase: "classifying", streaming: true },
        ]);
        await consumeChatStream(res.body, turnId, setTurns, onCookRecipe, onLogged);
        return;
      }

      const data: ChatResponse = await res.json();

      if (data.type === "cook") {
        // The dedicated cook-along backend flow returns a plain CookRecipe
        // (no learnings field) — nothing to pin at the top of the drawer
        // for this path.
        onCookRecipe({ ...data.recipe, learnings: [] });
        return;
      }

      setTurns((prev) => [...prev, { id: generateId(), role: "assistant", response: data, phase: null, streaming: false }]);
      if (data.type === "log" && data.saved) {
        onLogged?.();
      }
    } catch {
      setTurns((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "assistant",
          phase: null,
          streaming: false,
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
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-w-0 flex-1 space-y-4 py-4">
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
                phase={turn.phase}
                streaming={turn.streaming}
                saving={savingId === turn.id}
                saved={savedIds.has(turn.id)}
                onSave={() =>
                  turn.response?.type === "ask" && handleSaveGenerated(turn.id, turn.response.answer)
                }
                onCookRecipe={onCookRecipe}
                onRecipeSaved={onRecipeSaved}
                dish={dish}
              />
            )
          )
        )}
        {/* Once a streaming turn is on screen, its growing text + cursor
            (see AssistantTurn) IS the loading indicator — this generic one
            only covers the round-trip before that turn exists yet. */}
        {pending && !turns.some((t) => t.role === "assistant" && t.streaming) && (
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

const PHASE_LABELS: Record<ChatPhase, string> = {
  classifying: "Reading your message…",
  searching: "Searching your log…",
  thinking: "Writing…",
  logging: "Logging…",
};

/** The loading indicator for a turn with no response yet — replaces the old silent gap before/between classification, retrieval, and the model call. */
function StatusPill({ phase }: { phase: ChatPhase }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-hairline bg-card px-4 py-2 text-sm text-ink-muted shadow-card">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      {PHASE_LABELS[phase]}
    </div>
  );
}

function AssistantTurn({
  response,
  phase,
  streaming,
  saving,
  saved,
  onSave,
  onCookRecipe,
  onRecipeSaved,
  dish,
}: {
  response: AssistantResponse | null;
  phase: ChatPhase | null;
  streaming: boolean;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  onCookRecipe: (recipe: CookModeData) => void;
  onRecipeSaved?: () => void;
  /** Dish-scoped chat forces the recipe's dish to this, same as LOG's auto-tagging — see /api/recipes. */
  dish?: string;
}) {
  const [showVariationInput, setShowVariationInput] = useState(false);
  const [variationLabel, setVariationLabel] = useState("");
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [recipeSaved, setRecipeSaved] = useState(false);

  if (response === null) {
    return <StatusPill phase={phase ?? "thinking"} />;
  }

  if (response.type === "log") {
    if (response.saved && response.attempt) {
      return <AttemptCard attempt={response.attempt} />;
    }
    return <p className="px-1 text-sm italic text-ink-muted">{response.reply}</p>;
  }

  // response.type === "ask" — while streaming, re-parsing on every chunk is
  // cheap (plain string scans) and lets "Let's cook this"/"Save as recipe"
  // appear the instant the step list finishes, not just once the whole
  // answer lands.
  const recipe = parseRecipeMarkdown(response.answer);

  async function handleSaveRecipe() {
    if (savingRecipe || recipeSaved || response?.type !== "ask") return;
    setSavingRecipe(true);
    try {
      const res = await fetch("/api/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAnswer: response.answer,
          variationLabel: variationLabel.trim() || null,
          ...(dish && { dish }),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setRecipeSaved(true);
        setShowVariationInput(false);
        onRecipeSaved?.();
      }
    } finally {
      setSavingRecipe(false);
    }
  }

  return (
    <div className="min-w-0 rounded-2xl border border-hairline bg-card px-6 py-6 shadow-lift">
      <PathTag path={response.path} />
      <div className="mt-4">
        <MarkdownMessage content={response.answer} />
        {streaming && (
          <span
            aria-hidden
            className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent align-middle"
          />
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {response.savable && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving || saved}
            className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-60"
          >
            {saved ? "Saved to log ✓" : saving ? "Saving…" : "Save to log"}
          </button>
        )}

        {!streaming && recipe && (
          <button
            type="button"
            onClick={() => onCookRecipe(recipe)}
            className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-paper px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
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
        )}

        {!streaming && recipe && !recipeSaved && !showVariationInput && (
          <button
            type="button"
            onClick={() => setShowVariationInput(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-paper px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Save as recipe
          </button>
        )}

        {recipeSaved && (
          <span className="inline-flex items-center rounded-xl border border-hairline bg-paper px-5 py-2.5 text-sm font-medium text-ink-muted">
            Saved as recipe ✓
          </span>
        )}
      </div>

      {showVariationInput && !recipeSaved && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-hairline bg-paper px-4 py-3">
          <input
            type="text"
            value={variationLabel}
            onChange={(e) => setVariationLabel(e.target.value)}
            placeholder="Variation (optional) — e.g. ayam kampung, pressure cooker"
            className="min-w-0 flex-1 rounded-lg border border-hairline bg-card px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={handleSaveRecipe}
            disabled={savingRecipe}
            className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-paper disabled:opacity-60"
          >
            {savingRecipe ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setShowVariationInput(false)}
            disabled={savingRecipe}
            className="shrink-0 rounded-lg border border-hairline px-3 py-1.5 text-sm text-ink-muted disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      )}

      <SourcesStrip matches={response.matches} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cook mode — a right-side drawer alongside the chat (mobile: a full-screen
// overlay instead, via responsive classes below), not a separate page.
// Resizable/collapsible/closable on desktop; the chat stays usable while
// it's open since it's a flex sibling, not something that replaces the page.
// ---------------------------------------------------------------------------

type CookStepState = { text: string; minutes: number | null; done: boolean };

const DRAWER_MIN_WIDTH = 360;
const DRAWER_MAX_WIDTH = 640;
const DRAWER_DEFAULT_WIDTH = 440;

/** Drag-to-resize the drawer's width from its left edge (desktop only — mobile is always full-width). */
function useDrawerWidth() {
  const [width, setWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const draggingRef = useRef(false);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const next = window.innerWidth - e.clientX;
      setWidth(Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, next)));
    }
    function onMouseUp() {
      draggingRef.current = false;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return { width, startResize: () => (draggingRef.current = true) };
}

export function CookDrawer({ recipe, onExit }: { recipe: CookModeData; onExit: () => void }) {
  const [steps, setSteps] = useState<CookStepState[]>(() =>
    recipe.steps.map((s) => ({ ...s, done: false }))
  );
  const [checkedIngredients, setCheckedIngredients] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const { width, startResize } = useDrawerWidth();

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

  // Collapsed: a slim rail, not fully closed — checklist/timer state is
  // preserved (nothing unmounts), just tucked out of the way. Desktop only;
  // the toggle that reaches this state is itself desktop-only (see below).
  if (collapsed) {
    return (
      <div className="hidden shrink-0 flex-col items-center gap-4 border-l border-hairline bg-card py-4 sm:flex sm:w-12">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand cook mode"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline text-ink-muted hover:text-accent"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* Decorative only — pointer-events-none so the rotated box (CSS
            transforms don't reflow layout) can't shadow-click the expand
            button above it; confirmed this was happening without it. */}
        <span className="pointer-events-none origin-center rotate-90 whitespace-nowrap font-mono text-[11px] uppercase tracking-wide text-ink-faint">
          {recipe.dish}
        </span>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex w-full flex-col border-hairline bg-paper sm:static sm:inset-auto sm:z-auto sm:h-full sm:w-[var(--cook-drawer-width)] sm:shrink-0 sm:border-l sm:shadow-lift"
      style={{ "--cook-drawer-width": `${width}px` } as React.CSSProperties}
    >
      {/* Resize handle — desktop only, drags the left edge. */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          startResize();
        }}
        className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize sm:block hover:bg-accent/30"
      />

      <div className="flex items-center gap-3 border-b border-hairline px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 sm:pt-4">
        <button
          type="button"
          onClick={onExit}
          aria-label="Close cook mode"
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
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse cook mode"
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline text-ink-muted hover:text-accent sm:flex"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-5">
          {recipe.learnings.length > 0 && (
            <div className="sticky top-0 z-10 mb-6 rounded-2xl border-l-[3px] border-accent bg-accent-soft px-5 py-4 shadow-card">
              <h2 className="font-mono text-[11px] uppercase tracking-wide text-accent">
                Your key learnings
              </h2>
              <ul className="mt-2 space-y-1.5">
                {recipe.learnings.map((learning, i) => (
                  <li key={i} className="text-sm leading-relaxed text-ink">
                    {learning}
                  </li>
                ))}
              </ul>
            </div>
          )}

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
