// One-shot seed for the Skool /discovery harvester (see
// harvesters/skool-discovery.ts). Run on initial rollout to drain the
// single-letter alphabet sweep; the weekly `harvest_skool` cron picks up
// deltas thereafter.
//
// Usage (from repo root):
//   DATABASE_URL=... npx tsx scripts/seed_skool_discovery.ts
//
// Respects DRY_RUN. Respects SKOOL_DISCOVERY_MAX_DAILY — set it larger for
// bulk seeding:
//   SKOOL_DISCOVERY_MAX_DAILY=2000 npx tsx scripts/seed_skool_discovery.ts
//
// To broaden past single-letter, set SKOOL_DISCOVERY_TERMS:
//   SKOOL_DISCOVERY_TERMS=ab,ac,ad,... npx tsx scripts/seed_skool_discovery.ts

import { harvestSkoolDiscovery } from "../src/harvesters/skool-discovery.js";

async function main() {
  console.log("[seed_skool_discovery] Starting one-shot sweep...");
  const inserted = await harvestSkoolDiscovery();
  console.log(`[seed_skool_discovery] Done. Inserted ${inserted} new URLs.`);
}

main().catch((err) => {
  console.error("[seed_skool_discovery] Fatal:", err);
  process.exit(1);
});
