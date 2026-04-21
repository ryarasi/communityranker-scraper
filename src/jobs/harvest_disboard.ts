import type { Task } from "graphile-worker";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN } from "../lib/safeguards.js";
import { harvestDisboard } from "../harvesters/disboard.js";

// Daily Disboard tag harvest (throughput-strategy §3.1).
// Cron: 03:00 UTC daily. Cap: DISBOARD_MAX_DAILY (default 300).

export const harvest_disboard: Task = async (_payload, helpers) => {
  helpers.logger.info(`[harvest_disboard] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);
  try {
    const count = await harvestDisboard();
    helpers.logger.info(`[harvest_disboard] Complete: ${count} new URLs`);
    if (count > 0) {
      await alertSuccess(
        "Disboard Harvest",
        `Inserted ${count} new Discord invite URLs from Disboard tags.`
      );
    }
  } catch (err: any) {
    helpers.logger.error(`[harvest_disboard] Failed: ${err.message}`);
    await alertError("Disboard Harvest Failed", err.message);
    throw err;
  }
};
