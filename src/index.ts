import { run, parseCrontab } from "graphile-worker";
import { env } from "./lib/env.js";
import { preflightChecks } from "./lib/preflight.js";
import { alertSuccess, alertError } from "./lib/alerts.js";
import { discover } from "./jobs/discover.js";
import { scrape } from "./jobs/scrape.js";
import { extract } from "./jobs/extract.js";
import { upsert } from "./jobs/upsert.js";
import { refresh } from "./jobs/refresh.js";

async function main() {
  // Validate all API keys and connections before starting
  await preflightChecks();

  await alertSuccess("Pipeline Started", "Worker connected and ready for jobs.");

  const runner = await run({
    connectionString: env.DATABASE_URL,
    concurrency: 2,
    noHandleSignals: false,
    pollInterval: 2000,
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
