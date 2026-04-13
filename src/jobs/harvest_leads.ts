import type { Task } from "graphile-worker";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN } from "../lib/safeguards.js";
import { harvestRedditApi } from "../harvesters/reddit-api.js";
import { harvestSerperSmart } from "../harvesters/serper-smart.js";

export const harvest_leads: Task = async (_payload, helpers) => {
  helpers.logger.info(`[harvest_leads] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  const counts: Record<string, number> = {};

  // Run harvesters sequentially to respect rate limits
  const harvesters: [string, () => Promise<number>][] = [
    ["reddit_api", harvestRedditApi],
    ["serper_smart", harvestSerperSmart],
  ];

  let totalInserted = 0;

  for (const [name, harvester] of harvesters) {
    try {
      helpers.logger.info(`[harvest_leads] Running ${name}...`);
      const count = await harvester();
      counts[name] = count;
      totalInserted += count;
      helpers.logger.info(`[harvest_leads] ${name}: discovered ${count} new URLs`);
    } catch (err: any) {
      helpers.logger.error(`[harvest_leads] ${name} failed: ${err.message}`);
      counts[name] = -1; // indicate failure
      await alertError(
        `Harvester Failed: ${name}`,
        `Error: ${err.message}`
      );
    }
  }

  const summary = Object.entries(counts)
    .map(([name, count]) => `${name}: ${count === -1 ? "FAILED" : count}`)
    .join(", ");

  helpers.logger.info(`[harvest_leads] Complete. Total: ${totalInserted}. Breakdown: ${summary}`);

  await alertSuccess(
    "Harvest Complete",
    `Discovered ${totalInserted} new URLs.\n${summary}`
  );
};
