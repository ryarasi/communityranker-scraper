import type { Task } from "graphile-worker";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN } from "../lib/safeguards.js";
import { harvestSkoolDiscovery } from "../harvesters/skool-discovery.js";

// Weekly Skool /discovery sweep.
// Cron: Sunday 04:00 UTC. Cap: SKOOL_DISCOVERY_MAX_DAILY (default 200).

export const harvest_skool: Task = async (_payload, helpers) => {
  helpers.logger.info(
    `[harvest_skool] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`
  );
  try {
    const count = await harvestSkoolDiscovery();
    helpers.logger.info(`[harvest_skool] Complete: ${count} new URLs`);
    if (count > 0) {
      await alertSuccess(
        "Skool Discovery Harvest",
        `Inserted ${count} new Skool community URLs from discovery sweep.`
      );
    }
  } catch (err: any) {
    helpers.logger.error(`[harvest_skool] Failed: ${err.message}`);
    await alertError("Skool Discovery Harvest Failed", err.message);
    throw err;
  }
};
