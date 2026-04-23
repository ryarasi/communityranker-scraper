import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { alertSuccess, alertError } from "../lib/alerts.js";
import { DRY_RUN, dryRunLog, checkYield, recordYield, checkBudget } from "../lib/safeguards.js";
import { enrichViaRedditApi } from "../enrichers/reddit.js";
import { enrichViaDiscordInvite, isDiscordRejection } from "../enrichers/discord.js";
import { enrichViaScrape } from "../enrichers/scrape.js";
import { normalizeUrl, inferPlatform } from "../lib/url-validator.js";
import { logGeminiRejection } from "../lib/safeguards.js";
import { REDDIT_API_ENABLED } from "../harvesters/reddit-api.js";

// Known community platform URL patterns — primaryUrl should match one of these
// or be on the same domain as the discovered URL
const COMMUNITY_PLATFORM_PATTERNS = [
  /discord\.gg\//,
  /discord\.com\/invite\//,
  /join\.slack\.com\//,
  /\.slack\.com$/,
  /reddit\.com\/r\//,
  /skool\.com\//,
  /circle\.so\//,
  /\.circle\.so$/,
  /mighty\.co\//,
  /t\.me\//,
  /facebook\.com\/groups\//,
  /discourse\./,
  /guilded\.gg\//,
];

// Domains that should never be a community's primaryUrl
const INVALID_PRIMARY_DOMAINS = new Set([
  'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com',
  'linkedin.com', 'medium.com', 'substack.com', 'spotify.com',
  'anchor.fm', 'podcasts.apple.com', 'open.spotify.com',
]);

// TLD/eTLD labels we should NOT treat as the "brand" label when matching root-domain equivalence.
// Covers common TLDs, common compound-TLD chunks (co.uk, com.au, mn.co), and generic subdomains
// like "www", "app", "community" that are never the brand.
const NON_BRAND_LABELS = new Set([
  // Generic subdomains
  "www", "app", "apps", "community", "communities", "forum", "forums", "chat",
  "hub", "join", "invite", "go", "get", "my", "en", "us", "help", "support",
  "about", "info", "home", "main", "wiki", "docs", "beta", "dev", "staging",
  "members", "member", "profile", "signup", "login", "auth", "api", "cdn",
  "static", "assets", "media", "images", "img",
  // TLDs + common ccTLD chunks
  "com", "org", "net", "io", "co", "uk", "au", "de", "fr", "nl", "gg", "so",
  "fm", "tv", "ai", "me", "xyz", "site", "online", "store", "club", "social",
  "blog", "page", "pages", "mn", "live", "news", "pro", "edu", "gov", "int",
  "mobi", "biz", "info",
  // Platform-host SLDs — these are the platform, not the brand
  "slack", "discord", "skool", "circle", "reddit", "discourse", "telegram",
  "facebook", "mighty", "guilded", "matrix", "element", "kajabi", "teachable",
  "heartbeat", "tribe", "bettermode",
]);

// Collect all "brand-candidate" labels from a hostname (≥4 chars, not a TLD/generic).
// e.g. android-united.slack.com → {"android-united", "slack"}
// e.g. android-united.community → {"android-united"}
// Shared brand label between two hostnames means they refer to the same community.
function brandLabels(hostname: string): Set<string> {
  const out = new Set<string>();
  for (const label of hostname.toLowerCase().split(".")) {
    if (label.length >= 4 && !NON_BRAND_LABELS.has(label)) out.add(label);
  }
  return out;
}

function domainsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("." + b) || b.endsWith("." + a)) return true;
  // Match if the two hostnames share any non-generic label ≥4 chars
  // (handles same-brand-different-TLD and platform-hosted-vs-own-domain cases)
  const labelsA = brandLabels(a);
  for (const label of brandLabels(b)) {
    if (labelsA.has(label)) return true;
  }
  return false;
}

function isValidPrimaryUrl(primaryUrl: string, discoveredUrl: string, platform: string): { valid: boolean; reason?: string } {
  try {
    const primaryDomain = new URL(primaryUrl).hostname.replace(/^www\./, '');
    const discoveredDomain = new URL(discoveredUrl).hostname.replace(/^www\./, '');

    // Check against blocked primary domains
    for (const blocked of INVALID_PRIMARY_DOMAINS) {
      if (primaryDomain === blocked || primaryDomain.endsWith(`.${blocked}`)) {
        return { valid: false, reason: `primaryUrl domain ${primaryDomain} is not a community platform` };
      }
    }

    // Same domain, subdomain variants, or same brand root across TLDs are all fine
    // (e.g. mindoasis.mn.co ↔ mindoasis.org, irc.freenode.net ↔ freenode.net)
    if (domainsRelated(primaryDomain, discoveredDomain)) return { valid: true };

    // If primary URL matches a known community platform pattern, it's fine
    for (const pattern of COMMUNITY_PLATFORM_PATTERNS) {
      if (pattern.test(primaryUrl)) return { valid: true };
    }

    // Platform-URL consistency: check that the platform claim matches the URL
    if (platform === 'slack' && !primaryUrl.includes('slack.com')) {
      return { valid: false, reason: `platform is slack but primaryUrl ${primaryDomain} is not a slack domain` };
    }
    if (platform === 'discord' && !primaryUrl.includes('discord.gg') && !primaryUrl.includes('discord.com/invite')) {
      return { valid: false, reason: `platform is discord but primaryUrl ${primaryDomain} is not a discord invite` };
    }

    // Domain mismatch and not a recognized platform — suspicious
    return { valid: false, reason: `primaryUrl domain ${primaryDomain} doesn't match discovered domain ${discoveredDomain} and isn't a recognized community platform` };
  } catch {
    return { valid: false, reason: 'invalid primaryUrl' };
  }
}

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

  // One-shot: if Reddit is disabled, defer any pending reddit URLs so they stop
  // getting picked up each batch. They'll be un-deferred manually once OAuth lands.
  if (!REDDIT_API_ENABLED && !DRY_RUN) {
    const deferred = await sql`
      UPDATE discovered_urls
      SET status = 'deferred', rejection_reason = 'reddit_oauth_pending'
      WHERE status = 'pending' AND platform = 'reddit'
      RETURNING id
    `;
    if (deferred.length > 0) {
      helpers.logger.info(`[enrich_community] Deferred ${deferred.length} Reddit URLs — awaiting OAuth`);
    }
  }

  // Pick up pending discovered_urls (reddit excluded above while OAuth pending).
  // `priority DESC` ensures curated-list + multi-source + free-enricher URLs
  // drain ahead of generic Serper backlog. See lib/priority.ts.
  const BATCH_SIZE = 20;
  const pendingUrls = await sql`
    SELECT id, url, normalized_url, platform, source, basic_name
    FROM discovered_urls
    WHERE status = 'pending'
    ORDER BY priority DESC, discovered_at ASC
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
        const discordResult = await enrichViaDiscordInvite(row.url);
        if (isDiscordRejection(discordResult)) {
          rejected++;
          await sql`
            UPDATE discovered_urls
            SET status = 'rejected', rejection_reason = ${discordResult.reason}
            WHERE id = ${row.id}
          `;
          continue;
        }
        communityData = discordResult;
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
        rejected++;
        await sql`
          UPDATE discovered_urls
          SET status = 'rejected', rejection_reason = 'No valid community data extracted'
          WHERE id = ${row.id}
        `;
        continue;
      }

      // ── Post-extraction URL validation ──
      // Catch cases where Gemini extracted a primaryUrl pointing to an unrelated site
      if (communityData.primaryUrl) {
        const urlCheck = isValidPrimaryUrl(communityData.primaryUrl, row.url, communityData.platform || platform);
        if (!urlCheck.valid) {
          helpers.logger.warn(`[enrich_community] URL validation failed for ${row.url}: ${urlCheck.reason}`);
          await logGeminiRejection(row.url, `URL validation: ${urlCheck.reason}`);
          rejected++;
          await sql`
            UPDATE discovered_urls
            SET status = 'rejected', rejection_reason = ${`URL validation: ${urlCheck.reason}`}
            WHERE id = ${row.id}
          `;
          continue;
        }
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
          cover_image_url, canonical_guild_id, status, last_scraped_at
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
          ${communityData.canonicalGuildId ?? null},
          'raw',
          NOW()
        )
        ON CONFLICT (slug) DO UPDATE SET
          description = COALESCE(EXCLUDED.description, communities.description),
          member_count = COALESCE(EXCLUDED.member_count, communities.member_count),
          activity_score = COALESCE(EXCLUDED.activity_score, communities.activity_score),
          canonical_guild_id = COALESCE(EXCLUDED.canonical_guild_id, communities.canonical_guild_id),
          last_scraped_at = NOW(),
          updated_at = NOW()
        RETURNING id
      `;

      // Update discovered_url — persist raw extraction too so future schema changes are replayable
      const rawExtraction = communityData.rawExtraction ?? null;
      const rawMarkdownLength = communityData.rawMarkdownLength ?? null;
      await sql`
        UPDATE discovered_urls
        SET status = 'enriched',
            community_id = ${community.id},
            enriched_at = NOW(),
            raw_extraction = ${rawExtraction ? JSON.stringify(rawExtraction) : null}::jsonb,
            raw_markdown_length = ${rawMarkdownLength}
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
