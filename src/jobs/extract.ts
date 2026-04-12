import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { extractCommunityData } from "../sources/gemini.js";

interface ExtractPayload {
  url: string;
}

export const extract: Task = async (payload, helpers) => {
  const { url } = payload as ExtractPayload;

  helpers.logger.info(`Extracting: ${url}`);

  // Fetch raw markdown from sources
  const [source] = await sql`
    SELECT raw_content FROM sources WHERE url = ${url}
  `;

  if (!source?.raw_content) {
    helpers.logger.warn(`No markdown found for ${url}`);
    return;
  }

  try {
    const extraction = await extractCommunityData(source.raw_content);

    helpers.logger.info(`Extracted community: ${extraction.name}`);

    // Queue upsert job
    await helpers.addJob("upsert", { url, extraction });
  } catch (err) {
    helpers.logger.error(`Failed to extract ${url}: ${err}`);
    throw err;
  }
};
