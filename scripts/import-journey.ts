/**
 * Standalone bulk-import tool for journey.txt → attempts.
 *
 * Self-contained on purpose: does NOT import any app code from lib/ or app/,
 * so it keeps working even if the live app's parser changes shape later.
 * Loads its own env from .env.local via dotenv.
 *
 * Usage:
 *   npx tsx scripts/import-journey.ts parse    # journey.txt -> parsed.json
 *   npx tsx scripts/import-journey.ts import   # parsed.json -> attempts rows
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

// NOTE: the spec for this script named gemini-2.5-flash-lite, but that model
// is sunset for this API key (confirmed earlier: Gemini returns 404 "no
// longer available to new users" and names gemini-3.5-flash-lite as the
// replacement) — using that instead, same as the live app's parser.
const PARSER_MODEL = "gemini-3.5-flash-lite";

// Gemini free tier is ~15 requests/minute; stay comfortably under that.
const DELAY_MS = 4500;

const JOURNEY_PATH = "journey.txt";
const PARSED_PATH = "parsed.json";

const SYSTEM_PROMPT = `You convert a freeform cooking log line into structured JSON. Return ONLY a JSON
object with:
- kind: "attempt" | "experiment" | "note"
    attempt = a specific cook of a dish.
    experiment = a comparison or test across variants (blind taste test, comparing
                 two pre-ferments in one session, etc.).
    note = a standalone learning not tied to one specific cook.
- dish: the thing being made, normalized to a GENERIC name — the dish itself, NOT
  the variation and NOT what it imitates. E.g. "pizza dough", "chicken broth",
  "mie ayam". Multiple attempts of the same thing MUST share the exact same dish
  name so they can be compared later.
- changes: ALL variables varied this time — ingredients, ratios, method, equipment
  (e.g. "ayam kampung, legs only, pressure cooker" or "poolish pre-ferment,
  Sriboga flour, 70% hydration"). null if none stated.
- outcome: what actually happened. null if not stated.
- analysis: my interpretation — hypotheses, suspected cause, uncertainties, what to
  try next. Preserve reasoning faithfully; do not flatten. null if none.
- target: the specific external version being imitated (a restaurant/person's dish),
  if mentioned, e.g. "Mie Ayam Waringin". Otherwise null.
- rating: integer 1–10, or null if not given.
Rules:
- dish = what you're making; everything you varied = changes. When unsure whether
  something is a new dish or a variation, treat it as a variation (same dish,
  detail in changes) so attempts stay comparable.
- Never invent content. If a field isn't supported by the line, use null. Do not
  infer plausible-sounding details.
- If the line is a section header or has no loggable cooking content, return exactly
  {"skip": true}.`;

type ParsedLog = {
  skip?: boolean;
  kind?: "attempt" | "experiment" | "note";
  dish?: string;
  changes?: string | null;
  outcome?: string | null;
  analysis?: string | null;
  target?: string | null;
  rating?: number | null;
};

type ParsedEntry = {
  line: string;
  parsed: ParsedLog;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseLine(ai: GoogleGenAI, line: string): Promise<ParsedLog> {
  const response = await ai.models.generateContent({
    model: PARSER_MODEL,
    contents: line,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
    },
  });
  const text = response.text;
  if (!text) throw new Error("empty response from Gemini");
  return JSON.parse(text) as ParsedLog;
}

async function runParse(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (check .env.local)");
  if (!existsSync(JOURNEY_PATH)) {
    throw new Error(`${JOURNEY_PATH} not found in project root`);
  }

  const ai = new GoogleGenAI({ apiKey });

  const lines = readFileSync(JOURNEY_PATH, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const results: ParsedEntry[] = [];
  let parsedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const preview = line.length > 60 ? `${line.slice(0, 60)}…` : line;
    process.stdout.write(`[${i + 1}/${lines.length}] `);

    let parsed: ParsedLog;
    try {
      parsed = await parseLine(ai, line);
    } catch (err) {
      console.log(
        `ERROR (treated as skipped): ${err instanceof Error ? err.message : String(err)} — "${preview}"`
      );
      skippedCount++;
      if (i < lines.length - 1) await sleep(DELAY_MS);
      continue;
    }

    if (parsed.skip || !parsed.dish) {
      console.log(`skipped — "${preview}"`);
      skippedCount++;
    } else {
      console.log(`parsed (${parsed.kind ?? "attempt"}): ${parsed.dish}`);
      results.push({ line, parsed });
      parsedCount++;
    }

    if (i < lines.length - 1) await sleep(DELAY_MS);
  }

  writeFileSync(PARSED_PATH, JSON.stringify(results, null, 2));

  console.log("\n--- Summary ---");
  console.log(`Total lines: ${lines.length}`);
  console.log(`Parsed:      ${parsedCount}`);
  console.log(`Skipped:     ${skippedCount}`);
  console.log(`Wrote ${PARSED_PATH}`);
}

async function runImport(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set (check .env.local)");
  }
  if (!existsSync(PARSED_PATH)) {
    throw new Error(`${PARSED_PATH} not found — run "parse" mode first`);
  }

  const entries: ParsedEntry[] = JSON.parse(readFileSync(PARSED_PATH, "utf-8"));
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const rows = entries.map(({ line, parsed }) => ({
    kind: parsed.kind ?? "attempt",
    dish: parsed.dish,
    changes: parsed.changes ?? null,
    outcome: parsed.outcome ?? null,
    analysis: parsed.analysis ?? null,
    target: parsed.target ?? null,
    rating: parsed.rating ?? null,
    note: line,
    source: "import",
    embedding: null,
  }));

  const { data, error } = await supabase.from("attempts").insert(rows).select("id");
  if (error) throw error;

  console.log(`Inserted ${data?.length ?? 0} rows into attempts.`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "parse") {
    await runParse();
  } else if (mode === "import") {
    await runImport();
  } else {
    console.error("Usage: tsx scripts/import-journey.ts <parse|import>");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
