import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { DRY_RUN, dryRunLog } from "../lib/safeguards.js";

export const take_snapshots: Task = async (_payload, helpers) => {
  helpers.logger.info(`[take_snapshots] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  if (DRY_RUN) {
    dryRunLog("snapshots", "Would take weekly snapshots for all published communities");
    return;
  }

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Get all published communities
  const communities = await sql`
    SELECT id, member_count, activity_score
    FROM communities
    WHERE status = 'published'
  `;

  let snapped = 0;

  for (const community of communities) {
    try {
      // Calculate growth rate from previous snapshot
      const [prevSnapshot] = await sql`
        SELECT member_count, activity_score
        FROM community_snapshots
        WHERE community_id = ${community.id}
        ORDER BY snapshot_date DESC
        LIMIT 1
      `;

      let growthRate: number | null = null;
      let engagementRate: number | null = null;

      if (prevSnapshot?.member_count && community.member_count) {
        growthRate = ((community.member_count - prevSnapshot.member_count) / prevSnapshot.member_count) * 100;
      }

      // Insert snapshot (skip if already exists for today)
      await sql`
        INSERT INTO community_snapshots (
          community_id, snapshot_date, member_count, activity_score,
          growth_rate, engagement_rate
        ) VALUES (
          ${community.id}, ${today}, ${community.member_count},
          ${community.activity_score}, ${growthRate}, ${engagementRate}
        )
        ON CONFLICT (community_id, snapshot_date) DO NOTHING
      `;

      snapped++;
    } catch (err: any) {
      helpers.logger.error(`[take_snapshots] Error for community ${community.id}: ${err.message}`);
    }
  }

  helpers.logger.info(`[take_snapshots] Took snapshots for ${snapped}/${communities.length} communities`);
};
