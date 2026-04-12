import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { crawlUrl } from "../sources/spider.js";

interface ScrapePayload {
  url: string;
  category?: string;
  platform?: string;
}

export const scrape: Task = async (payload, helpers) => {
  const { url, category, platform } = payload as ScrapePayload;

  helpers.logger.info(`Scraping: ${url}`);

  try {
    const markdown = await crawlUrl(url);

    if (!markdown || markdown.trim().length === 0) {
      helpers.logger.warn(`Empty content from ${url}`);
      return;
    }

    // Store raw markdown in sources table (matches API schema)
    await sql`
      INSERT INTO sources (url, raw_content, scraped_at)
      VALUES (${url}, ${markdown}, NOW())
      ON CONFLICT DO NOTHING
    `;

    // Queue extraction job
    await helpers.addJob("extract", { url, category, platform });

    helpers.logger.info(`Scraped and stored: ${url} (${markdown.length} chars)`);
  } catch (err) {
    helpers.logger.error(`Failed to scrape ${url}: ${err}`);
    throw err;
  }
};
