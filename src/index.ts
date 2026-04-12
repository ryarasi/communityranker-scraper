import { run, parseCrontab } from "graphile-worker";
import { env } from "./lib/env.js";
import { discover } from "./jobs/discover.js";
import { scrape } from "./jobs/scrape.js";
import { extract } from "./jobs/extract.js";
import { upsert } from "./jobs/upsert.js";
import { refresh } from "./jobs/refresh.js";

async function main() {
  const runner = await run({
    connectionString: env.DATABASE_URL,
    concurrency: 2,
    noHandleSignals: false,
    pollInterval: 1000,
    taskList: {
      discover,
      scrape,
      extract,
      upsert,
      refresh,
    },
    parsedCronItems: parseCrontab(
      [
        // Discovery: 02:00 UTC daily
        "0 2 * * * discover ?fill=1d",
        // Refresh stale listings: 03:00 UTC daily
        "0 3 * * * refresh ?fill=1d",
        // Ranking recomputation: 04:00 UTC daily
        "0 4 * * * ranking ?fill=1d",
      ].join("\n")
    ),
  });

  await runner.promise;
}

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
