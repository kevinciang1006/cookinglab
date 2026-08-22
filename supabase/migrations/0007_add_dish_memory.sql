-- v1e quota fix: a dedicated cache table for the per-dish "memory" summary,
-- replacing the ad-hoc use of recipes.notes. attempt_count records how many
-- attempts existed when `summary` was last generated, so the app can tell a
-- fresh cache from a stale one (a new attempt logged since) without calling
-- Gemini just to check.
create table dish_memory (
  dish text primary key,
  summary text,
  attempt_count int not null default 0,
  updated_at timestamptz not null default now()
);
