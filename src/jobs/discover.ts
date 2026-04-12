import type { Task } from "graphile-worker";
import { sql } from "../db/client.js";
import { searchCommunities } from "../sources/serper.js";
import { discoverSubreddits } from "../sources/reddit.js";

const CATEGORIES = [
  "developer",
  "design",
  "startup",
  "marketing",
  "data science",
  "product management",
  "cybersecurity",
  "AI machine learning",
  "web3 blockchain",
  "DevOps",
];

const PLATFORMS = ["discord", "slack", "reddit", "facebook group"];

export const discover: Task = async (_payload, helpers) => {
  helpers.logger.info("Starting community discovery");

  for (const category of CATEGORIES) {
    // Search across platforms
    for (const platform of PLATFORMS) {
      try {
        const results = await searchCommunities(category, platform);

        for (const result of results) {
          const url = result.link;

          // Check if URL already exists in DB
          const existing = await sql`
            SELECT id FROM communities WHERE primary_url = ${url}
          `;

          if (existing.length === 0) {
            // Add to scrape queue
            await helpers.addJob("scrape", {
              url,
              title: result.title,
              category,
              platform,
            });
            helpers.logger.info(`Queued new URL for scraping: ${url}`);
          }
        }
      } catch (err) {
        helpers.logger.error(
          `Failed to search ${category}/${platform}: ${err}`
        );
      }
    }

    // Also discover subreddits
    try {
      const subreddits = await discoverSubreddits(category);
      for (const sub of subreddits) {
        const existing = await sql`
          SELECT id FROM communities WHERE primary_url = ${sub.url}
        `;
        if (existing.length === 0) {
          await helpers.addJob("scrape", {
            url: sub.url,
            title: sub.name,
            category,
            platform: "reddit",
            subscribers: sub.subscribers,
          });
        }
      }
    } catch (err) {
      helpers.logger.error(
        `Failed to discover subreddits for ${category}: ${err}`
      );
    }
  }

  helpers.logger.info("Discovery complete");
};
