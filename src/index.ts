import { run, parseCrontab } from "graphile-worker";
import { env } from "./lib/env.js";
import { preflightChecks } from "./lib/preflight.js";
import { alertSuccess, alertError } from "./lib/alerts.js";
import { DRY_RUN } from "./lib/safeguards.js";

// New pipeline jobs
import { harvest_leads } from "./jobs/harvest_leads.js";
import { enrich_community } from "./jobs/enrich_community.js";
import { vet_communities } from "./jobs/vet_communities.js";
import { refresh_stale } from "./jobs/refresh_stale.js";
import { compute_scores } from "./jobs/compute_scores.js";
import { take_snapshots } from "./jobs/take_snapshots.js";
import { harvest_hive_sitemap } from "./jobs/harvest_hive_sitemap.js";
import { harvest_hive_seed } from "./jobs/harvest_hive_seed.js";
import { harvest_disboard } from "./jobs/harvest_disboard.js";
import { harvest_curated_lists } from "./jobs/harvest_curated_lists.js";
import { harvest_skool } from "./jobs/harvest_skool.js";

async function main() {
  // Validate all API keys and connections before starting
  await preflightChecks();

  const mode = DRY_RUN ? " [DRY RUN MODE]" : "";
  await alertSuccess("Pipeline Started", `Worker connected and ready for jobs.${mode}`);
  console.log(`[pipeline] Starting worker${mode}...`);

  const runner = await run({
    connectionString: env.DATABASE_URL,
    concurrency: 2,
    noHandleSignals: false,
    pollInterval: 2000,
    taskList: {
      harvest_leads,
      enrich_community,
      vet_communities,
      refresh_stale,
      compute_scores,
      take_snapshots,
      harvest_hive_sitemap,      // One-time bulk; trigger: add_job('harvest_hive_sitemap', '{}')
      harvest_hive_seed,         // Staggered daily drip from local sitemap.
      harvest_disboard,          // Daily Disboard tag-page harvest.
      harvest_curated_lists,     // Weekly curated GitHub awesome-list harvest.
      harvest_skool,             // Weekly Skool /discovery sweep (Sunday).
    },
    parsedCronItems: parseCrontab(
      [
        // Discovery: 02:00 UTC daily
        "0 2 * * * harvest_leads ?fill=1d",
        // Disboard tag harvest: 03:00 UTC daily (§3.1)
        "0 3 * * * harvest_disboard ?fill=1d",
        // Hive sitemap staggered seed: 03:30 UTC daily (§3, Ragav's Q3)
        "30 3 * * * harvest_hive_seed ?fill=1d",
        // Curated awesome-lists: Sunday 03:00 UTC (§3.2)
        "0 3 * * 0 harvest_curated_lists ?fill=7d",
        // Skool /discovery sweep: Sunday 04:00 UTC (single-letter alphabet)
        "0 4 * * 0 harvest_skool ?fill=7d",
        // Enrichment: every 10 minutes (picks up pending URLs, now priority-ordered)
        "*/10 * * * * enrich_community ?fill=10m",
        // Vetting: 04:00 UTC daily
        "0 4 * * * vet_communities ?fill=1d",
        // Refresh stale: 05:00 UTC daily (incl. stale-Discord prune)
        "0 5 * * * refresh_stale ?fill=1d",
        // Compute scores: 06:00 UTC daily
        "0 6 * * * compute_scores ?fill=1d",
        // Weekly snapshots: Sunday 07:00 UTC
        "0 7 * * 0 take_snapshots ?fill=7d",
      ].join("\n")
    ),
  });

  await runner.promise;
}

main().catch(async (err) => {
  console.error("Worker failed:", err);
  await alertError("Pipeline Crashed", `Worker process exited with error: ${err.message ?? err}`);
  process.exit(1);
});
