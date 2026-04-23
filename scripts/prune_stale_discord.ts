// CLI wrapper for the stale-Discord prune function. The reusable function
// lives in src/jobs/prune_stale_discord.ts so it can be called from the
// refresh_stale cron. This script lets operators run it ad-hoc:
//
//   DATABASE_URL=... npx tsx scripts/prune_stale_discord.ts

import { pruneStaleDiscord } from "../src/jobs/prune_stale_discord.js";

pruneStaleDiscord()
  .then((count) => {
    console.log(`[prune_stale_discord] Done. Pruned ${count} rows.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[prune_stale_discord] Fatal:", err);
    process.exit(1);
  });
