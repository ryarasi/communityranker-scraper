// Priority heuristic for `discovered_urls.priority`.
// Higher priority drains first in `enrich_community.ts`. See
// reports/throughput-strategy-2026-04-18.md §3.3.
//
// Rationale: on a constrained worker, we want to enrich the highest-signal
// leads first, fail-fast on junk, and learn which source patterns convert.
// FIFO order otherwise lets a brand-new Disboard invite sit behind 500 stale
// Serper generic URLs from last week.

export interface PriorityInput {
  source: string;
  platform?: string | null;
  memberHint?: number | null;
  extraSources?: number; // how many *other* sources already have this normalized_url
}

// Known-high-signal harvest sources. Any `source` string that begins with one
// of these prefixes (so `awesome_list:Romaixn/awesome-communities` matches
// `awesome_list:`) gets the curated bump.
const CURATED_SOURCE_PREFIXES = [
  "awesome_list:",
  "hive_sitemap",
  "hive_sitemap_seed",
  "user_submission",
  "user_linkedin_submission",
];

const FREE_ENRICHER_PLATFORMS = new Set(["discord", "reddit"]);

// Per-source low-yield penalty. Kept here as a simple list rather than a
// dynamic DB lookup — the yield monitor in `safeguards.ts` already pauses
// sources with <20% yield for 50+ URLs; this list is an additional hint for
// priority ranking that operators can tune by hand.
const LOW_YIELD_SOURCES = new Set<string>([
  // populated by ops as we learn (empty by default)
]);

export function computePriority(input: PriorityInput): number {
  let priority = 0;
  const source = input.source ?? "";
  const platform = input.platform ?? null;

  // Curated lists / sitemap seeds / user submissions are hand-filtered — big bump.
  if (CURATED_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix))) {
    priority += 30;
  }

  // Free-enricher platforms skip Spider + Gemini entirely. Cheap and fast.
  if (platform && FREE_ENRICHER_PLATFORMS.has(platform)) {
    priority += 20;
  }

  // Disboard cards embed a member count in the tag page. A tag with ≥100
  // members already shows activity — prioritise over low-member discoveries.
  if (source === "disboard" && (input.memberHint ?? 0) >= 100) {
    priority += 15;
  }

  // LinkedIn Phase B follow-up queries — the lead is already validated, but
  // not yet resolved to a primary URL. Small bump so Phase-B re-queries don't
  // stall behind Serper generics. (Phase 3; harmless to leave in now.)
  if (source.startsWith("linkedin-followup")) {
    priority += 10;
  }

  // Multi-source boost: if another harvester already flagged this URL, it's
  // almost certainly real. +25 on top of whatever the individual source gave.
  if ((input.extraSources ?? 0) >= 1) {
    priority += 25;
  }

  // Low-yield penalty. We still enrich — just behind everything else.
  if (LOW_YIELD_SOURCES.has(source)) {
    priority -= 40;
  }

  return priority;
}
