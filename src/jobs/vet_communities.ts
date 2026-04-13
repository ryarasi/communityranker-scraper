import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { alertSuccess, alertWarning } from "../lib/alerts.js";
import { DRY_RUN, dryRunLog } from "../lib/safeguards.js";
import { runVettingGates } from "../vetting/gates.js";
import { triggerDeploy } from "../lib/deploy-hook.js";

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
  if (rejected > rawCommunities.length * 0.7 && rawCommunities.length >= 10) {
    await alertWarning(
      "High Rejection Rate",
      `${rejected}/${rawCommunities.length} communities rejected. Check enrichment quality.`
    );
  }
};
