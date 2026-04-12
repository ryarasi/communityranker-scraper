import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { extractCommunityData } from "../sources/gemini.js";

interface ExtractPayload {
  url: string;
  category?: string;
  platform?: string;
}

// Rate limit: Gemini free tier allows ~15 req/min
// Add delay between calls to stay under limit
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export const extract: Task = async (payload, helpers) => {
  const { url, category, platform } = payload as ExtractPayload;

  helpers.logger.info(`Extracting: ${url}`);

  // Fetch raw content from sources
  const [source] = await sql`
    SELECT raw_content FROM sources WHERE url = ${url}
  `;

  if (!source?.raw_content) {
    helpers.logger.warn(`No content found for ${url}`);
    return;
  }

  // Skip very short content (likely error pages)
  if (source.raw_content.length < 200) {
    helpers.logger.warn(`Content too short for ${url} (${source.raw_content.length} chars), skipping`);
    return;
  }

  // Truncate very large content to save tokens
  const content = source.raw_content.length > 15000
    ? source.raw_content.substring(0, 15000)
    : source.raw_content;

  try {
    // Rate limit: wait 5 seconds between Gemini calls
    await delay(5000);

    const extraction = await extractCommunityData(content);

    helpers.logger.info(`Extracted community: ${extraction.name}`);

    // Queue upsert job with category context
    await helpers.addJob("upsert", { url, extraction, category });
  } catch (err: any) {
    // If rate limited, throw to retry later with backoff
    if (err?.message?.includes('429') || err?.message?.includes('Too Many Requests')) {
      helpers.logger.warn(`Rate limited on ${url}, will retry with backoff`);
      // Wait longer before retrying
      await delay(30000);
    }
    helpers.logger.error(`Failed to extract ${url}: ${err}`);
    throw err;
  }
};
