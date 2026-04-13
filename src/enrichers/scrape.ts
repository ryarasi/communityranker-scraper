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

  if (!extraction.valid) {
    await logGeminiRejection(url, (extraction as { reason: string }).reason);
    return null;
  }

  // TypeScript narrowing: extraction is the valid branch
  const data = extraction as Extract<CommunityExtraction, { valid: true }>;

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
  };
}
