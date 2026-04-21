import { sql } from "../db/client.js";
import { DRY_RUN, dryRunLog } from "../lib/safeguards.js";

// Stale-Discord prune (throughput-strategy §1.2 Tier 0 "stale-URL cutoff").
//
// Discord invites older than ~7 days in `status='pending'` are overwhelmingly
// likely to have rotated since enrichment first saw them. Mark them rejected
// with a specific reason (`stale_discord_lead`) so the 70%-rejection alert
// in vet_communities.ts can exempt this bucket — it's expected attrition,
// not a quality problem.
//
// Wired into the `refresh_stale` cron job. Idempotent; safe to run repeatedly.

export async function pruneStaleDiscord(): Promise<number> {
  if (DRY_RUN) {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM discovered_urls
      WHERE platform = 'discord'
        AND status = 'pending'
        AND discovered_at < NOW() - INTERVAL '7 days'
    `;
    dryRunLog("prune_stale_discord", `Would mark ${row?.count ?? 0} stale Discord URLs as rejected`);
    return 0;
  }

  const rows = await sql<{ id: number }[]>`
    UPDATE discovered_urls
    SET status = 'rejected',
        rejection_reason = 'stale_discord_lead'
    WHERE platform = 'discord'
      AND status = 'pending'
      AND discovered_at < NOW() - INTERVAL '7 days'
    RETURNING id
  `;
  console.log(`[prune_stale_discord] Pruned ${rows.length} stale Discord URLs`);
  return rows.length;
}
