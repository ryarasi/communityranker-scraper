-- Phase 2 of the throughput strategy
-- (reports/throughput-strategy-2026-04-18.md §3 + phase-3b-rollout-2026-04-21).
--
-- Supporting indexes for the new harvesters + priority-ordered enrichment queue.
-- Safe to re-run — every object is created with IF NOT EXISTS.
--
-- 1. `idx_discovered_urls_status_priority` powers the new
--    `ORDER BY priority DESC, discovered_at ASC` pull in enrich_community.ts.
-- 2. `idx_discovered_urls_source_discovered_at` powers the per-source
--    staggered daily cap check (e.g. "how many Disboard URLs were inserted today?").

CREATE INDEX IF NOT EXISTS idx_discovered_urls_status_priority
  ON discovered_urls (status, priority DESC, discovered_at ASC);

CREATE INDEX IF NOT EXISTS idx_discovered_urls_source_discovered_at
  ON discovered_urls (source, discovered_at DESC);
