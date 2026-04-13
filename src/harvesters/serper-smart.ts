import { searchSmartSerper } from "../sources/serper.js";
import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { checkBudget, DRY_RUN, dryRunLog } from "../lib/safeguards.js";

const CATEGORIES = [
  "startups", "fitness", "writing", "crypto", "gaming", "design",
  "programming", "marketing", "data science", "photography", "music",
  "finance", "parenting", "cooking", "travel", "education", "health",
  "sustainability", "art", "books", "languages", "pets", "diy",
  "career", "no code",
];

export async function harvestSerperSmart(): Promise<number> {
  if (DRY_RUN) {
    dryRunLog("serper_smart", `Would run smart searches for ${CATEGORIES.length} categories`);
    return 0;
  }

  if (!(await checkBudget("serper"))) {
    console.log("[serper_smart] Budget exceeded, skipping");
    return 0;
  }

  let inserted = 0;

  for (const category of CATEGORIES) {
    try {
      const results = await searchSmartSerper(category);

      for (const result of results) {
        const { inserted: wasInserted } = await insertDiscoveredUrl(
          result.link,
          "serper",
          null,
          {
            basicName: result.title,
            basicDescription: result.snippet,
            basicTopics: [category],
          }
        );

        if (wasInserted) inserted++;
      }

      // Delay between categories
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      console.error(`[serper_smart] Failed for "${category}":`, err.message);
    }
  }

  return inserted;
}
