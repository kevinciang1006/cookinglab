// Not "server-only" — parses an assistant's markdown chat answer into
// cook-mode data entirely client-side, so opening the cook-mode drawer never
// re-queries the model: the answer that's already on screen IS the source of
// data (dish + ingredients + steps + the user's own logged learnings, via
// ANSWER_PROMPT's "### From your log" section). A heuristic parser, not a
// real markdown AST walker — good enough because it only has to understand
// the shapes ANSWER_PROMPT/ADAPT_PROMPT/GENERATE_PROMPT are asked to produce.

export type ParsedRecipeStep = { text: string; minutes: number | null };

export type ParsedRecipe = {
  dish: string;
  ingredients: string[] | null;
  steps: ParsedRecipeStep[];
  /** The user's own logged learnings/fixes, pulled from the "### From your log" section (or a blockquote callout, as a fallback). */
  learnings: string[];
};

const DURATION_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i;

/** Pulls the first duration mention out of a step's text, converted to minutes. */
function extractMinutes(text: string): number | null {
  const match = text.match(DURATION_RE);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("hour") || unit.startsWith("hr")) return value * 60;
  if (unit.startsWith("min")) return value;
  if (unit.startsWith("sec")) return value / 60;
  return null;
}

/** Strips inline markdown emphasis markers so extracted text reads as plain prose. */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, "").replace(/(?<!\w)\*(\S.*?\S|\S)\*(?!\w)/g, "$1").trim();
}

/**
 * Parses an assistant's markdown answer into cook-mode data. Returns null if
 * it doesn't look like a recipe at all (no numbered step list found) — the
 * caller uses that to decide whether "Let's cook this" shows up.
 */
export function parseRecipeMarkdown(markdown: string): ParsedRecipe | null {
  const lines = markdown.split("\n");

  // Dish: the first heading line.
  let dish = "your cook";
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      dish = stripEmphasis(headingMatch[1]);
      break;
    }
  }

  // Ingredients, preferred source: the first markdown table whose header
  // row actually says "ingredient" — not just any table (an ADAPT answer's
  // own "Step | Detail" table, for instance, is NOT this, and mismapping
  // it here silently produces a "recipe" whose ingredients are actually
  // steps — confirmed live before this check existed). Each data row
  // (skipping the header row and the |---|---| separator) becomes
  // "Ingredient — Amount".
  const tableIngredients: string[] = [];
  let sawTable = false;
  let tableRowIndex = 0;
  let isIngredientTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow = /^\|.*\|$/.test(trimmed);
    if (isTableRow) {
      if (!sawTable) isIngredientTable = /ingredient/i.test(trimmed);
      sawTable = true;
      if (isIngredientTable && tableRowIndex >= 2) {
        const cells = trimmed
          .slice(1, -1)
          .split("|")
          .map((c) => stripEmphasis(c.trim()));
        if (cells[0]) {
          tableIngredients.push(cells[1] ? `${cells[0]} — ${cells[1]}` : cells[0]);
        }
      }
      tableRowIndex++;
    } else if (sawTable && trimmed === "") {
      if (isIngredientTable && tableIngredients.length > 0) break; // stop at the first ingredient table found
      sawTable = false;
      tableRowIndex = 0;
      isIngredientTable = false;
    }
  }

  // Steps: the first numbered ("1. ", "2)", etc.) list block. A following
  // non-empty, non-list line is treated as a wrapped continuation of the
  // previous step rather than a new one.
  const steps: ParsedRecipeStep[] = [];
  let inSteps = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const stepMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (stepMatch) {
      inSteps = true;
      const text = stripEmphasis(stepMatch[1]);
      steps.push({ text, minutes: extractMinutes(text) });
    } else if (trimmed === "") {
      if (inSteps && steps.length > 0) break; // stop at the first list found
    } else if (inSteps && steps.length > 0 && !/^[#|>*-]/.test(trimmed)) {
      steps[steps.length - 1].text += ` ${stripEmphasis(trimmed)}`;
    }
  }

  if (steps.length === 0) return null;

  // Ingredients fallback: a bullet list appearing before the step list, if
  // no table was found (ADAPT/GENERATE answers aren't guaranteed a table).
  const bulletIngredients: string[] = [];
  if (tableIngredients.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[.)]\s+/.test(trimmed)) break; // reached the step list — stop
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) bulletIngredients.push(stripEmphasis(bulletMatch[1]));
    }
  }

  // Learnings, preferred source: bullet items under a "### From your log"
  // heading (any level) — ANSWER_PROMPT's dedicated section for the user's
  // own logged fixes/lessons.
  const sectionLearnings: string[] = [];
  let inLearningsSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      inLearningsSection = /from your log/i.test(headingMatch[1]);
      continue;
    }
    if (inLearningsSection) {
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) sectionLearnings.push(stripEmphasis(bulletMatch[1]));
    }
  }

  // Fallback: blockquote ("> ...") callouts, for ADAPT/GENERATE answers
  // that don't follow the "### From your log" template.
  const quoteLearnings: string[] = [];
  let currentQuote = "";
  for (const line of lines) {
    const quoteMatch = line.match(/^>\s?(.*)/);
    if (quoteMatch) {
      currentQuote = currentQuote ? `${currentQuote} ${quoteMatch[1]}` : quoteMatch[1];
    } else if (currentQuote) {
      quoteLearnings.push(stripEmphasis(currentQuote));
      currentQuote = "";
    }
  }
  if (currentQuote) quoteLearnings.push(stripEmphasis(currentQuote));

  const learnings = sectionLearnings.length > 0 ? sectionLearnings : quoteLearnings;
  const ingredients = tableIngredients.length > 0 ? tableIngredients : bulletIngredients;

  return {
    dish,
    ingredients: ingredients.length > 0 ? ingredients : null,
    steps,
    learnings,
  };
}

// ---------------------------------------------------------------------------
// Recipes layer (distinct from cook-mode above): saving a chat answer as a
// recipes-table row needs *structured* {item, amount} ingredient pairs and a
// one-line summary, not the combined display strings/learnings ParsedRecipe
// returns. Kept as its own function/types rather than reshaping
// parseRecipeMarkdown, so cook-mode (already shipped) is untouched by this.
// ---------------------------------------------------------------------------

export type RecipeIngredient = { item: string; amount: string | null };

export type ExtractedRecipe = {
  dish: string;
  /** The one-line intro right after the dish heading (ANSWER_PROMPT's template puts one there). Null if the answer doesn't have one. */
  summary: string | null;
  ingredients: RecipeIngredient[];
  steps: ParsedRecipeStep[];
};

/**
 * Parses an assistant's markdown answer into the recipes table's shape.
 * Returns null under the same condition as parseRecipeMarkdown: no numbered
 * step list found at all (i.e. this answer doesn't look like a recipe).
 */
export function extractRecipeForSave(markdown: string): ExtractedRecipe | null {
  const lines = markdown.split("\n");

  let dish = "your cook";
  let headingLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      dish = stripEmphasis(headingMatch[1]);
      headingLineIndex = i;
      break;
    }
  }

  // Summary: the first non-empty, non-structural line right after the dish
  // heading — ANSWER_PROMPT's template puts a one-line intro exactly there.
  let summary: string | null = null;
  if (headingLineIndex >= 0) {
    for (let i = headingLineIndex + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      if (/^#{1,4}\s+/.test(trimmed) || /^\|/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
        break;
      }
      summary = stripEmphasis(trimmed);
      break;
    }
  }

  // Ingredients, preferred source: the first markdown table whose header
  // row actually says "ingredient" (not e.g. an ADAPT answer's own
  // "Step | Detail" table — mismapping that here silently saves a
  // "recipe" whose ingredients are actually steps; confirmed live before
  // this check existed) — kept as structured {item, amount} pairs here
  // (parseRecipeMarkdown joins these into one display string instead;
  // this function doesn't).
  const tableIngredients: RecipeIngredient[] = [];
  let sawTable = false;
  let tableRowIndex = 0;
  let isIngredientTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow = /^\|.*\|$/.test(trimmed);
    if (isTableRow) {
      if (!sawTable) isIngredientTable = /ingredient/i.test(trimmed);
      sawTable = true;
      if (isIngredientTable && tableRowIndex >= 2) {
        const cells = trimmed
          .slice(1, -1)
          .split("|")
          .map((c) => stripEmphasis(c.trim()));
        if (cells[0]) tableIngredients.push({ item: cells[0], amount: cells[1] || null });
      }
      tableRowIndex++;
    } else if (sawTable && trimmed === "") {
      if (isIngredientTable && tableIngredients.length > 0) break;
      sawTable = false;
      tableRowIndex = 0;
      isIngredientTable = false;
    }
  }

  // Steps: identical extraction to parseRecipeMarkdown.
  const steps: ParsedRecipeStep[] = [];
  let inSteps = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const stepMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (stepMatch) {
      inSteps = true;
      const text = stripEmphasis(stepMatch[1]);
      steps.push({ text, minutes: extractMinutes(text) });
    } else if (trimmed === "") {
      if (inSteps && steps.length > 0) break;
    } else if (inSteps && steps.length > 0 && !/^[#|>*-]/.test(trimmed)) {
      steps[steps.length - 1].text += ` ${stripEmphasis(trimmed)}`;
    }
  }

  if (steps.length === 0) return null;

  // Ingredients fallback: a bullet list before the step list, if no table found.
  const bulletIngredients: RecipeIngredient[] = [];
  if (tableIngredients.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[.)]\s+/.test(trimmed)) break;
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) bulletIngredients.push({ item: stripEmphasis(bulletMatch[1]), amount: null });
    }
  }

  return {
    dish,
    summary,
    ingredients: tableIngredients.length > 0 ? tableIngredients : bulletIngredients,
    steps,
  };
}
