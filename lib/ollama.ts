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

type ChatOpts = {
  /** Sets format: "json" — for calls expecting a JSON object back (mirrors Gemini's responseMimeType). */
  json?: boolean;
  temperature?: number;
  /** Maps to Ollama's options.num_predict (equivalent to Gemini's maxOutputTokens). */
  maxTokens?: number;
  /** Explicit override for hybrid-reasoning models (e.g. qwen3.x) — omit to let the model use its own default. */
  think?: boolean;
};

type ChatResponseBody = {
  message?: { role: string; content: string };
};

/**
 * One-shot chat call: system + user message, stream:false. Returns the
 * assistant's message content as a string. Pass `json: true` for calls that
 * expect structured JSON back.
 */
export async function chat(
  model: string,
  system: string,
  user: string,
  opts: ChatOpts = {}
): Promise<string> {
  const hasOptions = opts.temperature !== undefined || opts.maxTokens !== undefined;

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(opts.json && { format: "json" }),
        ...(opts.think !== undefined && { think: opts.think }),
        ...(hasOptions && {
          options: {
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
          },
        }),
      }),
    });
  } catch (err) {
    throw new OllamaUnavailableError(
      `Couldn't reach Ollama at ${OLLAMA_URL} (model=${model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama chat request failed (model=${model}, ${res.status}): ${body}`);
  }

  const json = (await res.json()) as ChatResponseBody;
  const content = json.message?.content;
  if (!content) throw new Error(`Ollama returned an empty chat response (model=${model})`);
  return content;
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
