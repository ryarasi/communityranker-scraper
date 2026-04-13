import { crawlUrl } from "../sources/spider.js";
import { extractCommunityData } from "../sources/gemini.js";
import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { checkBudget, DRY_RUN, dryRunLog } from "../lib/safeguards.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env.js";

// Hive Index topic URLs — these are category listing pages
const HIVE_TOPICS = [
  "startup", "developer", "design", "marketing", "data-science",
  "crypto", "gaming", "fitness", "writing", "photography",
  "music", "finance", "education", "health", "sustainability",
  "art", "career", "no-code", "ai", "product-management",
];

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export async function harvestHiveIndex(): Promise<number> {
  if (DRY_RUN) {
    dryRunLog("hive_index", `Would scrape ${HIVE_TOPICS.length} Hive Index topic pages`);
    return 0;
  }

  if (!(await checkBudget("spider")) || !(await checkBudget("gemini"))) {
    console.log("[hive_index] Budget exceeded, skipping");
    return 0;
  }

  let inserted = 0;

  for (const topic of HIVE_TOPICS) {
    try {
      const url = `https://thehiveindex.com/topics/${topic}/`;
      const markdown = await crawlUrl(url);

      if (!markdown || markdown.length < 100) {
        console.log(`[hive_index] Empty or too short response for ${topic}`);
        continue;
      }

      // Use Gemini to extract community listings from the directory page
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite",
        systemInstruction: `Extract ALL community listings from this directory page. Return ONLY a JSON array of objects: [{"name": "...", "url": "...", "platform": "...", "description": "...", "memberCount": number|null}]. Only include entries that link to actual community pages (Discord, Slack, Circle, etc.), not to other directory pages or blog posts.`,
      });

      const result = await model.generateContent(markdown);
      const text = result.response.text();

      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
      const jsonStr = (jsonMatch[1] ?? text).trim();

      const listings = JSON.parse(jsonStr);

      if (!Array.isArray(listings)) continue;

      for (const listing of listings) {
        if (!listing.url) continue;

        const { inserted: wasInserted } = await insertDiscoveredUrl(
          listing.url,
          "hive_index",
          url,
          {
            basicName: listing.name,
            basicDescription: listing.description,
            basicMemberCount: listing.memberCount,
            basicTopics: [topic],
          }
        );

        if (wasInserted) inserted++;
      }

      // Delay between topics (rate limits)
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err: any) {
      console.error(`[hive_index] Failed for topic "${topic}":`, err.message);
    }
  }

  return inserted;
}
