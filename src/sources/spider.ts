import axios from "axios";
import { env } from "../lib/env.js";
import { withRetry } from "../lib/retry.js";

const SPIDER_API_URL = "https://api.spider.cloud/crawl";
const MAX_CONCURRENT = 10;

let activeCrawls = 0;

async function acquireSemaphore(): Promise<void> {
  while (activeCrawls >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 100));
  }
  activeCrawls++;
}

function releaseSemaphore(): void {
  activeCrawls--;
}

export async function crawlUrl(url: string): Promise<string> {
  await acquireSemaphore();
  try {
    const result = await withRetry(async () => {
      const response = await axios.post(
        SPIDER_API_URL,
        {
          url,
          limit: 1,
          return_format: "markdown",
          proxy_enabled: true,
        },
        {
          headers: {
            Authorization: `Bearer ${env.SPIDER_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 60_000,
        }
      );
      return response.data;
    });

    if (Array.isArray(result) && result.length > 0) {
      return result[0].content ?? "";
    }
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  } finally {
    releaseSemaphore();
  }
}
