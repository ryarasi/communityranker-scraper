import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN, dryRunLog, checkYield, recordYield, checkBudget } from "../lib/safeguards.js";
import { enrichViaRedditApi } from "../enrichers/reddit.js";
import { enrichViaDiscordInvite } from "../enrichers/discord.js";
import { enrichViaScrape } from "../enrichers/scrape.js";
import { normalizeUrl, inferPlatform } from "../lib/url-validator.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Activity level to numeric score
function activityToScore(level: string): number {
  switch (level) {
    case "very_active": return 90;
    case "active": return 70;
    case "moderate": return 50;
    case "low": return 25;
    default: return 0;
  }
}

export const enrich_community: Task = async (_payload, helpers) => {
  helpers.logger.info(`[enrich_community] Starting batch${DRY_RUN ? " (DRY RUN)" : ""}...`);

  // Pick up pending discovered_urls
  const BATCH_SIZE = 20;
  const pendingUrls = await sql`
    SELECT id, url, normalized_url, platform, source, basic_name
    FROM discovered_urls
    WHERE status = 'pending'
    ORDER BY discovered_at ASC
    LIMIT ${BATCH_SIZE}
  `;

  if (pendingUrls.length === 0) {
    helpers.logger.info("[enrich_community] No pending URLs to process");
    return;
  }

  let enriched = 0;
  let failed = 0;
  let rejected = 0;

  for (const row of pendingUrls) {
    try {
      // Mark as enriching
      await sql`UPDATE discovered_urls SET status = 'enriching' WHERE id = ${row.id}`;

      if (DRY_RUN) {
        dryRunLog("enrich", `Would enrich: ${row.url} (platform: ${row.platform})`);
        enriched++;
        continue;
      }

      const platform = row.platform || inferPlatform(row.url);
      let communityData: any = null;

      // Route by platform
      if (platform === "reddit") {
        communityData = await enrichViaRedditApi(row.url);
      } else if (platform === "discord") {
        communityData = await enrichViaDiscordInvite(row.url);
      } else {
        // Generic scrape + AI extraction
        if (!(await checkBudget("spider")) || !(await checkBudget("gemini"))) {
          helpers.logger.warn("[enrich_community] Budget exceeded, pausing enrichment");
          // Revert status
          await sql`UPDATE discovered_urls SET status = 'pending' WHERE id = ${row.id}`;
          break;
        }
        communityData = await enrichViaScrape(row.url);
      }

      if (!communityData) {
        // Rejected by Gemini or API returned no data
        rejected++;
        await sql`
          UPDATE discovered_urls
          SET status = 'rejected', rejection_reason = 'No valid community data extracted'
          WHERE id = ${row.id}
        `;
        continue;
      }

      // Generate slug
      const name = communityData.name ?? row.basic_name ?? "unnamed";
      let slug = slugify(name);

      // Ensure slug uniqueness
      const [existingSlug] = await sql`SELECT id FROM communities WHERE slug = ${slug} LIMIT 1`;
      if (existingSlug) {
        slug = `${slug}-${Date.now().toString(36)}`;
      }

      const domain = extractDomain(communityData.primaryUrl || row.url);
      const activityScore = communityData.activityScore
        ?? (communityData.activityLevel ? activityToScore(communityData.activityLevel) : null);

      // Upsert into communities
      const [community] = await sql`
        INSERT INTO communities (
          name, slug, description, long_description, primary_url, domain, platform,
          member_count, member_count_confidence, activity_score,
          access_model, pricing_monthly, geo_scope, language,
          founded_year, founder_name, unique_value,
          who_should_join, how_to_join, faq_json,
          logo_url, logo_source,
          cover_image_url, status, last_scraped_at
        ) VALUES (
          ${name}, ${slug},
          ${communityData.description ?? null},
          ${communityData.longDescription ?? null},
          ${communityData.primaryUrl || row.url},
          ${domain},
          ${communityData.platform || platform},
          ${communityData.memberCount ?? null},
          ${communityData.memberCountConfidence ?? "unknown"},
          ${activityScore ?? null},
          ${communityData.accessModel ?? "open"},
          ${communityData.pricingMonthly ?? null},
          ${communityData.geoScope ?? null},
          ${communityData.language ?? "en"},
          ${communityData.foundedYear ?? null},
          ${communityData.founderName ?? null},
          ${communityData.uniqueValue ?? null},
          ${communityData.whoShouldJoin ?? null},
          ${communityData.howToJoin ?? null},
          ${communityData.faqJson ? JSON.stringify(communityData.faqJson) : null}::jsonb,
          ${communityData.logoUrl ?? null},
          ${communityData.logoUrl ? (communityData.platform === "reddit" ? "platform_cdn" : communityData.platform === "discord" ? "platform_cdn" : "og_image") : null},
          ${communityData.coverImageUrl ?? null},
          'raw',
          NOW()
        )
        ON CONFLICT (slug) DO UPDATE SET
          description = COALESCE(EXCLUDED.description, communities.description),
          member_count = COALESCE(EXCLUDED.member_count, communities.member_count),
          activity_score = COALESCE(EXCLUDED.activity_score, communities.activity_score),
          last_scraped_at = NOW(),
          updated_at = NOW()
        RETURNING id
      `;

      // Update discovered_url
      await sql`
        UPDATE discovered_urls
        SET status = 'enriched', community_id = ${community.id}, enriched_at = NOW()
        WHERE id = ${row.id}
      `;

      enriched++;
      helpers.logger.info(`[enrich_community] Enriched: ${name} (${platform})`);

      // Delay between enrichments (rate limiting)
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      failed++;
      helpers.logger.error(`[enrich_community] Failed for ${row.url}: ${err.message}`);

      await sql`
        UPDATE discovered_urls
        SET status = 'failed',
            failure_count = failure_count + 1,
            last_failure_at = NOW(),
            rejection_reason = ${err.message?.slice(0, 500) ?? "unknown error"}
        WHERE id = ${row.id}
      `;
    }
  }

  // Record yield stats
  const totalProcessed = enriched + rejected + failed;
  recordYield("batch", totalProcessed, enriched);

  // Check batch yield
  await checkYield("enrichment_batch", totalProcessed, enriched);

  const summary = `Processed: ${totalProcessed}, Enriched: ${enriched}, Rejected: ${rejected}, Failed: ${failed}`;
  helpers.logger.info(`[enrich_community] ${summary}`);

  if (enriched > 0) {
    await alertSuccess("Enrichment Batch Complete", summary);
  }
};
