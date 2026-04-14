import { crawlUrl } from "../sources/spider.js";
import { extractCommunityData, generateSeoContent } from "../sources/gemini.js";
import { logGeminiRejection, checkBudget } from "../lib/safeguards.js";
import type { CommunityExtraction } from "../schemas/community.js";

export interface ScrapeEnrichment {
  name: string;
  description: string;
  primaryUrl: string;
  platform: string;
  memberCount: number | null;
  memberCountConfidence: string;
  accessModel: string;
  pricingMonthly: number | null;
  activityLevel: string;
  geoScope: string;
  language: string;
  foundedYear: number | null;
  founderName: string | null;
  uniqueValue: string | null;
  topics: string[];
  // SEO content (may be null if generation fails)
  whoShouldJoin: string | null;
  howToJoin: string | null;
  faqJson: Array<{ question: string; answer: string }> | null;
  longDescription: string | null;
  // Raw extraction (persisted on discovered_urls so future schema bugs are replayable)
  rawExtraction: unknown | null;
  rawMarkdownLength: number | null;
}

export async function enrichViaScrape(url: string): Promise<ScrapeEnrichment | null> {
  // Check budgets before making paid API calls
  if (!(await checkBudget("spider")) || !(await checkBudget("gemini"))) {
    return null;
  }

  // Step 1: Crawl with Spider.cloud
  const markdown = await crawlUrl(url);

  if (!markdown || markdown.length < 50) {
    console.log(`[scrape] Empty or too short response for ${url}`);
    return null;
  }

  // Step 2: Extract with Gemini (strict prompt)
  const extraction = await extractCommunityData(markdown);

  // Persist the raw Gemini response regardless of validation outcome, so if we
  // later loosen the schema we can replay without re-paying Spider+Gemini.
  const rawExtraction = extraction.raw;
  const rawMarkdownLength = markdown.length;

  if (!extraction.validated) {
    await logGeminiRejection(
      url,
      extraction.validationError ?? "validation failed with no raw response"
    );
    // Persist raw on the discovered_urls row even though we're rejecting
    await persistRawExtraction(url, rawExtraction, rawMarkdownLength);
    return null;
  }

  if (!extraction.validated.valid) {
    await logGeminiRejection(url, (extraction.validated as { reason: string }).reason);
    await persistRawExtraction(url, rawExtraction, rawMarkdownLength);
    return null;
  }

  const data = extraction.validated as Extract<CommunityExtraction, { valid: true }>;

  // Step 3: Generate SEO content (non-blocking — we still have the enrichment even if this fails)
  // Add 5s delay between Gemini calls for rate limiting
  await new Promise((r) => setTimeout(r, 5000));

  const seo = await generateSeoContent({
    name: data.name,
    platform: data.platform,
    memberCount: data.memberCount,
    description: data.description,
    topics: data.topics,
    accessModel: data.accessModel,
  });

  return {
    name: data.name,
    description: data.description,
    primaryUrl: data.primaryUrl || url,
    platform: data.platform,
    memberCount: data.memberCount,
    memberCountConfidence: data.memberCountConfidence,
    accessModel: data.accessModel,
    pricingMonthly: data.pricingMonthly,
    activityLevel: data.activityLevel,
    geoScope: data.geoScope,
    language: data.language,
    foundedYear: data.foundedYear,
    founderName: data.founderName,
    uniqueValue: data.uniqueValue,
    topics: data.topics,
    whoShouldJoin: seo?.whoShouldJoin ?? null,
    howToJoin: seo?.howToJoin ?? null,
    faqJson: seo?.faqJson ?? null,
    longDescription: seo?.longDescription ?? null,
    rawExtraction,
    rawMarkdownLength,
  };
}

// Stash the raw Gemini output on the discovered_urls row so a future schema change
// can replay validation without re-calling Spider or Gemini.
async function persistRawExtraction(
  url: string,
  raw: unknown,
  markdownLength: number
): Promise<void> {
  if (!raw) return;
  const { sql } = await import("../db/client.js");
  await sql`
    UPDATE discovered_urls
    SET raw_extraction = ${JSON.stringify(raw)}::jsonb,
        raw_markdown_length = ${markdownLength}
    WHERE url = ${url} OR normalized_url = ${url}
  `.catch((err) => {
    console.error(`[scrape] Failed to persist raw extraction for ${url}: ${err.message}`);
  });
}
