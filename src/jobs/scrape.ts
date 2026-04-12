import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { crawlUrl } from "../sources/spider.js";

interface ScrapePayload {
  url: string;
  title?: string;
  category?: string;
  platform?: string;
  subscribers?: number;
}

export const scrape: Task = async (payload, helpers) => {
  const { url, title, category, platform } = payload as ScrapePayload;

  helpers.logger.info(`Scraping: ${url}`);

  try {
    const markdown = await crawlUrl(url);

    if (!markdown || markdown.trim().length === 0) {
      helpers.logger.warn(`Empty content from ${url}`);
      return;
    }

    // Store raw markdown in sources table
    await sql`
      INSERT INTO sources (url, title, category, platform, raw_markdown, scraped_at)
      VALUES (${url}, ${title ?? null}, ${category ?? null}, ${platform ?? null}, ${markdown}, NOW())
      ON CONFLICT (url) DO UPDATE SET
        raw_markdown = EXCLUDED.raw_markdown,
        scraped_at = NOW()
    `;

    // Queue extraction job
    await helpers.addJob("extract", { url });

    helpers.logger.info(`Scraped and stored: ${url} (${markdown.length} chars)`);
  } catch (err) {
    helpers.logger.error(`Failed to scrape ${url}: ${err}`);
    throw err;
  }
};
