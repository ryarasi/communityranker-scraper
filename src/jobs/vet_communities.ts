import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { alertSuccess, alertWarning } from "../lib/alerts.js";
import { DRY_RUN, dryRunLog } from "../lib/safeguards.js";
import { runVettingGates } from "../vetting/gates.js";
import { triggerDeploy } from "../lib/deploy-hook.js";

// Rejection reasons that are "expected attrition" and should NOT count
// toward vet-time quality alerts. Dead Discord invites + stale-lead prunes
// are measured upstream now, not here. Kept as a reference for readers; the
// actual filter lives in the alert SQL below.
//   - dead_invite_<statusCode>   (enricher Tier 1)
//   - cached_dead_invite         (enricher Tier 0 cache hit)
//   - stale_discord_lead         (refresh_stale prune)

export const vet_communities: Task = async (_payload, helpers) => {
  helpers.logger.info(`[vet_communities] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  // Select all communities with status='raw'
  const rawCommunities = await sql`
    SELECT id, name, primary_url, domain, platform,
           member_count, activity_score, description, long_description
    FROM communities
    WHERE status = 'raw'
    ORDER BY created_at ASC
    LIMIT 100
  `;

  if (rawCommunities.length === 0) {
    helpers.logger.info("[vet_communities] No raw communities to vet");
    return;
  }

  let published = 0;
  let review = 0;
  let rejected = 0;

  for (const community of rawCommunities) {
    if (DRY_RUN) {
      dryRunLog("vet", `Would vet: ${community.name} (${community.id})`);
      continue;
    }

    try {
      const { allPassed, qualityScore, results } = await runVettingGates({
        id: community.id,
        name: community.name,
        primaryUrl: community.primary_url,
        domain: community.domain,
        platform: community.platform,
        memberCount: community.member_count,
        activityScore: community.activity_score,
        description: community.description,
        longDescription: community.long_description,
      });

      if (allPassed && qualityScore >= 60) {
        await sql`
          UPDATE communities
          SET status = 'published', quality_score = ${qualityScore}, updated_at = NOW()
          WHERE id = ${community.id}
        `;
        published++;
        helpers.logger.info(`[vet_communities] Published: ${community.name} (score: ${qualityScore})`);
      } else if (qualityScore >= 40) {
        await sql`
          UPDATE communities
          SET status = 'review', quality_score = ${qualityScore}, updated_at = NOW()
          WHERE id = ${community.id}
        `;
        review++;
        helpers.logger.info(`[vet_communities] Needs review: ${community.name} (score: ${qualityScore})`);
      } else {
        const failedGates = results.filter((r) => !r.passed).map((r) => r.gate);
        await sql`
          UPDATE communities
          SET status = 'rejected',
              quality_score = ${qualityScore},
              rejection_reason = ${`Failed gates: ${failedGates.join(", ")}. Score: ${qualityScore}`},
              updated_at = NOW()
          WHERE id = ${community.id}
        `;
        rejected++;
      }

      // Small delay between communities
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err: any) {
      helpers.logger.error(`[vet_communities] Error vetting ${community.name}: ${err.message}`);
    }
  }

  const summary = `Processed: ${rawCommunities.length}, Published: ${published}, Needs Review: ${review}, Rejected: ${rejected}`;
  helpers.logger.info(`[vet_communities] ${summary}`);

  if (published > 0) {
    await alertSuccess("Vetting Complete", summary);
    await triggerDeploy();
  }

  // ─── Alert logic (throughput-strategy §1.3) ───
  // Two tiers:
  //   1. Legacy 70% alert on *total* rejections — kept as a broad safety net.
  //      But: we now exempt `dead_invite_*` and `stale_discord_lead` because
  //      those are expected upstream attrition, not a quality signal.
  //   2. New 50% alert on *non-dead-invite* rejections — this is the one
  //      on-call actually cares about, because it signals enrichment quality
  //      is degrading.
  if (rawCommunities.length >= 10) {
    // Count today's rejections (by this vet run: communities just flipped to 'rejected')
    // that are NOT expected attrition. We re-query discovered_urls for the
    // broader picture since Discord invites also land in discovered_urls.
    const dayAgo = await sql<{ count: number; nondead: number }[]>`
      SELECT
        COUNT(*)::int AS count,
        COUNT(*) FILTER (
          WHERE rejection_reason IS NULL
             OR (
               rejection_reason NOT LIKE 'dead_invite_%'
               AND rejection_reason <> 'cached_dead_invite'
               AND rejection_reason <> 'stale_discord_lead'
             )
        )::int AS nondead
      FROM discovered_urls
      WHERE status = 'rejected'
        AND discovered_at > NOW() - INTERVAL '24 hours'
    `;
    const last24h = dayAgo[0]?.count ?? 0;
    const last24hNonDead = dayAgo[0]?.nondead ?? 0;

    // Tier 1 — 70% including dead invites (historical compatibility).
    if (rejected > rawCommunities.length * 0.7) {
      helpers.logger.info(
        `[vet_communities] 70% rejection threshold hit — suppressing alert if dominant cause is dead-invite attrition`
      );
      // Only alert if the non-dead-invite rejections themselves are high.
      if (last24h > 0 && last24hNonDead / last24h > 0.5) {
        await alertWarning(
          "High Rejection Rate",
          `${rejected}/${rawCommunities.length} rejected this batch. 24h non-dead-invite rejections: ${last24hNonDead}/${last24h} (${((last24hNonDead / last24h) * 100).toFixed(1)}%).`
        );
      }
    }

    // Tier 2 — new 50% threshold specifically for quality rejections.
    if (last24h >= 20 && last24hNonDead / last24h > 0.5) {
      await alertWarning(
        "Quality Rejections >50% (24h)",
        `${last24hNonDead}/${last24h} (${((last24hNonDead / last24h) * 100).toFixed(1)}%) 24h rejections are NOT dead-invite/stale-lead attrition. Check enrichment quality.`
      );
    }
  }
};
