import "server-only";

// ---------------------------------------------------------------------------
// Local Ollama client — replaces the Gemini SDK (lib/cooking.ts) and Gemini
// embeddings (formerly lib/embed.ts). Every AI call in this app now stays
// on-machine: no cloud API key, no request ever leaves localhost. Models are
// centralized as named constants in lib/cooking.ts (CLASSIFY_MODEL, etc.) —
// this module just knows how to talk to Ollama's HTTP API, not which model
// to use for which task.
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/**
 * Thrown when Ollama can't be reached at all (not running, wrong port,
 * connection refused) — distinct from Ollama responding with an error.
 * Callers catch this to show a calm "local model unavailable" message
 * instead of crashing the path.
 */
export class OllamaUnavailableError extends Error {}

// gpt-oss:20b (~13GB) run under a constrained wired-memory limit — if the
// OS/Ollama kills the runner process under memory pressure, Ollama's error
// response names it plainly ("signal: killed"). Detected here so it's
// logged as exactly that (not a generic failure) — the whole point is that
// whoever reads the server log can tell "memory pressure" apart from "model
// bug" or "network hiccup" at a glance.
const MEMORY_KILL_RE = /signal:\s*killed|oom.?killed|out of memory/i;

function logIfMemoryKilled(model: string, raw: string): void {
  if (MEMORY_KILL_RE.test(raw)) {
    console.error(
      `[MEMORY PRESSURE] Ollama's runner for model=${model} was killed (likely OOM — gpt-oss:20b alone is ~13GB against a constrained wired-memory limit). Raw: ${raw}`
    );
  }
}

type ChatOpts = {
  /** Sets format: "json" — for calls expecting a JSON object back (mirrors Gemini's responseMimeType). */
  json?: boolean;
  temperature?: number;
  /** Maps to Ollama's options.num_predict (equivalent to Gemini's maxOutputTokens). */
  maxTokens?: number;
  /**
   * Reasoning control. Plain models: boolean, omit to let the model use its
   * own default. gpt-oss specifically REQUIRES a level string ("low" |
   * "medium" | "high") — it has no on/off switch, and passing `false`
   * errors on gpt-oss rather than disabling reasoning. Pick the level per
   * call site in lib/cooking.ts, never leave it unset for a gpt-oss model.
   */
  think?: boolean | "low" | "medium" | "high";
  /**
   * Maps to Ollama's keep_alive — how long the model stays resident after
   * this call. -1 keeps it loaded indefinitely (used for gpt-oss:20b, whose
   * cold load is ~21s — not worth re-paying on every single answer); omit
   * to use Ollama's own default (~5 min idle unload), which is fine for the
   * small, cheap classify/parse/embed models.
   */
  keepAlive?: number;
};

// gpt-oss streams its reasoning trace as a separate "thinking" field
// alongside "content" on each chunk — deliberately not part of this type,
// so there's no field to accidentally destructure and forward to the
// client. Only "content" is ever read.
type ChatResponseBody = {
  message?: { role: string; content: string };
};

function buildChatBody(model: string, system: string, user: string, stream: boolean, opts: ChatOpts) {
  const hasOptions = opts.temperature !== undefined || opts.maxTokens !== undefined;
  return {
    model,
    stream,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(opts.json && { format: "json" }),
    ...(opts.think !== undefined && { think: opts.think }),
    ...(opts.keepAlive !== undefined && { keep_alive: opts.keepAlive }),
    ...(hasOptions && {
      options: {
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
      },
    }),
  };
}

/**
 * One-shot chat call: system + user message, stream:false. Returns the
 * assistant's message content as a string — never the "thinking" field,
 * which isn't part of ChatResponseBody at all. Pass `json: true` for calls
 * that expect structured JSON back.
 */
export async function chat(
  model: string,
  system: string,
  user: string,
  opts: ChatOpts = {}
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildChatBody(model, system, user, false, opts)),
    });
  } catch (err) {
    throw new OllamaUnavailableError(
      `Couldn't reach Ollama at ${OLLAMA_URL} (model=${model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    logIfMemoryKilled(model, body);
    throw new Error(`Ollama chat request failed (model=${model}, ${res.status}): ${body}`);
  }

  const json = (await res.json()) as ChatResponseBody;
  const content = json.message?.content;
  if (!content) throw new Error(`Ollama returned an empty chat response (model=${model})`);
  return content;
}

/**
 * Streaming chat call: same request shape as chat(), but stream:true.
 * Ollama streams newline-delimited JSON objects; each carries a
 * message.content chunk (the final answer, yielded here) and, for
 * reasoning models, a separate message.thinking chunk (the reasoning
 * trace) — that field is deliberately never read below, so it can never be
 * forwarded to the client. Only used for the final prose answer
 * generation — never for JSON-expecting calls (classification/parsing),
 * which stay one-shot.
 */
export async function* chatStream(
  model: string,
  system: string,
  user: string,
  opts: ChatOpts = {}
): AsyncGenerator<string, void, unknown> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildChatBody(model, system, user, true, opts)),
    });
  } catch (err) {
    throw new OllamaUnavailableError(
      `Couldn't reach Ollama at ${OLLAMA_URL} (model=${model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok || !res.body) {
    const body = res.body ? await res.text() : "no response body";
    logIfMemoryKilled(model, body);
    throw new Error(`Ollama chat stream request failed (model=${model}, ${res.status}): ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let gotAnyContent = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        // NOTE: intentionally not typing/reading a "thinking" field here —
        // only "content" (the final answer) is ever pulled out of a chunk.
        const parsed = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        if (parsed.error) {
          logIfMemoryKilled(model, parsed.error);
          throw new Error(`Ollama chat stream error (model=${model}): ${parsed.error}`);
        }
        if (parsed.message?.content) {
          gotAnyContent = true;
          yield parsed.message.content;
        }
        if (parsed.done) return;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!gotAnyContent) throw new Error(`Ollama returned an empty chat stream (model=${model})`);
}

/** L2-normalizes a vector to unit length. */
function l2Normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return values;
  return values.map((v) => v / magnitude);
}

type EmbedResponseBody = {
  embedding?: number[];
};

/**
 * Embeds one string via Ollama's /api/embeddings, L2-normalized before
 * returning (matches the previous Gemini embedding pipeline's convention;
 * harmless for models that are already unit-normalized).
 */
export async function embed(text: string, model: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
  } catch (err) {
    throw new OllamaUnavailableError(
      `Couldn't reach Ollama at ${OLLAMA_URL} (model=${model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embeddings request failed (model=${model}, ${res.status}): ${body}`);
  }

  const json = (await res.json()) as EmbedResponseBody;
  if (!json.embedding) throw new Error(`Ollama returned an empty embedding (model=${model})`);
  return l2Normalize(json.embedding);
}

/** The subset of an attempts row needed to compose its embedding text. */
export type EmbeddableAttempt = {
  dish: string;
  target?: string | null;
  analysis?: string | null;
  outcome?: string | null;
  changes?: string | null;
};

/**
 * Composes the text to embed for one attempts row. Dish and analysis lead
 * deliberately — analysis is the reasoning most often searched on and must
 * not get diluted by the shorter changes/outcome fields.
 */
export function composeEmbedText(row: EmbeddableAttempt): string {
  const { dish, target, analysis, outcome, changes } = row;
  return `${dish}${target ? " (imitating " + target + ")" : ""}. ${analysis ?? ""} ${outcome ?? ""} ${changes ?? ""}`;
}
