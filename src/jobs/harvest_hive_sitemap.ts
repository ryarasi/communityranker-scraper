import type { Task } from "graphile-worker";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN } from "../lib/safeguards.js";
import { harvestHiveSitemap } from "../harvesters/hive-sitemap.js";

// One-time job: seed discovered_urls from the local Hive Index sitemap.
// Trigger manually: SELECT graphile_worker.add_job('harvest_hive_sitemap', '{}');
// Not on cron — run once, then the URLs feed into enrich_community automatically.

export const harvest_hive_sitemap: Task = async (_payload, helpers) => {
  helpers.logger.info(`[harvest_hive_sitemap] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  try {
    const count = await harvestHiveSitemap();

    helpers.logger.info(`[harvest_hive_sitemap] Complete: ${count} new URLs inserted`);
    await alertSuccess(
      "Hive Sitemap Harvest Complete",
      `Inserted ${count} new URLs from Hive Index sitemap (one-time import).`
    );
  } catch (err: any) {
    helpers.logger.error(`[harvest_hive_sitemap] Failed: ${err.message}`);
    await alertError("Hive Sitemap Harvest Failed", err.message);
    throw err;
  }
};
