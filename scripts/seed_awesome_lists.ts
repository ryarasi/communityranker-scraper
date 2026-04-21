// One-shot seed script for the five curated awesome-list repos (see
// harvesters/awesome-lists.ts). Run once on initial rollout to kickstart the
// pipeline; from then on the weekly `harvest_curated_lists` cron picks up
// newly-added servers.
//
// Usage (from repo root):
//   DATABASE_URL=... npx tsx scripts/seed_awesome_lists.ts
//
// Respects DRY_RUN. Respects per-source daily caps — if you want the initial
// burst larger than the default 500/day, set AWESOME_LIST_MAX_DAILY=5000 in
// the env for the run.

import { harvestAwesomeLists } from "../src/harvesters/awesome-lists.js";

async function main() {
  console.log("[seed_awesome_lists] Starting one-shot seed...");
  const inserted = await harvestAwesomeLists();
  console.log(`[seed_awesome_lists] Done. Inserted ${inserted} new URLs.`);
}

main().catch((err) => {
  console.error("[seed_awesome_lists] Fatal:", err);
  process.exit(1);
});
