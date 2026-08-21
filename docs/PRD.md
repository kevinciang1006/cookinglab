# Cooking Lab — v0 PRD (Capture)

## 1. Summary
A personal, chat-first cooking notebook. I log what I cooked in plain language; the
app parses it into a structured record and accumulates it. **v0 is capture only** —
no retrieval, no agent, no voice. The purpose of v0 is to make logging effortless and
start building the dataset that later versions will reason over. The capture layer is
the only thing here that a plain chat assistant can't do, so it's what we build first.

## 2. Problem
Cooking insights currently evaporate into one-off AI chats. Nothing accumulates and
nothing is queryable. This app closes the *capture* gap first: a durable, structured,
growing record of every cook, owned by me.

## 3. Users
Single user (me). No authentication in v0 — the app runs privately (local dev, or a
private deployment). Do not build auth.

## 4. Goals (v0)
- Log a cook in one freeform message.
- Auto-parse each message into: `dish`, `changes`, `outcome`, `rating`.
- Persist every valid log as a structured row.
- Decline non-cooking messages gracefully — save nothing.
- Show a running list of recent cooks that refreshes after each log.

## 5. Non-goals (explicitly OUT of scope for v0 — do not build ahead)
- Retrieval / search / "what did I do last time" → v1.
- Populating embeddings → v1 (column exists but stays NULL in v0).
- Agent routing, recipe generation, recipe scaling → v1+.
- Cook-mode UI panels, timers, checklists, step cards → v2.
- Voice input/output → later.
- Auth, multi-user, sharing, mobile app.

If a requirement isn't in section 4, it does not belong in v0.

## 6. Core flow
1. User types, e.g.: `siobak attempt 4, oven 180 last 10 min, crackling finally worked, 8/10`
2. App sends the message to the parser (Gemini Flash-Lite).
3. Parser returns structured JSON **or** `{"skip": true}`.
4. If a valid cook → insert one row, show a confirmation card, refresh the recent list.
5. If skip → show a short decline message, save nothing.

## 7. Functional requirements
- **FR1** A text composer accepts a freeform message and a send action.
- **FR2** On send, the app calls the parser and blocks input with a loading state
  until a response returns.
- **FR3** A valid parse inserts exactly one `attempts` row with the parsed fields and
  the original message stored verbatim in `note`.
- **FR4** A `{"skip": true}` result (or missing `dish`) inserts nothing and returns a
  short, friendly decline.
- **FR5** Parser or DB failure returns a friendly error message — never an unhandled
  500 / stack trace to the client.
- **FR6** After a successful log, the input clears and the recent-cooks list refreshes.
- **FR7** A recent-cooks list shows the 20 newest attempts, newest first.

## 8. Data model (run this in Supabase SQL editor before building)
```sql
create extension if not exists vector;

create table recipes (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  aliases       text[] default '{}',
  base_servings numeric,
  ingredients   jsonb,
  steps         jsonb,
  source        text default 'self' check (source in ('self','generated','external')),
  notes         text,
  embedding     vector(1536),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table attempts (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid references recipes(id) on delete set null,
  dish        text not null,
  cooked_at   date default current_date,
  changes     text,
  outcome     text,
  rating      int check (rating between 1 and 10),
  note        text not null,
  embedding   vector(1536),
  created_at  timestamptz default now()
);

create index attempts_dish_idx   on attempts (lower(dish));
create index attempts_rating_idx on attempts (rating);
```
Notes:
- `recipes` is unused in v0 (filled by v1's distill step) — create it now so the schema
  is stable. v0 writes only to `attempts`.
- No `hnsw` vector index yet; added in v1 when embeddings get populated.
- `vector(1536)` is coupled to the embedding model chosen in v1. Leave as-is for now.

## 9. Parser spec
- **Model:** `gemini-2.5-flash-lite` via the Gemini API (free tier, Google AI Studio key).
- **Config:** `responseMimeType: "application/json"`, `temperature: 0`, `maxOutputTokens: 300`.
- **System prompt (verbatim):**
```
You convert a short freeform cooking log into structured JSON.
The user messages you right after cooking.
Return ONLY a JSON object — no markdown, no preamble — with:
- dish: string (normalized dish name)
- changes: string or null (what they did differently)
- outcome: string or null (how it turned out)
- rating: integer 1–10 or null (their score, if given)
If the message is NOT about something they cooked, return exactly: {"skip": true}
Example in:  "siobak attempt 4, oven 180 last 10 min, crackling worked, 8/10"
Example out: {"dish":"siobak","changes":"oven 180 last 10 min","outcome":"crackling worked","rating":8}
```
- **Contract:** the parser returns `{ skip?: boolean; dish?: string; changes?: string|null; outcome?: string|null; rating?: number|null }`. Wrap `JSON.parse` in try/catch; on parse failure, treat as a friendly error (FR5).

## 10. API
- **POST `/api/log`** — body `{ message: string }` → `{ saved: boolean, reply: string, attempt?: {...} }`.
  Runs parse → decide skip/save → insert → respond. All model/DB keys used server-side only.
- **GET `/api/attempts`** — returns the 20 newest attempts: `id, dish, rating, changes, outcome, cooked_at`, newest first.

## 11. UI / UX + design direction
Single centered column, chat-first. This is a **lab notebook**, not a chat toy — the
aesthetic should feel warm, precise, and a little analog. Do not ship default shadcn or
a ChatGPT clone.

- **Layout:** one column, max-width ~640px, centered, generous vertical rhythm. Composer
  pinned at the bottom of the conversation area. Recent-cooks list below the composer on
  mobile; a right rail on wide screens is acceptable but optional.
- **Palette:** warm paper/off-white background (not pure white), near-black ink text, a
  single warm accent (burnt orange / coral) used sparingly for the send action and rating
  chips. Subtle hairline dividers, not heavy borders or cards-everywhere.
- **Type:** clean sans for prose; a **monospace** treatment for the structured bits
  (dish label, rating chip) so logged data reads as "captured record." Deliberate type
  scale — don't leave everything at one size.
- **The confirmation is a mini structured card, not a text line.** When a cook is logged,
  render a compact card: dish name, a rating chip (e.g. `8/10`), and the changes/outcome
  as small labeled fields. This is a deliberate preview of the generative-UI direction —
  the assistant answers with *structure*, not just prose.
- **Decline** is a plain, quiet message bubble — no card.
- **Empty state:** show the log-format example so it's obvious how to write a log.
- **States:** visible loading state while parsing; disabled send while pending; clear
  input on success. Dark mode is a nice-to-have, not required for v0.

## 12. Tech stack
- Next.js 15 (App Router), TypeScript, TailwindCSS.
- Supabase (Postgres) via `@supabase/supabase-js`, service-role client used **server-side only**.
- Gemini API (`gemini-2.5-flash-lite`) for parsing.
- No component library required; shadcn/ui optional if it speeds things up, but keep the
  design direction above — don't let defaults dictate the look.

## 13. Environment (`.env.local`)
```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...        # service role — server only, never exposed to client
GEMINI_API_KEY=...             # Google AI Studio free-tier key, on a project WITHOUT billing enabled
```

## 14. Acceptance criteria
- Posting `siobak attempt 4, oven 180 last 10 min, crackling worked, 8/10` inserts exactly
  one `attempts` row with `dish="siobak"`, `rating=8`, `note` = the full original message,
  and returns `saved:true`.
- Posting `what should I cook tonight?` inserts **zero** rows and returns `saved:false`
  with a decline message.
- A message with no rating stores `rating = null` and does not error.
- Malformed model output is caught and returns a friendly error (no 500 stack to client).
- `GET /api/attempts` returns the 20 newest, correctly ordered.
- The client bundle never contains `SUPABASE_SERVICE_KEY` or `GEMINI_API_KEY`.
- After a successful log the input clears and the recent list shows the new entry.

## 15. Future (post-v0, for context — not to build now)
- **v1:** embeddings backfill + `match_attempts` vector RPC + SQL/vector query router;
  recipe distill-back step that writes canonical rows into `recipes`.
- **v2:** cook-mode UI panels (timer, checklist, step cards) summoned by intent.
- **Later:** voice input/output; migrate the parser to a local model on the Mac mini.
