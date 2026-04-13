import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { DRY_RUN, dryRunLog, checkBudget } from "../lib/safeguards.js";
import { alertSuccess } from "../lib/alerts.js";
import { enrichViaRedditApi } from "../enrichers/reddit.js";
import { enrichViaDiscordInvite } from "../enrichers/discord.js";
import { crawlUrl } from "../sources/spider.js";

export const refresh_stale: Task = async (_payload, helpers) => {
  helpers.logger.info(`[refresh_stale] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  // Tiered refresh: top 200 by rank_score weekly, rest monthly
  const staleCommunities = await sql`
    (
      SELECT id, name, primary_url, domain, platform, rank_score
      FROM communities
      WHERE status = 'published'
        AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '7 days')
      ORDER BY rank_score DESC NULLS LAST
      LIMIT 200
    )
    UNION ALL
    (
      SELECT id, name, primary_url, domain, platform, rank_score
      FROM communities
      WHERE status = 'published'
        AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '30 days')
      ORDER BY rank_score DESC NULLS LAST
      LIMIT 50
    )
  `;

  if (staleCommunities.length === 0) {
    helpers.logger.info("[refresh_stale] No stale communities to refresh");
    return;
  }

  let refreshed = 0;

  for (const community of staleCommunities) {
    if (DRY_RUN) {
      dryRunLog("refresh", `Would refresh: ${community.name}`);
      refreshed++;
      continue;
    }

    try {
      if (community.platform === "reddit") {
        const data = await enrichViaRedditApi(community.primary_url);
        if (data) {
          await sql`
            UPDATE communities SET
              member_count = ${data.memberCount},
              activity_score = ${data.activityScore},
              logo_url = COALESCE(${data.logoUrl}, logo_url),
              last_scraped_at = NOW(),
              updated_at = NOW()
            WHERE id = ${community.id}
          `;
          refreshed++;
        }
      } else if (community.platform === "discord") {
        const data = await enrichViaDiscordInvite(community.primary_url);
        if (data) {
          await sql`
            UPDATE communities SET
              member_count = ${data.memberCount},
              activity_score = ${data.activityScore},
              logo_url = COALESCE(${data.logoUrl}, logo_url),
              last_scraped_at = NOW(),
              updated_at = NOW()
            WHERE id = ${community.id}
          `;
          refreshed++;
        }
      } else {
        // For non-API platforms, just verify the URL is still live
        if (!(await checkBudget("spider"))) break;
        try {
          await crawlUrl(community.primary_url);
          await sql`UPDATE communities SET last_scraped_at = NOW(), updated_at = NOW() WHERE id = ${community.id}`;
          refreshed++;
        } catch {
          // URL might be dead — mark for review
          helpers.logger.warn(`[refresh_stale] URL may be dead: ${community.primary_url}`);
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      helpers.logger.error(`[refresh_stale] Error refreshing ${community.name}: ${err.message}`);
    }
  }

  helpers.logger.info(`[refresh_stale] Refreshed ${refreshed}/${staleCommunities.length} communities`);
  if (refreshed > 0) {
    await alertSuccess("Refresh Complete", `Refreshed ${refreshed} communities`);
  }
};
