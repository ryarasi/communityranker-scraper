import type { Task } from "graphile-worker";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN } from "../lib/safeguards.js";
import { harvestAwesomeLists } from "../harvesters/awesome-lists.js";

// Weekly curated-list harvest (throughput-strategy §3.2).
// Cron: Sunday 03:00 UTC. Cap: AWESOME_LIST_MAX_DAILY (default 500 per repo).

export const harvest_curated_lists: Task = async (_payload, helpers) => {
  helpers.logger.info(`[harvest_curated_lists] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);
  try {
    const count = await harvestAwesomeLists();
    helpers.logger.info(`[harvest_curated_lists] Complete: ${count} new URLs`);
    if (count > 0) {
      await alertSuccess(
        "Curated Lists Harvest",
        `Inserted ${count} new URLs from awesome-list repos.`
      );
    }
  } catch (err: any) {
    helpers.logger.error(`[harvest_curated_lists] Failed: ${err.message}`);
    await alertError("Curated Lists Harvest Failed", err.message);
    throw err;
  }
};
