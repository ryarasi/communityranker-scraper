import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";

const STALE_DAYS = 30;

export const refresh: Task = async (_payload, helpers) => {
  helpers.logger.info("Starting refresh of stale listings");

  // Find communities not updated in the last STALE_DAYS days
  const stale = await sql`
    SELECT id, primary_url, name
    FROM communities
    WHERE updated_at < NOW() - INTERVAL '${sql.unsafe(String(STALE_DAYS))} days'
    ORDER BY updated_at ASC
    LIMIT 100
  `;

  helpers.logger.info(`Found ${stale.length} stale listings to refresh`);

  for (const community of stale) {
    try {
      // Queue re-scrape
      await helpers.addJob("scrape", {
        url: community.primary_url,
        title: community.name,
      });

      // Decay freshness score
      await sql`
        UPDATE communities
        SET freshness_score = GREATEST(freshness_score * 0.9, 0),
            updated_at = NOW()
        WHERE id = ${community.id}
      `;

      helpers.logger.info(`Queued refresh for: ${community.name}`);
    } catch (err) {
      helpers.logger.error(
        `Failed to queue refresh for ${community.name}: ${err}`
      );
    }
  }

  helpers.logger.info("Refresh job complete");
};
