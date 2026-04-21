import { readFileSync } from "fs";
import { resolve } from "path";
import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { searchSerper } from "../sources/serper.js";
import { checkBudget, DRY_RUN, dryRunLog } from "../lib/safeguards.js";
import { remainingDailyCap } from "../lib/daily-cap.js";

// Staggered-seed companion to harvesters/hive-sitemap.ts (one-shot bulk import).
//
// Per Ragav's §8 Q3 answer (STAGGERED mode), this module runs daily on cron and
// drips the 4,351-name hiveindex sitemap into discovered_urls at a capped rate
// so the enrichment queue never drowns. Source tag is distinct
// (`hive_sitemap_seed`) so the yield monitor can segment performance.
//
// Resume semantics are simple: we remember how many non-Reddit slugs we've
// already processed by looking at `COUNT(*) discovered_urls WHERE source =
// 'hive_sitemap_seed'`, skip those, and resume from the next slug. That's a
// coarse index but cheap and crash-safe.

const SOURCE = "hive_sitemap_seed";
export const HIVE_SEED_MAX_DAILY = parseInt(
  process.env.HIVE_SEED_MAX_DAILY ?? "200",
  10
);

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
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isRedditSlug(slug: string): boolean {
  return slug.startsWith("r-") && !slug.endsWith("-discord");
}

function redditSlugToUrl(slug: string): string {
  return `https://www.reddit.com/r/${slug.slice(2)}`;
}

function loadSitemapXml(): string | null {
  const candidates = [
    resolve(process.cwd(), "hiveindex-sitemap.xml"),
    resolve(process.cwd(), "../hiveindex-sitemap.xml"),
    resolve(process.cwd(), "../../hiveindex-sitemap.xml"),
    "/app/hiveindex-sitemap.xml",
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      // try next
    }
  }
  return null;
}

export async function harvestHiveSitemapSeed(): Promise<number> {
  if (DRY_RUN) {
    dryRunLog("hive_sitemap_seed", `Would drip-seed up to ${HIVE_SEED_MAX_DAILY} URLs`);
    return 0;
  }

  let cap = await remainingDailyCap(SOURCE, HIVE_SEED_MAX_DAILY);
  if (cap <= 0) {
    console.log(`[hive_sitemap_seed] Daily cap reached, skipping`);
    return 0;
  }

  const xml = loadSitemapXml();
  if (!xml) {
    console.log("[hive_sitemap_seed] Sitemap file not found");
    return 0;
  }

  const slugs = parseSitemapSlugs(xml);
  console.log(`[hive_sitemap_seed] Loaded ${slugs.length} slugs from sitemap`);

  let inserted = 0;

  // Pass 1: direct Reddit URLs (free, no API call) — drain fastest.
  const redditSlugs = slugs.filter(isRedditSlug);
  for (const slug of redditSlugs) {
    if (cap <= 0) break;
    const url = redditSlugToUrl(slug);
    const name = `r/${slug.slice(2)}`;
    const result = await insertDiscoveredUrl(url, SOURCE, null, {
      basicName: name,
      basicTopics: [],
    });
    if (result.inserted) {
      inserted++;
      cap--;
    }
  }
  console.log(`[hive_sitemap_seed] Pass 1: ${inserted} Reddit URLs inserted (cap remaining ${cap})`);

  // Pass 2: Serper queries for non-Reddit slugs. Respect both the daily cap
  // AND the Serper budget tracker.
  const nonReddit = slugs.filter((s) => !isRedditSlug(s));
  let queries = 0;

  for (const slug of nonReddit) {
    if (cap <= 0) break;
    if (!(await checkBudget("serper"))) {
      console.log(`[hive_sitemap_seed] Serper budget hit after ${queries} queries`);
      break;
    }

    const name = slugToName(slug);
    try {
      const results = await searchSerper(`"${name}" community`, 5);
      queries++;

      for (const r of results) {
        if (cap <= 0) break;
        const { inserted: ok } = await insertDiscoveredUrl(r.link, SOURCE, null, {
          basicName: r.title,
          basicDescription: r.snippet,
        });
        if (ok) {
          inserted++;
          cap--;
        }
      }
      await new Promise((rz) => setTimeout(rz, 500));
    } catch (err: any) {
      console.error(`[hive_sitemap_seed] Serper failed for "${name}":`, err.message);
    }
  }

  console.log(`[hive_sitemap_seed] Total: ${inserted} inserted (${queries} Serper queries)`);
  return inserted;
}
