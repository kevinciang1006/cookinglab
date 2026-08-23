-- Recipes layer: recipes = the cookable artifact (current best ingredients +
-- steps for a dish/variation), distinct from attempts (the log). The
-- recipes table was stubbed early (PRD §8) but never actually used (0
-- rows) — bringing it in line with the shape this layer actually needs.
-- Renames are safe with no data migration since there are no rows yet.

alter table recipes rename column name to dish;
alter table recipes rename column notes to summary;

alter table recipes add column variation_label text;
alter table recipes add column source_answer text;

-- Was vector(1536) from the original Gemini-era PRD spec, never updated
-- since recipes had no rows to migrate when attempts moved to Ollama's
-- 768-dim nomic-embed-text (see 0008_switch_to_ollama_embeddings.sql).
alter table recipes alter column embedding type vector(768);

create index recipes_dish_idx on recipes (dish);
