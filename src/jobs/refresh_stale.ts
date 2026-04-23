import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { DRY_RUN, dryRunLog, checkBudget } from "../lib/safeguards.js";
import { alertSuccess } from "../lib/alerts.js";
import { enrichViaRedditApi } from "../enrichers/reddit.js";
import { enrichViaDiscordInvite, isDiscordRejection } from "../enrichers/discord.js";
import { crawlUrl } from "../sources/spider.js";
import { pruneStaleDiscord } from "./prune_stale_discord.js";

// Cadence per Ragav's §8 Q1 answer (2026-04-21):
//   - published → daily
//   - raw       → every 3 days
//   - rejected  → never (dead is dead)
//
// Also runs the stale-Discord prune first so the pending backlog doesn't keep
// feeding dead-invite rejections into vet_communities.

export const refresh_stale: Task = async (_payload, helpers) => {
  helpers.logger.info(`[refresh_stale] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  // Tier 0 stale-invite prune — cheap, always run first.
  try {
    const pruned = await pruneStaleDiscord();
    if (pruned > 0) {
      helpers.logger.info(`[refresh_stale] Pruned ${pruned} stale Discord URLs`);
    }
  } catch (err: any) {
    helpers.logger.error(`[refresh_stale] prune_stale_discord failed: ${err.message}`);
  }

  // Union: top published by rank_score refreshed daily, raw communities every 3 days.
  // Rejected rows are explicitly excluded — we never re-scrape them.
  const staleCommunities = await sql`
    (
      SELECT id, name, primary_url, domain, platform, rank_score, status
      FROM communities
      WHERE status = 'published'
        AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '1 day')
      ORDER BY rank_score DESC NULLS LAST
      LIMIT 200
    )
    UNION ALL
    (
      SELECT id, name, primary_url, domain, platform, rank_score, status
      FROM communities
      WHERE status = 'raw'
        AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '3 days')
      ORDER BY created_at ASC
      LIMIT 100
    )
  `;

  if (staleCommunities.length === 0) {
    helpers.logger.info("[refresh_stale] No stale communities to refresh");
    return;
  }

  let refreshed = 0;

  for (const community of staleCommunities) {
    if (DRY_RUN) {
      dryRunLog("refresh", `Would refresh: ${community.name} (${community.status})`);
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
        if (data && !isDiscordRejection(data)) {
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
