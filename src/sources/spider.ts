import axios, { AxiosError } from "axios";
import { env } from "../lib/env.js";
import { recordApiSuccess, recordApiError, isCircuitOpen, logSpend, DRY_RUN, dryRunLog } from "../lib/safeguards.js";

const SPIDER_API_URL = "https://api.spider.cloud/crawl";

// Cost: ~$0.01 per page (rough average)
const SPIDER_COST_PER_PAGE = 0.01;

// Non-retryable errors — don't waste attempts
const NON_RETRYABLE_CODES = [401, 402, 403, 404];

export class SpiderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpiderAuthError";
  }
}

export async function crawlUrl(url: string): Promise<string> {
  if (DRY_RUN) {
    dryRunLog("spider", `Would crawl: ${url}`);
    return "";
  }

  if (isCircuitOpen("spider")) {
    throw new SpiderAuthError("Spider circuit breaker is open — too many consecutive errors");
  }

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

    await recordApiSuccess("spider");
    logSpend("spider", SPIDER_COST_PER_PAGE, "crawl");

    const result = response.data;
    if (Array.isArray(result) && result.length > 0) {
      return result[0].content ?? "";
    }
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      const status = err.response.status;
      await recordApiError("spider", `HTTP ${status} for ${url}`, status);

      if (NON_RETRYABLE_CODES.includes(status)) {
        throw new SpiderAuthError(
          `Spider.cloud returned ${status} for ${url}. Check API key and billing.`
        );
      }
    }
    throw err;
  }
}
