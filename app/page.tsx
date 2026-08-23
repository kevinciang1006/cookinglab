"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Attempt, AttemptKind, DishActivity } from "@/lib/cooking";
import { ChatPanel, CookDrawer, RatingChip, type CookModeData } from "@/app/components/shared";

type TabId = "chat" | "recent";

const TABS: { id: TabId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "recent", label: "Recent" },
];

const TAB_TITLES: Record<TabId, string> = {
  chat: "Cooking Lab",
  recent: "Continue",
};

type EditDraft = {
  dish: string;
  changes: string;
  outcome: string;
  analysis: string;
  target: string;
  rating: string;
  kind: AttemptKind;
};

// ---------------------------------------------------------------------------
// Home — owns Recent's state/handlers and the cook-mode takeover. Chat
// itself (Log + Ask merged, v1d) is the shared <ChatPanel />; it owns its
// own conversation state.
// ---------------------------------------------------------------------------

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [cookRecipe, setCookRecipe] = useState<CookModeData | null>(null);

  const [recent, setRecent] = useState<Attempt[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);

  const [dishes, setDishes] = useState<DishActivity[]>([]);
  const [dishesLoading, setDishesLoading] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function refreshRecent() {
    try {
      const res = await fetch("/api/attempts");
      if (res.ok) setRecent(await res.json());
    } finally {
      setRecentLoading(false);
    }
  }

  async function refreshDishes() {
    try {
      const res = await fetch("/api/dishes");
      if (res.ok) setDishes(await res.json());
    } finally {
      setDishesLoading(false);
    }
  }

  useEffect(() => {
    refreshRecent();
    refreshDishes();
  }, []);

  useEffect(() => {
    // Continue reflects activity from anywhere in the app (a recipe saved
    // from chat, an attempt logged on a dish page) — refetch it fresh each
    // time this tab is actually viewed, rather than trying to thread an
    // invalidation callback through every place that can create activity.
    if (activeTab === "recent") refreshDishes();
  }, [activeTab]);

  function startEdit(attempt: Attempt) {
    setEditingId(attempt.id);
    setEditDraft({
      dish: attempt.dish,
      changes: attempt.changes ?? "",
      outcome: attempt.outcome ?? "",
      analysis: attempt.analysis ?? "",
      target: attempt.target ?? "",
      rating: attempt.rating != null ? String(attempt.rating) : "",
      kind: attempt.kind,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  async function saveEdit(id: string) {
    if (!editDraft || editSaving) return;
    setEditSaving(true);
    try {
      const rating = editDraft.rating.trim() === "" ? null : Number(editDraft.rating);
      const res = await fetch(`/api/attempts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dish: editDraft.dish.trim(),
          changes: editDraft.changes.trim() || null,
          outcome: editDraft.outcome.trim() || null,
          analysis: editDraft.analysis.trim() || null,
          target: editDraft.target.trim() || null,
          rating,
          kind: editDraft.kind,
        }),
      });
      if (res.ok) {
        cancelEdit();
        await refreshRecent();
      }
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this attempt? This can't be undone.")) return;
    setDeletingId(id);
    try {
      await fetch(`/api/attempts/${id}`, { method: "DELETE" });
      if (editingId === id) cancelEdit();
      await refreshRecent();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    // Cook mode is a drawer alongside this, not a takeover — see CookDrawer:
    // a flex sibling here, fixed full-screen on mobile via its own classes.
    <div className="flex h-dvh bg-paper">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="mx-auto w-full max-w-2xl px-4 pt-4 pb-2 sm:pt-8 sm:pb-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
            Cooking Lab
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            {TAB_TITLES[activeTab]}
          </h1>
        </header>

        <nav className="mx-auto hidden w-full max-w-2xl px-4 pb-4 sm:block">
          <TabBar activeTab={activeTab} onChange={setActiveTab} />
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col px-4 pb-28 sm:pb-10">
            {activeTab === "chat" && (
              <ChatPanel
                onLogged={refreshRecent}
                onCookRecipe={setCookRecipe}
                placeholder="Log a cook, or ask about your log…"
                emptyTitle="Log a cook, or ask about your log — try either:"
                emptyExample="siobak attempt 4, oven 180 last 10 min, crackling worked, 8/10"
              />
            )}

            {activeTab === "recent" && (
              <RecentTab
                recent={recent}
                loading={recentLoading}
                dishes={dishes}
                dishesLoading={dishesLoading}
                editingId={editingId}
                editDraft={editDraft}
                editSaving={editSaving}
                deletingId={deletingId}
                onEdit={startEdit}
                onCancelEdit={cancelEdit}
                onSaveEdit={saveEdit}
                onChangeDraft={setEditDraft}
                onDelete={handleDelete}
              />
            )}
          </div>
        </div>

        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
          <TabBar activeTab={activeTab} onChange={setActiveTab} variant="bottom" />
        </nav>
      </div>

      {cookRecipe && <CookDrawer recipe={cookRecipe} onExit={() => setCookRecipe(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

function TabBar({
  activeTab,
  onChange,
  variant = "top",
}: {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  variant?: "top" | "bottom";
}) {
  if (variant === "bottom") {
    return (
      <div className="mx-auto flex w-full max-w-2xl items-stretch justify-around">
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium transition-colors ${
                active ? "text-accent" : "text-ink-faint"
              }`}
            >
              <TabIcon tab={tab.id} active={active} />
              {tab.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="inline-flex gap-1 rounded-full border border-hairline bg-card p-1 shadow-card">
      {TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-accent text-paper" : "text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function TabIcon({ tab, active }: { tab: TabId; active: boolean }) {
  const stroke = active ? "var(--accent)" : "var(--ink-faint)";
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none" as const };

  if (tab === "chat") {
    return (
      <svg {...common} aria-hidden>
        <path
          d="M12 3.5v3M12 17.5v3M20.5 12h-3M6.5 12h-3M17.5 6.5l-2 2M8.5 15.5l-2 2M17.5 17.5l-2-2M8.5 8.5l-2-2"
          stroke={stroke}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden>
      <circle cx="12" cy="12" r="8" stroke={stroke} strokeWidth={1.6} />
      <path d="M12 8v4.5l3 2" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Recent tab — grouped by dish, card treatment with breathing room. Each
// card navigates to /dish/[name]; edit/delete stop that propagation.
// ---------------------------------------------------------------------------

type DishGroup = { dish: string; attempts: Attempt[] };

function groupByDish(attempts: Attempt[]): DishGroup[] {
  const order: string[] = [];
  const map = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if (!map.has(a.dish)) {
      map.set(a.dish, []);
      order.push(a.dish);
    }
    map.get(a.dish)!.push(a);
  }
  return order.map((dish) => ({ dish, attempts: map.get(dish)! }));
}

function RecentTab({
  recent,
  loading,
  dishes,
  dishesLoading,
  editingId,
  editDraft,
  editSaving,
  deletingId,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onChangeDraft,
  onDelete,
}: {
  recent: Attempt[];
  loading: boolean;
  dishes: DishActivity[];
  dishesLoading: boolean;
  editingId: string | null;
  editDraft: EditDraft | null;
  editSaving: boolean;
  deletingId: string | null;
  onEdit: (attempt: Attempt) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string) => void;
  onChangeDraft: (draft: EditDraft) => void;
  onDelete: (id: string) => void;
}) {
  const router = useRouter();
  const groups = useMemo(() => groupByDish(recent), [recent]);

  if (loading && dishesLoading) {
    return <p className="py-8 text-center text-sm text-ink-muted">Loading…</p>;
  }

  if (!dishesLoading && dishes.length === 0 && recent.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-hairline px-5 py-8 text-center">
        <p className="text-sm text-ink-muted">Nothing logged yet — your first cook will show up here.</p>
      </div>
    );
  }

  return (
    <div className="py-4">
      <ContinueSection dishes={dishes} loading={dishesLoading} />

      {groups.length > 0 && (
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          All dishes
        </h2>
      )}

      <div className="space-y-4">
      {groups.map((group) => (
        <div
          key={group.dish}
          role="link"
          tabIndex={0}
          onClick={() => router.push(`/dish/${encodeURIComponent(group.dish)}`)}
          onKeyDown={(e) => {
            if (e.key === "Enter") router.push(`/dish/${encodeURIComponent(group.dish)}`);
          }}
          className="cursor-pointer overflow-hidden rounded-2xl border border-hairline bg-card shadow-card transition-shadow hover:shadow-lift"
        >
          <div className="flex items-baseline gap-2 border-b border-hairline px-4 py-3">
            <h3 className="font-mono text-base font-medium text-ink">{group.dish}</h3>
            {group.attempts.length > 1 && (
              <span className="font-mono text-xs text-ink-faint">×{group.attempts.length}</span>
            )}
          </div>
          <div className="divide-y divide-hairline">
            {group.attempts.map((attempt) =>
              editingId === attempt.id && editDraft ? (
                <div key={attempt.id} className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <EditRow
                    draft={editDraft}
                    saving={editSaving}
                    onChange={onChangeDraft}
                    onSave={() => onSaveEdit(attempt.id)}
                    onCancel={onCancelEdit}
                  />
                </div>
              ) : (
                <RecentEntryRow
                  key={attempt.id}
                  attempt={attempt}
                  deleting={deletingId === attempt.id}
                  onEdit={() => onEdit(attempt)}
                  onDelete={() => onDelete(attempt.id)}
                />
              )
            )}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}

function ContinueSection({ dishes, loading }: { dishes: DishActivity[]; loading: boolean }) {
  const router = useRouter();

  if (loading) {
    return <p className="mb-6 py-4 text-center text-sm text-ink-muted">Loading…</p>;
  }
  if (dishes.length === 0) return null;

  const top = dishes.slice(0, 5);

  return (
    <div className="mb-6">
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Continue</h2>
      <div className="space-y-3">
        {top.map((d) => (
          <div
            key={d.dish}
            role="link"
            tabIndex={0}
            onClick={() => router.push(`/dish/${encodeURIComponent(d.dish)}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") router.push(`/dish/${encodeURIComponent(d.dish)}`);
            }}
            className="cursor-pointer rounded-2xl border border-hairline bg-card px-4 py-3 shadow-card transition-shadow hover:shadow-lift"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-mono text-base font-medium text-ink">{d.dish}</h3>
              {d.hasRecipe && (
                <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent">
                  recipe
                </span>
              )}
              {d.attemptCount > 0 && (
                <span className="font-mono text-xs text-ink-faint">
                  {d.attemptCount} attempt{d.attemptCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-ink-muted">{d.lastActivityLabel}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentEntryRow({
  attempt,
  deleting,
  onEdit,
  onDelete,
}: {
  attempt: Attempt;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <RatingChip rating={attempt.rating} />
          {(attempt.changes || attempt.outcome) && (
            <p className="truncate text-sm text-ink">
              {[attempt.changes, attempt.outcome].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        {attempt.analysis && (
          <p className="mt-1 truncate text-sm italic text-ink-muted">{attempt.analysis}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5 text-ink-faint opacity-70 transition-opacity group-hover:text-ink-muted group-hover:opacity-100">
        <span className="font-mono text-[11px]">{attempt.cooked_at}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="font-mono text-[11px] underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          edit
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={deleting}
          className="font-mono text-[11px] underline decoration-dotted underline-offset-2 hover:text-accent disabled:opacity-50"
        >
          {deleting ? "…" : "delete"}
        </button>
      </div>
    </div>
  );
}

function EditRow({
  draft,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: EditDraft;
  saving: boolean;
  onChange: (draft: EditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  function set<K extends keyof EditDraft>(key: K, value: EditDraft[K]) {
    onChange({ ...draft, [key]: value });
  }

  const fieldClass =
    "w-full rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent";
  const labelClass = "font-mono text-[11px] uppercase tracking-wide text-ink-faint";

  return (
    <div>
      <div className="grid grid-cols-[5rem_1fr] items-center gap-x-3 gap-y-2">
        <label className={labelClass}>dish</label>
        <input value={draft.dish} onChange={(e) => set("dish", e.target.value)} className={fieldClass} />
        <label className={labelClass}>changes</label>
        <input value={draft.changes} onChange={(e) => set("changes", e.target.value)} className={fieldClass} />
        <label className={labelClass}>outcome</label>
        <input value={draft.outcome} onChange={(e) => set("outcome", e.target.value)} className={fieldClass} />
        <label className={labelClass}>analysis</label>
        <textarea
          value={draft.analysis}
          onChange={(e) => set("analysis", e.target.value)}
          rows={2}
          className={`${fieldClass} resize-none`}
        />
        <label className={labelClass}>target</label>
        <input value={draft.target} onChange={(e) => set("target", e.target.value)} className={fieldClass} />
        <label className={labelClass}>rating</label>
        <input
          value={draft.rating}
          onChange={(e) => set("rating", e.target.value)}
          inputMode="numeric"
          placeholder="1-10"
          className={fieldClass}
        />
        <label className={labelClass}>kind</label>
        <select value={draft.kind} onChange={(e) => set("kind", e.target.value as AttemptKind)} className={fieldClass}>
          <option value="attempt">attempt</option>
          <option value="experiment">experiment</option>
          <option value="note">note</option>
        </select>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !draft.dish.trim()}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-paper disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
