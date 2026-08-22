import "server-only";

import { createClient } from "@supabase/supabase-js";
import { chat, chatStream, embed, composeEmbedText, OllamaUnavailableError } from "@/lib/ollama";

export { OllamaUnavailableError } from "@/lib/ollama";

// ---------------------------------------------------------------------------
// This module talks to a local Ollama instance and to Supabase with the
// service-role key. It must never be imported from a client component — the
// `server-only` import above throws a build error if that ever happens.
// ---------------------------------------------------------------------------

// v-ollama model tiers — everything now runs locally through Ollama, no
// cloud API key or daily quota. Still worth tiering: the small model is
// faster and plenty for trivial classification/extraction, leaving the
// bigger model for the tasks that actually need the reasoning. Centralized
// here so a tier is changeable in one place.

/** Trivial intent classification (LOG vs QUERY, RETRIEVE/ADAPT/GENERATE routing, cook-along detection). */
export const CLASSIFY_MODEL = "qwen2.5:7b";
/** Structured extraction from freeform text (parse-log, generated-dish classification). Same tier as CLASSIFY_MODEL. */
export const PARSE_MODEL = "qwen2.5:7b";
/** Grounded answers, adaptation, and dish-memory distillation. */
export const ANSWER_MODEL = "qwen3.5:9b-mlx";
/** GENERATE-from-scratch (no logged grounding) and ungrounded cook-mode. */
export const GENERATE_MODEL = "qwen3.5:9b-mlx";
/** Embeddings — 768-dim native size (see 0008_switch_to_ollama_embeddings.sql). */
export const EMBED_MODEL = "nomic-embed-text";

// v1a: below this cosine similarity, a match_attempts hit is noise, not a
// real answer. Originally measured against Gemini's gemini-embedding-001;
// re-measured against nomic-embed-text (post-Ollama-migration) with 3 real
// queries against the live log: "why does my steamed fish turn out dry?"
// scored 0.73-0.77 for genuinely relevant entries (0.66-0.68 for
// same-ingredient-but-different-dish entries); "chicken broth" scored a
// tight 0.77-0.78 cluster; the out-of-scope control "how do I fix a wobbly
// table" topped out at 0.52 with nothing else logged that's remotely
// related. 0.6 still sits cleanly in the gap between those, so left
// unchanged — but the margin is narrower than it was on Gemini's
// embeddings, so re-check this if borderline queries start misfiring.
export const RELEVANCE_THRESHOLD = 0.6;

const ANSWER_PROMPT = `You are answering questions about the user's own cooking log — their
personal lab notebook talking back to them. You will be given a question
and a set of retrieved log entries (attempts) that are relevant to it.

Grounding rules (non-negotiable):
- Reference which attempt(s) support each claim, by dish + what happened.
- Never invent a result, rating, or detail the log doesn't actually contain.
- If the retrieved attempts don't actually answer the question, say so
  plainly rather than stretching.

When the question is asking how to make something ("how do I make X",
"remind me how to make X", "what's my recipe for X"), be comprehensive and
practical — a full, cookable recipe, not a summary paragraph — and follow
this exact template:

## <Dish Name>
<one-line intro grounded in the log — what attempt(s) this recipe comes from>

### Ingredients
| Ingredient | Amount |
|---|---|
<one row per ingredient — if the log never specifies an amount, fill it in
with ordinary cooking knowledge and say so in that row, e.g. "not in your
log — typically 1 tsp">

### Steps
1. <step, grounded in what the attempts actually did>
2. <step — **bold** the specific move or warning that caused a bad result
   in the log when skipped or gotten wrong>
...

### From your log
- <one bullet per specific fix or hard-won lesson pulled from the attempts
  — in the user's own terms, not generic technique advice>

Reconstruct the complete recipe even if the log only has scattered
notes/outcomes rather than one clean write-up — anchor every part you can
on what the attempts actually say (best-known ratios, timings, methods).

Here is a fully worked example of the exact format to produce (a different
dish, purely to show the shape — do not reuse any of its specifics):

## Pan-Seared Steak
Grounded in your logged attempts — you landed on a reverse-sear method
(attempt 2) after a straight pan-sear came out uneven (attempt 1).

### Ingredients
| Ingredient | Amount |
|---|---|
| Ribeye steak, 1-1.5in thick | 1 (about 400g) |
| Kosher salt | 1 tsp |
| Black pepper | 1/2 tsp |
| Neutral oil | 1 tbsp |
| Butter | 1 tbsp |
| Garlic cloves, smashed | 2 |
| Thyme sprigs | not in your log — 2 sprigs is typical |

### Steps
1. Salt the steak generously and rest uncovered in the fridge for at least
   1 hour (attempt 2) — **skipping this dried the surface less and gave a
   worse crust in attempt 1.**
2. Oven at 120°C (250°F) until the steak hits an internal temp of 49°C
   (120°F), about 25-30 minutes.
3. Heat oil in a heavy pan until just smoking. **Sear 60-90 seconds per
   side, undisturbed** — this is the step attempt 1 rushed, leading to a
   gray, uneven crust.
4. Add butter, garlic, and thyme; tilt the pan and baste for 30-60 seconds.
5. Rest 5 minutes before slicing.

### From your log
- Reverse-searing (oven first, then a hard sear) gave far more even
  edge-to-edge doneness than starting in the pan (attempt 2 vs. attempt 1).
- Not moving the steak during the sear was the fix for the patchy crust
  from attempt 1.

For anything else — why something happened, what's worked before, general
questions about the log — answer directly and concisely; use the template
above only for "how do I make X" questions, not by default.`;

// v1c agent upgrade: classify intent, then route to one of three synthesis
// prompts. RETRIEVE reuses ANSWER_PROMPT above unchanged.
const CLASSIFY_PROMPT = `You classify what the user wants from their personal cooking log, given
their question and a set of retrieved log entries that are relevant to it.
Return ONLY a JSON object: {"path": "RETRIEVE" | "ADAPT" | "GENERATE"}
- RETRIEVE: the user wants information, a summary, or an answer drawn from
  what they've actually cooked and logged (e.g. "why did X happen", "what's
  worked before for Y", "what have I learned about Z").
- ADAPT: the user wants a variation, scaling, or adjustment of something
  they've logged (e.g. "scale my chicken broth to serve 8", "make my siobak
  recipe but with chicken instead of pork", "adjust the pizza dough for a
  drier climate").
- GENERATE: the user explicitly wants something new/different that isn't
  meant to build on their logged history (e.g. "give me a completely new
  idea for X", "I've never made Y, give me a recipe", "ignore what I've
  tried before and suggest something else").
When in doubt between RETRIEVE and ADAPT, prefer RETRIEVE unless the user is
clearly asking for a changed/adjusted version of a specific past attempt.`;

const ADAPT_PROMPT = `You are adapting one of the user's own logged cooking attempts to a new
request (e.g. scaling, ingredient substitution, adjusting for equipment or
conditions). You will be given the request and the relevant logged
attempt(s) to adapt.
Rules:
- Base the adaptation on the provided attempt(s) — don't invent an unrelated
  recipe. Cite which attempt(s) you're adapting from (by dish + what
  happened).
- Apply the requested change explicitly and show the adjusted recipe/steps,
  not just a description of the change.
- Where the adaptation requires general cooking knowledge (e.g. scaling
  math, a substitution's effect on flavor or texture), it's fine to bring
  that in, but keep the logged attempt as the base you're adjusting.
- Be concise and practical — this is the user's own lab notebook talking
  back to them.`;

const GENERATE_PROMPT = `The user wants a cooking suggestion that isn't grounded in their logged
history — nothing relevant was found, or they explicitly asked for
something new. You may use general cooking knowledge freely here (this is
the one path allowed to).
Rules:
- Produce a genuinely useful, concrete recipe or suggestion — actual
  ingredients/steps, not vague advice.
- Be concise and practical.
- If the question isn't about cooking at all, say so plainly rather than
  making something up.
Do not claim this came from the user's own log — it didn't.`;

const GENERATED_DISH_PROMPT = `Given a generated cooking recipe or suggestion, return ONLY a JSON object:
{"dish": string, "kind": "attempt" | "experiment" | "note"}
- dish: the normalized name of what this recipe makes (e.g. "chicken broth", "pizza dough").
- kind: "attempt" unless the text is clearly describing a comparison/test
  ("experiment") or a standalone tip/learning with no specific dish ("note").`;

// v1c cook-mode: a lightweight pre-check ahead of the RETRIEVE/ADAPT/GENERATE
// routing — orthogonal to those three (it's about the requested *format*,
// not the content source).
const COOK_ALONG_PROMPT = `Does the user want to cook along with step-by-step guidance right now
(e.g. "help me make X today", "walk me through cooking Y", "let's cook Z"),
as opposed to just asking a question or wanting a written recipe/answer?
Return ONLY a JSON object: {"cookAlong": true | false}`;

const COOK_MODE_PROMPT = `You produce a step-by-step cooking guide for the user to follow along with
right now. Return ONLY a JSON object:
{
  "dish": string,
  "ingredients": string[] | null,
  "steps": [{ "text": string, "minutes": number | null }]
}
- dish: normalized name of what they're making.
- ingredients: a plain list of what's needed, or null if not clearly stated.
- steps: ordered, actionable steps. Set "minutes" only for a step that
  involves a specific timed duration (e.g. "steam for 12 minutes"); use null
  for steps with no specific duration.
If you are given one of the user's own logged attempts, ground the steps in
what they actually did (changes/outcome/analysis), filling reasonable gaps
with general cooking knowledge only where the log doesn't specify. If no
logged attempt is given, generate a genuinely useful recipe from scratch.`;

// v1d: unified chat router — classifies each message as a log entry or a
// question/request before anything else runs.
const CHAT_INTENT_PROMPT = `You classify a message sent to a personal cooking log/assistant app.
Return ONLY a JSON object: {"intent": "LOG" | "QUERY"}
- LOG: the user is recording something they just cooked or are cooking — a
  freeform note about a dish, what they changed, how it turned out (e.g.
  "siobak attempt 4, oven 180 last 10 min, crackling worked, 8/10").
- QUERY: the user is asking a question, asking for help, or wants a recipe
  — anything that isn't recording a specific cook of their own just now
  (e.g. "why does my broth turn out murky", "help me make X today", "give
  me a new pasta idea").
When genuinely ambiguous, prefer LOG only if the message reads like a
first-person account of something already done or being done right now;
otherwise QUERY.`;

// v1d dish memory — distills all of one dish's attempts into a compact
// running summary, cached in dish_memory.
const DISH_MEMORY_PROMPT = `You distill everything logged about one dish into a compact "what I know
about this dish" memory. You will be given all logged attempts for it
(changes, outcome, analysis, rating, per attempt).
Return ONLY a JSON object: {"bullets": string[]}
- Cover: best-known settings/method so far, open questions or unresolved
  uncertainties, and key conclusions/lessons.
- Each bullet is one short, concrete sentence. Prefer specifics (numbers,
  ingredients, methods) over vague summary.
- 4-8 bullets total. Do not repeat the same point twice.
- If attempts conflict, note the tension rather than picking a side
  silently.`;

const PARSE_PROMPT = `You convert a short freeform cooking log into structured JSON.
The user messages you right after cooking.
Return ONLY a JSON object — no markdown, no preamble — with:
- dish: string (normalized dish name)
- changes: string or null (the experimental variable — what they did differently this time)
- outcome: string or null (what actually happened)
- analysis: string or null (their interpretation — hypotheses, what they think caused
  the result, what they're unsure about, what to try next. Preserve their reasoning
  faithfully; do not reduce it to a bare fact.)
- rating: integer 1–10 or null (their score, if given)
If the message is NOT about something they cooked, return exactly: {"skip": true}
Example in:  "steam hongkong attempt, 12 minute steam seems like too long for certain types of fish (baramundi), but not sure if its the fish or my steam water is too low, the fish is cooked but slightly dry, so the fish is not that juicy"
Example out: {"dish":"hong kong style steamed fish","changes":"steamed 12 min (barramundi)","outcome":"cooked but slightly dry, not very juicy","analysis":"12 min may be too long for barramundi; unsure whether the dryness is the fish type or the steam water level being too low","rating":null}`;

/** Contract returned by the parser (PRD section 9, extended with `analysis`). */
export type ParsedLog = {
  skip?: boolean;
  dish?: string;
  changes?: string | null;
  outcome?: string | null;
  analysis?: string | null;
  rating?: number | null;
};

/** The DB row's kind enum (matches the `attempts_kind_check` constraint). */
export type AttemptKind = "attempt" | "experiment" | "note";

/** Row shape returned to the client (PRD section 10, extended with `analysis`, `target`, `kind`). */
export type Attempt = {
  id: string;
  dish: string;
  rating: number | null;
  changes: string | null;
  outcome: string | null;
  analysis: string | null;
  target: string | null;
  kind: AttemptKind;
  cooked_at: string;
};

/** Thrown when the model call fails or returns unparsable output (FR5). */
export class ParserError extends Error {}

// Minimal typed schema — just enough of the `attempts` table (section 8) for
// supabase-js to infer insert/select types instead of falling back to
// `never`. Not a full generated Database type; v0 only touches this table.
type Database = {
  public: {
    Tables: {
      attempts: {
        Row: {
          id: string;
          recipe_id: string | null;
          dish: string;
          cooked_at: string;
          changes: string | null;
          outcome: string | null;
          analysis: string | null;
          rating: number | null;
          note: string;
          embedding: number[] | null;
          created_at: string;
          target: string | null;
          kind: string;
          source: string | null;
        };
        Insert: {
          dish: string;
          changes?: string | null;
          outcome?: string | null;
          analysis?: string | null;
          rating?: number | null;
          note: string;
          target?: string | null;
          kind?: string;
          source?: string | null;
          embedding?: number[] | null;
        };
        Update: Partial<Database["public"]["Tables"]["attempts"]["Insert"]>;
        Relationships: [];
      };
      recipes: {
        Row: {
          id: string;
          name: string;
          aliases: string[] | null;
          base_servings: number | null;
          ingredients: unknown | null;
          steps: unknown | null;
          source: string | null;
          notes: string | null;
          embedding: number[] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          name: string;
          notes?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["recipes"]["Insert"]>;
        Relationships: [];
      };
      // v1e: the per-dish "memory" summary cache (0007_add_dish_memory.sql).
      // attempt_count is the count as of when `summary` was last generated —
      // compared against the live count to tell a fresh cache from a stale
      // one without calling the model just to check.
      dish_memory: {
        Row: {
          dish: string;
          summary: string | null;
          attempt_count: number;
          updated_at: string;
        };
        Insert: {
          dish: string;
          summary?: string | null;
          attempt_count?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["dish_memory"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      match_attempts: {
        Args: { query_embedding: number[]; match_count?: number };
        Returns: {
          id: string;
          dish: string;
          changes: string | null;
          outcome: string | null;
          analysis: string | null;
          rating: number | null;
          cooked_at: string;
          target: string | null;
          similarity: number;
        }[];
      };
    };
  };
};

let supabaseAdmin: ReturnType<typeof createClient<Database>> | null = null;
function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set");
    }
    supabaseAdmin = createClient<Database>(url, key, {
      auth: { persistSession: false },
    });
  }
  return supabaseAdmin;
}

/**
 * Shared wrapper around every chat call in this module. Any connection
 * failure (Ollama not running / wrong port) surfaces as
 * OllamaUnavailableError unchanged — callers/routes catch that specifically
 * and show a calm "local model unavailable" message instead of crashing the
 * path. Any other failure throws `errorClass` (ParserError/AnswerError),
 * same contract as before this module talked to Ollama.
 */
async function callModel(params: {
  model: string;
  contents: string;
  systemInstruction: string;
  label: string;
  errorClass: new (message: string) => Error;
  temperature?: number;
  maxOutputTokens?: number;
  json?: boolean;
}): Promise<string> {
  try {
    return await chat(params.model, params.systemInstruction, params.contents, {
      json: params.json,
      temperature: params.temperature,
      maxTokens: params.maxOutputTokens,
      // None of this app's prompts want visible chain-of-thought in the
      // output (whether prose or JSON) — disabled universally rather than
      // per-call, harmless no-op for models without hybrid reasoning.
      think: false,
    });
  } catch (err) {
    if (err instanceof OllamaUnavailableError) throw err;
    throw new params.errorClass(
      `Ollama ${params.label} request failed (model=${params.model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Streaming sibling of callModel — for the final prose answer only
 * (RETRIEVE/ADAPT/GENERATE), never for JSON-expecting calls. Yields text
 * chunks as they generate; OllamaUnavailableError propagates unchanged
 * (mid-stream, so the route surfaces it as an SSE error event rather than
 * an HTTP error — headers are already committed by the time streaming
 * starts). Any other failure is wrapped in `errorClass`, same as callModel.
 */
async function* callModelStream(params: {
  model: string;
  contents: string;
  systemInstruction: string;
  label: string;
  errorClass: new (message: string) => Error;
  temperature?: number;
}): AsyncGenerator<string, void, unknown> {
  try {
    yield* chatStream(params.model, params.systemInstruction, params.contents, {
      temperature: params.temperature,
      think: false,
    });
  } catch (err) {
    if (err instanceof OllamaUnavailableError) throw err;
    throw new params.errorClass(
      `Ollama ${params.label} stream request failed (model=${params.model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Sends a freeform cooking message to the model and returns the parsed
 * structured result, or `{ skip: true }` for non-cooking messages. Throws
 * ParserError on any model or JSON-parsing failure (FR5), or
 * OllamaUnavailableError if Ollama can't be reached.
 */
export async function parseLog(message: string): Promise<ParsedLog> {
  const text = await callModel({
    model: PARSE_MODEL,
    contents: message,
    systemInstruction: PARSE_PROMPT,
    label: "parse",
    errorClass: ParserError,
    temperature: 0,
    maxOutputTokens: 300,
    json: true,
  });

  try {
    return JSON.parse(text) as ParsedLog;
  } catch {
    throw new ParserError("Ollama returned unparsable JSON");
  }
}

/** A parsed log with a confirmed `dish` — the only shape insertAttempt accepts. */
export type ValidCook = {
  dish: string;
  changes?: string | null;
  outcome?: string | null;
  analysis?: string | null;
  rating?: number | null;
};

/**
 * Inserts one attempt row. `message` is stored verbatim in `note` (FR3).
 * Callers must have already ruled out `skip` / missing `dish` (FR4).
 */
export async function insertAttempt(
  message: string,
  parsed: ValidCook
): Promise<Attempt> {
  const { data, error } = await getSupabaseAdmin()
    .from("attempts")
    .insert({
      dish: parsed.dish,
      changes: parsed.changes ?? null,
      outcome: parsed.outcome ?? null,
      analysis: parsed.analysis ?? null,
      rating: parsed.rating ?? null,
      note: message,
    })
    .select("id, dish, rating, changes, outcome, analysis, target, kind, cooked_at")
    .single();

  if (error) throw error;
  return data as unknown as Attempt;
}

/** Returns the 20 newest attempts, newest first (FR7). */
export async function getRecentAttempts(): Promise<Attempt[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("attempts")
    .select("id, dish, rating, changes, outcome, analysis, target, kind, cooked_at")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as unknown as Attempt[];
}

/** One vector-search result from the match_attempts RPC (v1a). */
export type AttemptMatch = {
  id: string;
  dish: string;
  changes: string | null;
  outcome: string | null;
  analysis: string | null;
  rating: number | null;
  cooked_at: string;
  target: string | null;
  similarity: number;
};

/**
 * Vector search over attempts via the match_attempts Postgres function.
 * Returns the top `matchCount` rows by cosine similarity, most similar first.
 *
 * `dishFilter` (v1d, dish-scoped chat) constrains results to one dish. This
 * is applied in application code, not in the SQL function — match_attempts
 * itself is untouched — so when a filter is active we over-fetch from the
 * RPC and then filter/trim down to `matchCount` in TypeScript.
 */
export async function matchAttempts(
  queryEmbedding: number[],
  matchCount = 5,
  dishFilter?: string
): Promise<AttemptMatch[]> {
  const fetchCount = dishFilter ? Math.max(matchCount * 5, 40) : matchCount;
  const { data, error } = await getSupabaseAdmin().rpc("match_attempts", {
    query_embedding: queryEmbedding,
    match_count: fetchCount,
  });

  if (error) throw error;
  let results = (data ?? []) as unknown as AttemptMatch[];
  if (dishFilter) {
    results = results.filter((m) => m.dish === dishFilter).slice(0, matchCount);
  }
  return results;
}

/** Thrown when the answer-synthesis model call fails (v1b). */
export class AnswerError extends Error {}

function formatMatchForPrompt(match: AttemptMatch, index: number): string {
  const lines = [
    `${index + 1}. dish: ${match.dish}${match.target ? ` (imitating ${match.target})` : ""}`,
    `   cooked: ${match.cooked_at}`,
  ];
  if (match.changes) lines.push(`   changes: ${match.changes}`);
  if (match.outcome) lines.push(`   outcome: ${match.outcome}`);
  if (match.analysis) lines.push(`   analysis: ${match.analysis}`);
  if (match.rating != null) lines.push(`   rating: ${match.rating}/10`);
  return lines.join("\n");
}

/**
 * Synthesizes a grounded answer to `question` from `matches` (already
 * filtered to those clearing RELEVANCE_THRESHOLD by the caller). Never call
 * this with an empty `matches` array — there'd be nothing to ground on.
 */
export async function synthesizeAnswer(
  question: string,
  matches: AttemptMatch[]
): Promise<string> {
  const context = matches.map(formatMatchForPrompt).join("\n\n");
  const userContent = `Question: ${question}\n\nRelevant log entries:\n${context}`;

  const text = await callModel({
    model: ANSWER_MODEL,
    contents: userContent,
    systemInstruction: ANSWER_PROMPT,
    label: "answer",
    errorClass: AnswerError,
    // Low and steady — the template + worked example only pay off if the
    // model reliably reproduces the structure rather than wandering.
    temperature: 0.3,
  });
  return text.trim();
}

/** Streaming sibling of synthesizeAnswer — same grounding/prompt, chunked. */
export function synthesizeAnswerStream(
  question: string,
  matches: AttemptMatch[]
): AsyncGenerator<string, void, unknown> {
  const context = matches.map(formatMatchForPrompt).join("\n\n");
  const userContent = `Question: ${question}\n\nRelevant log entries:\n${context}`;

  return callModelStream({
    model: ANSWER_MODEL,
    contents: userContent,
    systemInstruction: ANSWER_PROMPT,
    label: "answer",
    errorClass: AnswerError,
    temperature: 0.3,
  });
}

/** Pings the database — used by the Vercel cron keep-alive route. */
export async function pingDatabase(): Promise<void> {
  const { error } = await getSupabaseAdmin().from("attempts").select("id").limit(1);
  if (error) throw error;
}

/** Fetches one attempt row by id, or null if it doesn't exist (v1c edit/delete). */
export async function getAttemptById(id: string): Promise<Attempt | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("attempts")
    .select("id, dish, rating, changes, outcome, analysis, target, kind, cooked_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data as unknown as Attempt | null;
}

/** Fields a caller may PATCH on an attempt (v1c). */
export type AttemptPatch = {
  dish?: string;
  changes?: string | null;
  outcome?: string | null;
  analysis?: string | null;
  rating?: number | null;
  target?: string | null;
  kind?: AttemptKind;
};

/**
 * Updates an attempt row with `fields` plus a freshly computed `embedding`.
 * Callers must recompute the embedding from the *merged* (existing + patch)
 * row via composeEmbedText — this function just persists what it's given.
 */
export async function updateAttempt(
  id: string,
  fields: AttemptPatch,
  embedding: number[]
): Promise<Attempt> {
  const { data, error } = await getSupabaseAdmin()
    .from("attempts")
    .update({ ...fields, embedding })
    .eq("id", id)
    .select("id, dish, rating, changes, outcome, analysis, target, kind, cooked_at")
    .single();

  if (error) throw error;
  return data as unknown as Attempt;
}

/** Deletes an attempt row by id (v1c). */
export async function deleteAttempt(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from("attempts").delete().eq("id", id);
  if (error) throw error;
}

/** Which of the three ask-agent paths ran (v1c). */
export type AskPath = "RETRIEVE" | "ADAPT" | "GENERATE";

/**
 * Classifies intent among RETRIEVE/ADAPT/GENERATE given the question and the
 * matches that already cleared RELEVANCE_THRESHOLD. Only call this when
 * `matches` is non-empty — an empty `matches` array means GENERATE is forced
 * mechanically by the caller, no classification needed.
 */
export async function classifyAskIntent(
  question: string,
  matches: AttemptMatch[]
): Promise<AskPath> {
  const context = matches.map(formatMatchForPrompt).join("\n\n");
  const userContent = `Question: ${question}\n\nRelevant log entries:\n${context}`;

  const text = await callModel({
    model: CLASSIFY_MODEL,
    contents: userContent,
    systemInstruction: CLASSIFY_PROMPT,
    label: "classify",
    errorClass: AnswerError,
    temperature: 0,
    maxOutputTokens: 200,
    json: true,
  });

  let parsed: { path?: string };
  try {
    parsed = JSON.parse(text) as { path?: string };
  } catch {
    throw new AnswerError("Ollama returned unparsable classification JSON");
  }

  if (parsed.path === "ADAPT" || parsed.path === "GENERATE") return parsed.path;
  return "RETRIEVE";
}

/**
 * ADAPT path: produces an adjusted recipe/steps grounded in `matches`,
 * applying the requested tweak (scaling, substitution, etc.).
 */
export async function synthesizeAdaptation(
  question: string,
  matches: AttemptMatch[]
): Promise<string> {
  const context = matches.map(formatMatchForPrompt).join("\n\n");
  const userContent = `Question: ${question}\n\nRelevant log entries:\n${context}`;

  const text = await callModel({
    model: ANSWER_MODEL,
    contents: userContent,
    systemInstruction: ADAPT_PROMPT,
    label: "adapt",
    errorClass: AnswerError,
  });
  return text.trim();
}

/** Streaming sibling of synthesizeAdaptation — same grounding/prompt, chunked. */
export function synthesizeAdaptationStream(
  question: string,
  matches: AttemptMatch[]
): AsyncGenerator<string, void, unknown> {
  const context = matches.map(formatMatchForPrompt).join("\n\n");
  const userContent = `Question: ${question}\n\nRelevant log entries:\n${context}`;

  return callModelStream({
    model: ANSWER_MODEL,
    contents: userContent,
    systemInstruction: ADAPT_PROMPT,
    label: "adapt",
    errorClass: AnswerError,
  });
}

/**
 * GENERATE path: a novel suggestion not grounded in the log, allowed to use
 * outside cooking knowledge. Caller is responsible for marking the answer
 * as new/not-from-the-log in the UI.
 */
export async function synthesizeGenerated(question: string): Promise<string> {
  const text = await callModel({
    model: GENERATE_MODEL,
    contents: question,
    systemInstruction: GENERATE_PROMPT,
    label: "generate",
    errorClass: AnswerError,
  });
  return text.trim();
}

/** Streaming sibling of synthesizeGenerated — same prompt, chunked. */
export function synthesizeGeneratedStream(question: string): AsyncGenerator<string, void, unknown> {
  return callModelStream({
    model: GENERATE_MODEL,
    contents: question,
    systemInstruction: GENERATE_PROMPT,
    label: "generate",
    errorClass: AnswerError,
  });
}

/** Classifies a freshly generated recipe's dish name + kind (for distill-back). */
export async function classifyGeneratedDish(
  recipeText: string
): Promise<{ dish: string; kind: AttemptKind }> {
  const text = await callModel({
    model: PARSE_MODEL,
    contents: recipeText,
    systemInstruction: GENERATED_DISH_PROMPT,
    label: "dish-classify",
    errorClass: ParserError,
    temperature: 0,
    maxOutputTokens: 200,
    json: true,
  });

  let parsed: { dish?: string; kind?: string };
  try {
    parsed = JSON.parse(text) as { dish?: string; kind?: string };
  } catch {
    throw new ParserError("Ollama returned unparsable dish classification JSON");
  }

  const dish =
    typeof parsed.dish === "string" && parsed.dish.trim().length > 0
      ? parsed.dish.trim()
      : "generated recipe";
  const kind: AttemptKind =
    parsed.kind === "experiment" || parsed.kind === "note" ? parsed.kind : "attempt";

  return { dish, kind };
}

/**
 * Distill-back: saves a GENERATE-path answer as a new attempt row
 * (`source: "generated"`). `note` stores the full generated text verbatim;
 * the embedding is composed from dish + that same text so it's findable by
 * future search/ask.
 */
export async function insertGeneratedAttempt(recipeText: string): Promise<Attempt> {
  const { dish, kind } = await classifyGeneratedDish(recipeText);
  const embedding = await embed(composeEmbedText({ dish, analysis: recipeText }), EMBED_MODEL);

  const { data, error } = await getSupabaseAdmin()
    .from("attempts")
    .insert({
      dish,
      kind,
      source: "generated",
      note: recipeText,
      embedding,
    })
    .select("id, dish, rating, changes, outcome, analysis, target, kind, cooked_at")
    .single();

  if (error) throw error;
  return data as unknown as Attempt;
}

/** Detects "cook along with me right now" intent, ahead of the RETRIEVE/ADAPT/GENERATE routing. */
export async function detectCookAlongIntent(question: string): Promise<boolean> {
  const text = await callModel({
    model: CLASSIFY_MODEL,
    contents: question,
    systemInstruction: COOK_ALONG_PROMPT,
    label: "cook-along-detect",
    errorClass: AnswerError,
    temperature: 0,
    maxOutputTokens: 200,
    json: true,
  });

  let parsed: { cookAlong?: boolean };
  try {
    parsed = JSON.parse(text) as { cookAlong?: boolean };
  } catch {
    throw new AnswerError("Ollama returned unparsable cook-along classification JSON");
  }

  return parsed.cookAlong === true;
}

/** One step in a cook-mode recipe; `minutes` is set only for timed steps. */
export type CookStep = { text: string; minutes: number | null };

/** A structured recipe for cook-mode — grounded in a logged attempt, or generated fresh. */
export type CookRecipe = {
  dish: string;
  ingredients: string[] | null;
  steps: CookStep[];
};

/**
 * Produces a structured cook-mode recipe. Grounds it in `baseAttempt` (the
 * best-matching logged attempt) when provided; generates from scratch
 * (general cooking knowledge allowed) when `baseAttempt` is null.
 */
export async function synthesizeCookRecipe(
  question: string,
  baseAttempt: AttemptMatch | null
): Promise<CookRecipe> {
  const context = baseAttempt
    ? `\n\nYour logged attempt to ground this in:\n${formatMatchForPrompt(baseAttempt, 0)}`
    : "\n\n(No relevant logged attempt — generate from scratch.)";
  const userContent = `Request: ${question}${context}`;

  // Grounded in a logged attempt → same tier as the other RETRIEVE/ADAPT
  // paths. No grounding at all → this is a from-scratch generation, same
  // tier as synthesizeGenerated. (Both are ANSWER_MODEL/GENERATE_MODEL
  // right now, but kept distinct in case the tiers diverge again later.)
  const model = baseAttempt ? ANSWER_MODEL : GENERATE_MODEL;

  const text = await callModel({
    model,
    contents: userContent,
    systemInstruction: COOK_MODE_PROMPT,
    label: "cook-mode",
    errorClass: AnswerError,
    json: true,
  });

  let parsed: {
    dish?: string;
    ingredients?: (string | null)[] | null;
    steps?: { text?: string; minutes?: number | null }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AnswerError("Ollama returned unparsable cook-mode JSON");
  }

  const dish =
    typeof parsed.dish === "string" && parsed.dish.trim().length > 0
      ? parsed.dish.trim()
      : "your cook";
  const ingredients = Array.isArray(parsed.ingredients)
    ? parsed.ingredients.filter((i): i is string => typeof i === "string")
    : null;
  const steps: CookStep[] = Array.isArray(parsed.steps)
    ? parsed.steps
        .filter((s): s is { text: string; minutes?: number | null } => typeof s?.text === "string")
        .map((s) => ({ text: s.text, minutes: typeof s.minutes === "number" ? s.minutes : null }))
    : [];

  return { dish, ingredients, steps };
}

export type ChatIntent = "LOG" | "QUERY";

/** Classifies a chat message as LOG (recording a cook) or QUERY (question/request) — v1d unified chat. */
export async function classifyChatIntent(message: string): Promise<ChatIntent> {
  const text = await callModel({
    model: CLASSIFY_MODEL,
    contents: message,
    systemInstruction: CHAT_INTENT_PROMPT,
    label: "chat-intent",
    errorClass: AnswerError,
    temperature: 0,
    maxOutputTokens: 200,
    json: true,
  });

  let parsed: { intent?: string };
  try {
    parsed = JSON.parse(text) as { intent?: string };
  } catch {
    throw new AnswerError("Ollama returned unparsable chat-intent classification JSON");
  }

  return parsed.intent === "LOG" ? "LOG" : "QUERY";
}

/** Fetches every attempt logged for `dish`, oldest first (v1d dish memory). */
async function getAttemptsForDish(dish: string): Promise<Attempt[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("attempts")
    .select("id, dish, rating, changes, outcome, analysis, target, kind, cooked_at")
    .eq("dish", dish)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as Attempt[];
}

function formatAttemptForMemory(attempt: Attempt, index: number): string {
  const lines = [`${index + 1}. cooked: ${attempt.cooked_at}`];
  if (attempt.changes) lines.push(`   changes: ${attempt.changes}`);
  if (attempt.outcome) lines.push(`   outcome: ${attempt.outcome}`);
  if (attempt.analysis) lines.push(`   analysis: ${attempt.analysis}`);
  if (attempt.rating != null) lines.push(`   rating: ${attempt.rating}/10`);
  return lines.join("\n");
}

/**
 * Regenerates and caches the "memory" summary for `dish` in dish_memory —
 * distills all of its attempts into a compact bullet list, and stamps the
 * cache with the attempt count as of this regeneration (so getDishMemory
 * can tell later whether the cache is still fresh). Returns the bullets, or
 * null if the dish has no attempts (e.g. renamed/deleted out from under it).
 */
export async function regenerateDishMemory(dish: string): Promise<string[] | null> {
  const attempts = await getAttemptsForDish(dish);
  if (attempts.length === 0) return null;

  const context = attempts.map(formatAttemptForMemory).join("\n\n");
  const userContent = `Dish: ${dish}\n\nLogged attempts:\n${context}`;

  const text = await callModel({
    model: ANSWER_MODEL,
    contents: userContent,
    systemInstruction: DISH_MEMORY_PROMPT,
    label: "dish-memory",
    errorClass: AnswerError,
    json: true,
  });

  let parsed: { bullets?: unknown };
  try {
    parsed = JSON.parse(text) as { bullets?: unknown };
  } catch {
    throw new AnswerError("Ollama returned unparsable dish-memory JSON");
  }

  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    : [];

  const { error: upsertError } = await getSupabaseAdmin()
    .from("dish_memory")
    .upsert(
      {
        dish,
        summary: JSON.stringify(bullets),
        attempt_count: attempts.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "dish" }
    );
  if (upsertError) throw upsertError;

  return bullets;
}

/**
 * Reads the cached memory summary for `dish` from dish_memory. Regenerates
 * only when there's no cache yet, or the live attempt count has moved past
 * what the cache was generated against (a new attempt was logged somewhere
 * since) — otherwise serves the cached summary straight from the DB with no
 * model call at all (this is the whole point of the cache). Returns
 * `{ bullets: null, attemptCount: 0 }` if the dish has no attempts.
 */
export type DishMemory = {
  bullets: string[] | null;
  attemptCount: number;
  /** Set when bullets is null specifically because Ollama was unreachable during regeneration (not because there's genuinely nothing to distill). */
  unavailable?: boolean;
};

function parseCachedSummary(summary: string): string[] | null {
  try {
    return JSON.parse(summary) as string[];
  } catch {
    return null;
  }
}

export async function getDishMemory(dish: string): Promise<DishMemory> {
  const { count, error: countError } = await getSupabaseAdmin()
    .from("attempts")
    .select("id", { count: "exact", head: true })
    .eq("dish", dish);
  if (countError) throw countError;
  const attemptCount = count ?? 0;

  if (attemptCount === 0) return { bullets: null, attemptCount: 0 };

  const { data, error } = await getSupabaseAdmin()
    .from("dish_memory")
    .select("summary, attempt_count")
    .eq("dish", dish)
    .maybeSingle();
  if (error) throw error;

  // Cache is fresh (no attempt logged since it was made) — serve it
  // straight from the DB, no model call.
  if (data?.summary && data.attempt_count === attemptCount) {
    const bullets = parseCachedSummary(data.summary);
    if (bullets) return { bullets, attemptCount };
  }

  // No cache yet, or stale (attempt count moved) — regenerate lazily on
  // this view. The count above is real, cheap data independent of the AI
  // summary — don't lose it just because generating the summary failed
  // (Ollama down, model error, etc.); degrade to the last good cache
  // instead of throwing.
  try {
    const bullets = await regenerateDishMemory(dish);
    return { bullets, attemptCount };
  } catch (err) {
    const unavailable = err instanceof OllamaUnavailableError;
    console.error("regenerateDishMemory failed (serving cache without regenerating):", err);
    const stale = data?.summary ? parseCachedSummary(data.summary) : null;
    return { bullets: stale, attemptCount, ...(unavailable && { unavailable: true }) };
  }
}
