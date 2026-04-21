import type { Task } from "graphile-worker";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN } from "../lib/safeguards.js";
import { harvestHiveSitemapSeed } from "../harvesters/hive-sitemap-seed.js";

// Staggered daily seed from the local hiveindex-sitemap.xml.
// Ragav's §8 Q3: STAGGERED mode. See harvesters/hive-sitemap-seed.ts for cap.

export const harvest_hive_seed: Task = async (_payload, helpers) => {
  helpers.logger.info(`[harvest_hive_seed] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);
  try {
    const count = await harvestHiveSitemapSeed();
    helpers.logger.info(`[harvest_hive_seed] Complete: ${count} new URLs`);
    if (count > 0) {
      await alertSuccess(
        "Hive Sitemap Seed Drip",
        `Inserted ${count} new URLs from hiveindex sitemap (daily staggered seed).`
      );
    }
  } catch (err: any) {
    helpers.logger.error(`[harvest_hive_seed] Failed: ${err.message}`);
    await alertError("Hive Sitemap Seed Failed", err.message);
    throw err;
  }
};
