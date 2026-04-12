import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import type { CommunityExtraction } from "../schemas/community.js";

interface UpsertPayload {
  url: string;
  extraction: CommunityExtraction;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const upsert: Task = async (payload, helpers) => {
  const { url, extraction } = payload as UpsertPayload;
  const domain = extractDomain(url);

  helpers.logger.info(`Upserting community: ${extraction.name} (${domain})`);

  try {
    // Upsert into communities table, dedup by domain
    const [community] = await sql`
      INSERT INTO communities (
        name, description, primary_url, domain, platform,
        access_model, language, geo_scope, created_at, updated_at
      ) VALUES (
        ${extraction.name},
        ${extraction.description},
        ${extraction.primaryUrl},
        ${domain},
        ${extraction.platform},
        ${extraction.accessModel},
        ${extraction.language},
        ${extraction.geoScope},
        NOW(), NOW()
      )
      ON CONFLICT (domain) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        primary_url = EXCLUDED.primary_url,
        platform = EXCLUDED.platform,
        access_model = EXCLUDED.access_model,
        language = EXCLUDED.language,
        geo_scope = EXCLUDED.geo_scope,
        updated_at = NOW()
      RETURNING id
    `;

    const communityId = community!.id;

    // Upsert community profile
    await sql`
      INSERT INTO community_profiles (
        community_id, topics, founded_year, pricing_monthly, updated_at
      ) VALUES (
        ${communityId},
        ${sql.array(extraction.topics)},
        ${extraction.foundedYear},
        ${extraction.pricingMonthly},
        NOW()
      )
      ON CONFLICT (community_id) DO UPDATE SET
        topics = EXCLUDED.topics,
        founded_year = EXCLUDED.founded_year,
        pricing_monthly = EXCLUDED.pricing_monthly,
        updated_at = NOW()
    `;

    // Insert community metrics snapshot
    await sql`
      INSERT INTO community_metrics (
        community_id, member_count, member_count_confidence,
        activity_level, measured_at
      ) VALUES (
        ${communityId},
        ${extraction.memberCount},
        ${extraction.memberCountConfidence},
        ${extraction.activityLevel},
        NOW()
      )
    `;

    helpers.logger.info(
      `Upserted community ${extraction.name} with id ${communityId}`
    );
  } catch (err) {
    helpers.logger.error(
      `Failed to upsert ${extraction.name}: ${err}`
    );
    throw err;
  }
};
