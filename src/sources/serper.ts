import axios from "axios";
import { env } from "../lib/env.js";
import { recordApiSuccess, recordApiError, isCircuitOpen, logSpend, DRY_RUN, dryRunLog } from "../lib/safeguards.js";

const SERPER_API_URL = "https://google.serper.dev/search";

// Cost: ~$0.001 per search
const SERPER_COST_PER_SEARCH = 0.001;

export interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

export async function searchSerper(
  query: string,
  num: number = 20
): Promise<SerperResult[]> {
  if (DRY_RUN) {
    dryRunLog("serper", `Would search: "${query}" (num=${num})`);
    return [];
  }

  if (isCircuitOpen("serper")) {
    console.log("[serper] Circuit breaker open, skipping search");
    return [];
  }

  try {
    const response = await axios.post(
      SERPER_API_URL,
      { q: query, num },
      {
        headers: {
          "X-API-KEY": env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );

    await recordApiSuccess("serper");
    logSpend("serper", SERPER_COST_PER_SEARCH, "search");

    const organic: SerperResult[] = (response.data.organic ?? []).map(
      (r: { title: string; link: string; snippet: string }) => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet,
      })
    );

    return organic;
  } catch (err: any) {
    const status = err?.response?.status;
    await recordApiError("serper", err.message, status);
    throw err;
  }
}

// Smart search: expanded site-scoped queries + community patterns
export async function searchSmartSerper(
  category: string,
): Promise<SerperResult[]> {
  const results: SerperResult[] = [];

  // Platform site-scoped searches
  const siteQueries = [
    `"${category}" site:discord.gg`,
    `"${category}" site:reddit.com/r/`,
    `"${category}" site:skool.com`,
    `"${category}" site:circle.so`,
  ];

  // Community pattern searches with negative filters
  const patternQueries = [
    `"${category} community" discord OR slack -site:medium.com -site:dev.to -"top 10" -"best of"`,
    `"join our ${category}" community -site:medium.com -"top 10"`,
  ];

  const allQueries = [...siteQueries, ...patternQueries];

  for (const query of allQueries) {
    try {
      const queryResults = await searchSerper(query, 10);
      results.push(...queryResults);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err: any) {
      console.error(`[serper_smart] Query failed: "${query}":`, err.message);
    }
  }

  return results;
}

// Legacy function for backward compatibility
export async function searchCommunities(
  topic: string,
  platform?: string
): Promise<SerperResult[]> {
  const query = platform
    ? `${topic} community ${platform}`
    : `${topic} online community`;

  return searchSerper(query, 20);
}
