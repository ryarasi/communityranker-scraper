import axios, { AxiosResponse } from "axios";
import { recordApiError, recordApiSuccess, isCircuitOpen } from "./safeguards.js";

// Defense-in-depth HTTP helper for HTML-scraping harvesters (Disboard, Skool
// discovery, future long-tail sources). Handles UA rotation, randomized
// delays, and status-code-classified retry/backoff borrowed from the
// yarasitech/clikkin-scraper http_crawler.py pattern.
//
// Why not raw axios.get(): repeated 403s on Disboard (2026-04-23) showed that
// a single static UA with no jitter gets IP-flagged fast. This wrapper fixes
// that without pulling in a residential-proxy dependency.

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
];

let uaCursor = 0;

function nextUserAgent(): string {
  const ua = USER_AGENTS[uaCursor % USER_AGENTS.length];
  uaCursor++;
  return ua;
}

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelayMs(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

export class DeadTargetError extends Error {
  constructor(public status: number, public url: string) {
    super(`Dead target ${status}: ${url}`);
    this.name = "DeadTargetError";
  }
}

export class CircuitOpenError extends Error {
  constructor(public circuitKey: string) {
    super(`Circuit open: ${circuitKey}`);
    this.name = "CircuitOpenError";
  }
}

export interface HttpGetResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface HttpGetOptions {
  timeout?: number;
  referer?: string;
  minDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  circuitKey?: string;
  acceptLanguage?: string;
  extraHeaders?: Record<string, string>;
}

// Status-code-classified retry/backoff. Shape borrowed from
// yarasitech/clikkin-scraper http_crawler.py:22-37.
export async function httpGet(
  url: string,
  opts: HttpGetOptions = {}
): Promise<HttpGetResult> {
  const {
    timeout = 15_000,
    referer,
    minDelayMs = 500,
    maxDelayMs = 800,
    maxRetries = 3,
    circuitKey,
    acceptLanguage = "en-US,en;q=0.9",
    extraHeaders = {},
  } = opts;

  if (circuitKey && isCircuitOpen(circuitKey)) {
    throw new CircuitOpenError(circuitKey);
  }

  // Courtesy delay before every request (including first) so concurrent calls
  // don't stampede the target.
  await sleep(randomDelayMs(minDelayMs, maxDelayMs));

  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt <= maxRetries) {
    const ua = attempt === 0 ? nextUserAgent() : randomUserAgent();
    const headers: Record<string, string> = {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": acceptLanguage,
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": referer ? "same-origin" : "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      ...extraHeaders,
    };
    if (referer) headers["Referer"] = referer;

    let response: AxiosResponse<string> | null = null;
    let status = 0;
    try {
      response = await axios.get<string>(url, {
        headers,
        timeout,
        // Let us inspect 4xx/5xx rather than throwing, so retry logic can
        // branch cleanly on status.
        validateStatus: () => true,
        // Skool/Disboard return HTML, not JSON — force string body.
        responseType: "text",
      });
      status = response.status;
    } catch (err) {
      lastErr = err;
      // Network / timeout / DNS — treat as 5xx-class transient.
      status = 0;
    }

    if (status >= 200 && status < 300 && response) {
      if (circuitKey) await recordApiSuccess(circuitKey);
      return {
        status,
        body: response.data,
        headers: normalizeHeaders(response.headers as Record<string, unknown>),
      };
    }

    // 404 / 410 — permanent; don't retry.
    if (status === 404 || status === 410) {
      throw new DeadTargetError(status, url);
    }

    // 403 / 429 — bot-block / rate-limit. Long backoff with UA re-pick.
    // 5xx and network errors — shorter exponential backoff.
    const isBlockClass = status === 403 || status === 429;
    const isServerClass = status >= 500 || status === 0;

    if (attempt >= maxRetries) {
      // Final attempt failed. Surface to circuit breaker if asked. We map
      // 403 → 429 so the existing safeguards transient-code set (which
      // already includes 429) counts this toward the circuit-breaker
      // threshold — a single 403 shouldn't trip, three consecutive ones
      // should.
      if (circuitKey) {
        const reportStatus = isBlockClass ? 429 : status === 0 ? 500 : status;
        await recordApiError(
          circuitKey,
          `${status || "network"} on ${url}`,
          reportStatus
        );
      }
      if (isBlockClass || isServerClass) {
        throw new Error(
          `httpGet failed after ${maxRetries + 1} attempts: ${status || "network"} ${url}`
        );
      }
      // Other 4xx (400, 401, etc.) — unlikely for HTML scraping; surface
      // status without triggering circuit.
      throw new Error(`httpGet ${status} ${url}`);
    }

    const backoffMs = isBlockClass
      ? [30_000, 60_000, 120_000][Math.min(attempt, 2)]
      : [1_000, 2_000, 4_000][Math.min(attempt, 2)];

    console.log(
      `[http] ${status || "err"} on ${url} (attempt ${attempt + 1}/${maxRetries + 1}), backing off ${backoffMs}ms`
    );
    await sleep(backoffMs);
    attempt++;
  }

  // Unreachable, but TypeScript can't prove it.
  throw lastErr instanceof Error ? lastErr : new Error("httpGet exhausted retries");
}

function normalizeHeaders(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  }
  return out;
}

// Exposed for tests — resets the round-robin cursor so unit tests are
// deterministic.
export function __resetUaCursorForTests(): void {
  uaCursor = 0;
}

export function __getUaListForTests(): readonly string[] {
  return USER_AGENTS;
}
