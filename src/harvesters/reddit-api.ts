import axios from "axios";
import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { DRY_RUN, dryRunLog } from "../lib/safeguards.js";

// Categories to search across
const CATEGORY_QUERIES: Record<string, string[]> = {
  startups: ["startup community", "entrepreneur subreddit", "startup founders"],
  fitness: ["fitness community", "workout subreddit", "gym community"],
  writing: ["writing community", "writers subreddit", "creative writing"],
  crypto: ["cryptocurrency community", "crypto subreddit", "blockchain discussion"],
  gaming: ["gaming community", "gamer subreddit", "esports community"],
  design: ["design community", "ui ux subreddit", "graphic design"],
  programming: ["programming community", "developer subreddit", "coding"],
  marketing: ["marketing community", "digital marketing subreddit"],
  "data-science": ["data science community", "machine learning subreddit"],
  photography: ["photography community", "photographer subreddit"],
  music: ["music production community", "musician subreddit"],
  finance: ["personal finance community", "investing subreddit"],
  parenting: ["parenting community", "parents subreddit"],
  cooking: ["cooking community", "recipe subreddit", "foodie"],
  travel: ["travel community", "digital nomad subreddit"],
  education: ["online learning community", "education subreddit"],
  health: ["health community", "mental health subreddit", "wellness"],
  sustainability: ["sustainability community", "environment subreddit"],
  art: ["art community", "artist subreddit", "digital art"],
  books: ["book club community", "reading subreddit", "literature"],
  languages: ["language learning community", "polyglot subreddit"],
  pets: ["pet community", "dog owner subreddit", "cat community"],
  diy: ["diy community", "maker subreddit", "home improvement"],
  career: ["career development community", "job search subreddit"],
  "no-code": ["no code community", "low code subreddit"],
};

export async function harvestRedditApi(): Promise<number> {
  let inserted = 0;
  let consecutiveErrors = 0;

  for (const [category, queries] of Object.entries(CATEGORY_QUERIES)) {
    for (const query of queries) {
      if (DRY_RUN) {
        dryRunLog("reddit_api", `Would search Reddit for: "${query}"`);
        continue;
      }

      // Bail early if Reddit is consistently blocking us (likely needs OAuth)
      if (consecutiveErrors >= 5) {
        console.log("[reddit_api] 5+ consecutive errors — Reddit likely requires OAuth. Skipping remaining queries.");
        return inserted;
      }

      try {
        const response = await axios.get(
          "https://www.reddit.com/subreddits/search.json",
          {
            params: { q: query, limit: 25, sort: "relevance" },
            headers: { "User-Agent": "CommunityRanker/1.0" },
            timeout: 10_000,
          }
        );

        consecutiveErrors = 0; // Reset on success
        const subreddits = response.data?.data?.children ?? [];

        for (const child of subreddits) {
          const sub = child.data;
          if (!sub?.display_name) continue;

          const url = `https://www.reddit.com/r/${sub.display_name}`;
          const result = await insertDiscoveredUrl(url, "reddit_api", null, {
            basicName: sub.display_name_prefixed ?? sub.display_name,
            basicDescription: sub.public_description ?? undefined,
            basicMemberCount: sub.subscribers ?? undefined,
            basicTopics: [category],
          });

          if (result.inserted) inserted++;
        }

        // Respect Reddit rate limits: 1 request per 2 seconds
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err: any) {
        consecutiveErrors++;
        console.error(`[reddit_api] Search failed for "${query}":`, err.message);
        // Short delay on errors
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  return inserted;
}
