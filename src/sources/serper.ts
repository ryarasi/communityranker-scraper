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

// Smart search: site-scoped queries only
export async function searchSmartSerper(
  category: string,
  sites: string[] = ["discord.gg", "circle.so", "skool.com"]
): Promise<SerperResult[]> {
  const results: SerperResult[] = [];

  for (const site of sites) {
    const siteResults = await searchSerper(`site:${site} ${category}`, 10);
    results.push(...siteResults);

    // Small delay between queries
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Also try "join our community" pattern
  const joinResults = await searchSerper(
    `"join our community" ${category} discord OR slack`,
    10
  );
  results.push(...joinResults);

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
