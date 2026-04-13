import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { DRY_RUN, dryRunLog } from "../lib/safeguards.js";

export const compute_scores: Task = async (_payload, helpers) => {
  helpers.logger.info(`[compute_scores] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  if (DRY_RUN) {
    dryRunLog("scores", "Would recompute scores for all published communities");
    return;
  }

  // Get all published communities
  const communities = await sql`
    SELECT id, name FROM communities WHERE status = 'published'
  `;

  let updated = 0;

  for (const community of communities) {
    try {
      // Call the SQL function to compute and update the score
      const [result] = await sql`
        SELECT compute_community_score(${community.id}::uuid) as score
      `;

      if (result?.score !== null) {
        updated++;
      }
    } catch (err: any) {
      helpers.logger.error(`[compute_scores] Error computing score for ${community.name}: ${err.message}`);
    }
  }

  helpers.logger.info(`[compute_scores] Updated scores for ${updated}/${communities.length} communities`);
};
