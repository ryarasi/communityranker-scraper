-- Phase 1 of the Discord early-rejection + LinkedIn discovery strategy
-- (see reports/throughput-strategy-2026-04-18.md §5 Phase 1).
--
-- Adds:
--   1. dead_invites cache so a 404 Discord invite stays rejected cheaply for 7 days.
--   2. communities.canonical_guild_id so Tier-2 widget.json refreshes can skip URL reparsing.
--   3. discovered_urls.lead_sources JSONB to stash LinkedIn-style provenance without making
--      them primary URLs (Phase 3 LinkedIn flow).
--   4. discovered_urls.priority so the enrichment queue can sort high-signal leads first
--      (Phase 2 prioritization).
-- Finishes with a one-shot prune of stale-Discord pending URLs so today's backlog doesn't
-- keep generating dead-invite rejections.

CREATE TABLE IF NOT EXISTS dead_invites (
  invite_code TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_dead_invites_last_confirmed
  ON dead_invites(last_confirmed_at);

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS canonical_guild_id TEXT;

ALTER TABLE discovered_urls
  ADD COLUMN IF NOT EXISTS lead_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

-- One-shot prune: any pending Discord URL older than 7 days is overwhelmingly
-- likely to have rotated. Mark rejected with a specific reason so the metric is
-- separable from "bad enrichment" failures.
UPDATE discovered_urls
SET status = 'rejected',
    rejection_reason = 'stale_discord_lead'
WHERE platform = 'discord'
  AND status = 'pending'
  AND discovered_at < NOW() - INTERVAL '7 days';
