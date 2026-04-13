import { readFileSync } from "fs";
import { resolve } from "path";
import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { searchSerper } from "../sources/serper.js";
import { checkBudget, DRY_RUN, dryRunLog } from "../lib/safeguards.js";

// Parse community slugs from the local hiveindex-sitemap.xml file.
// We never make HTTP requests to thehiveindex.com.

function parseSitemapSlugs(xmlContent: string): string[] {
  const slugs: string[] = [];
  const regex = /<loc>https:\/\/thehiveindex\.com\/communities\/([^<\/]+)\/<\/loc>/g;
  let match;
  while ((match = regex.exec(xmlContent)) !== null) {
    slugs.push(match[1]);
  }
  return slugs;
}

function slugToName(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isRedditSlug(slug: string): boolean {
  return slug.startsWith("r-") && !slug.endsWith("-discord");
}

function redditSlugToUrl(slug: string): string {
  // "r-entrepreneur" → "https://www.reddit.com/r/entrepreneur"
  const subreddit = slug.slice(2); // strip "r-"
  return `https://www.reddit.com/r/${subreddit}`;
}

export async function harvestHiveSitemap(): Promise<number> {
  // Find the sitemap file — it's in the project root (two levels up from src/harvesters/)
  // In Docker, it'll be at the repo root. Try multiple paths.
  let xmlContent: string;
  const possiblePaths = [
    resolve(process.cwd(), "hiveindex-sitemap.xml"),
    resolve(process.cwd(), "../hiveindex-sitemap.xml"),
    resolve(process.cwd(), "../../hiveindex-sitemap.xml"),
    // Docker build context copies files to /app
    "/app/hiveindex-sitemap.xml",
  ];

  let found = false;
  xmlContent = "";
  for (const p of possiblePaths) {
    try {
      xmlContent = readFileSync(p, "utf-8");
      found = true;
      console.log(`[hive-sitemap] Found sitemap at ${p}`);
      break;
    } catch {
      // try next path
    }
  }

  if (!found || !xmlContent) {
    console.log("[hive-sitemap] Sitemap file not found, skipping");
    return 0;
  }

  const slugs = parseSitemapSlugs(xmlContent);
  console.log(`[hive-sitemap] Parsed ${slugs.length} community slugs`);

  if (DRY_RUN) {
    const redditSlugs = slugs.filter(isRedditSlug);
    dryRunLog("hive-sitemap", `Would process ${slugs.length} slugs (${redditSlugs.length} Reddit direct, ${slugs.length - redditSlugs.length} Serper queries)`);
    return 0;
  }

  let inserted = 0;

  // ─── PASS 1: Direct Reddit URLs (free, no API calls) ───
  const redditSlugs = slugs.filter(isRedditSlug);
  console.log(`[hive-sitemap] Pass 1: ${redditSlugs.length} Reddit slugs (direct URL construction)`);

  for (const slug of redditSlugs) {
    const url = redditSlugToUrl(slug);
    const name = `r/${slug.slice(2)}`;

    const result = await insertDiscoveredUrl(url, "hive_sitemap", null, {
      basicName: name,
      basicTopics: [],
    });

    if (result.inserted) inserted++;
  }

  console.log(`[hive-sitemap] Pass 1 complete: ${inserted} Reddit URLs inserted`);

  // ─── PASS 2: Serper queries for non-Reddit slugs ───
  const nonRedditSlugs = slugs.filter((s) => !isRedditSlug(s));
  console.log(`[hive-sitemap] Pass 2: ${nonRedditSlugs.length} non-Reddit slugs (Serper queries)`);

  // Process in batches to respect rate limits and budget
  const BATCH_SIZE = 50;
  let serperInserted = 0;
  let queriesMade = 0;

  for (let i = 0; i < nonRedditSlugs.length; i += BATCH_SIZE) {
    if (!(await checkBudget("serper"))) {
      console.log(`[hive-sitemap] Serper budget exceeded after ${queriesMade} queries. Stopping Pass 2.`);
      break;
    }

    const batch = nonRedditSlugs.slice(i, i + BATCH_SIZE);

    for (const slug of batch) {
      const name = slugToName(slug);
      const query = `"${name}" community`;

      try {
        const results = await searchSerper(query, 5);
        queriesMade++;

        for (const result of results) {
          const { inserted: wasInserted } = await insertDiscoveredUrl(
            result.link,
            "hive_sitemap",
            null,
            {
              basicName: result.title,
              basicDescription: result.snippet,
            }
          );

          if (wasInserted) serperInserted++;
        }

        // 500ms delay between queries
        await new Promise((r) => setTimeout(r, 500));
      } catch (err: any) {
        console.error(`[hive-sitemap] Serper query failed for "${name}":`, err.message);
      }
    }
  }

  inserted += serperInserted;
  console.log(`[hive-sitemap] Pass 2 complete: ${serperInserted} URLs from ${queriesMade} Serper queries`);
  console.log(`[hive-sitemap] Total: ${inserted} new URLs inserted`);

  return inserted;
}
