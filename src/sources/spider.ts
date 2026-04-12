import axios, { AxiosError } from "axios";
import { env } from "../lib/env.js";

const SPIDER_API_URL = "https://api.spider.cloud/crawl";

// Non-retryable errors — don't waste attempts
const NON_RETRYABLE_CODES = [401, 402, 403, 404];

export class SpiderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpiderAuthError";
  }
}

export async function crawlUrl(url: string): Promise<string> {
  try {
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

    const result = response.data;
    if (Array.isArray(result) && result.length > 0) {
      return result[0].content ?? "";
    }
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      const status = err.response.status;
      if (NON_RETRYABLE_CODES.includes(status)) {
        // Don't retry auth/billing/not-found errors
        throw new SpiderAuthError(
          `Spider.cloud returned ${status} for ${url}. Check API key and billing.`
        );
      }
    }
    throw err;
  }
}
