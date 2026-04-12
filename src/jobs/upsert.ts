import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import type { CommunityExtraction } from "../schemas/community.js";
import { alertSuccess } from "../lib/alerts.js";

interface UpsertPayload {
  url: string;
  extraction: CommunityExtraction;
  category?: string;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function makeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export const upsert: Task = async (payload, helpers) => {
  const { url, extraction, category } = payload as UpsertPayload;
  const domain = extractDomain(url);
  const slug = makeSlug(extraction.name);

  helpers.logger.info(`Upserting community: ${extraction.name} (${domain})`);

  try {
    // Upsert into communities table — match API schema columns exactly
    const [community] = await sql`
      INSERT INTO communities (
        name, slug, description, primary_url, domain, platform,
        member_count, access_model, geo_scope, status, created_at, updated_at
      ) VALUES (
        ${extraction.name},
        ${slug},
        ${extraction.description},
        ${extraction.primaryUrl ?? url},
        ${domain},
        ${extraction.platform},
        ${extraction.memberCount},
        ${extraction.accessModel},
        ${extraction.geoScope},
        'published',
        NOW(), NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET
        description = COALESCE(NULLIF(EXCLUDED.description, ''), communities.description),
        member_count = COALESCE(EXCLUDED.member_count, communities.member_count),
        platform = COALESCE(EXCLUDED.platform, communities.platform),
        access_model = COALESCE(EXCLUDED.access_model, communities.access_model),
        updated_at = NOW()
      RETURNING id
    `;

    const communityId = community!.id;

    // Insert metrics snapshot
    await sql`
      INSERT INTO community_metrics (
        community_id, member_count, activity_score, snapshot_date
      ) VALUES (
        ${communityId},
        ${extraction.memberCount},
        ${extraction.activityLevel === 'very_active' ? 90 : extraction.activityLevel === 'active' ? 70 : extraction.activityLevel === 'moderate' ? 50 : extraction.activityLevel === 'low' ? 25 : null},
        NOW()
      )
    `;

    helpers.logger.info(
      `Upserted community ${extraction.name} (${slug}) with id ${communityId}`
    );

    await alertSuccess(
      "Community Added",
      `**${extraction.name}**\n${extraction.description ?? ''}\nPlatform: ${extraction.platform ?? 'unknown'}\nURL: ${extraction.primaryUrl ?? url}`
    );
  } catch (err) {
    helpers.logger.error(
      `Failed to upsert ${extraction.name}: ${err}`
    );
    throw err;
  }
};
