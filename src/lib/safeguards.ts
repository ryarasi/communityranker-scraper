import { sql } from "../db/client.js";
import { alertError, alertWarning } from "./alerts.js";
import { env } from "./env.js";

// ─── DRY RUN MODE ───

export const DRY_RUN = process.env.DRY_RUN === "true";

export function dryRunLog(action: string, details: string): void {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Would ${action}: ${details}`);
  }
}

// ─── BUDGET TRACKER ───

interface SpendEntry {
  service: string;
  amount: number;
  jobId: string;
  timestamp: Date;
}

const spendLog: SpendEntry[] = [];

// Default thresholds (configurable via env)
const BUDGET_THRESHOLDS: Record<string, number> = {
  spider: parseFloat(process.env.BUDGET_SPIDER_DAILY ?? "5"),
  gemini: parseFloat(process.env.BUDGET_GEMINI_DAILY ?? "2"),
  serper: parseFloat(process.env.BUDGET_SERPER_DAILY ?? "5"),
};

export function logSpend(service: string, amount: number, jobId: string): void {
  spendLog.push({ service, amount, jobId, timestamp: new Date() });
}

export function get24hSpend(service: string): number {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return spendLog
    .filter((e) => e.service === service && e.timestamp >= cutoff)
    .reduce((sum, e) => sum + e.amount, 0);
}

// Per-service alert dedupe — prevents spamming Discord with the same warning
// every time checkBudget() is called (which happens per-URL in enrich loops).
const lastAlertAt: Map<string, number> = new Map();
const WARNING_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const EXCEEDED_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

function shouldAlert(key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastAlertAt.set(key, now);
  return true;
}

export async function checkBudget(service: string): Promise<boolean> {
  const spent = get24hSpend(service);
  const threshold = BUDGET_THRESHOLDS[service] ?? 5;

  if (spent >= threshold) {
    if (shouldAlert(`exceeded:${service}`, EXCEEDED_COOLDOWN_MS)) {
      await alertError(
        "Budget Exceeded",
        `${service} 24h spend: $${spent.toFixed(2)} (threshold: $${threshold.toFixed(2)}). Pipeline paused for this service.`
      );
    }
    return false; // over budget
  }

  if (spent >= threshold * 0.8) {
    if (shouldAlert(`warning:${service}`, WARNING_COOLDOWN_MS)) {
      await alertWarning(
        "Budget Warning",
        `${service} 24h spend: $${spent.toFixed(2)} (80% of $${threshold.toFixed(2)} threshold).`
      );
    }
  }

  return true; // under budget
}

// ─── CIRCUIT BREAKER ───

interface CircuitState {
  consecutiveErrors: number;
  lastError: string | null;
  tripped: boolean;
}

const circuits: Map<string, CircuitState> = new Map();

const CIRCUIT_THRESHOLD = 3; // consecutive errors before tripping

export function getCircuit(service: string): CircuitState {
  if (!circuits.has(service)) {
    circuits.set(service, { consecutiveErrors: 0, lastError: null, tripped: false });
  }
  return circuits.get(service)!;
}

export async function recordApiSuccess(service: string): Promise<void> {
  const circuit = getCircuit(service);
  circuit.consecutiveErrors = 0;
  circuit.lastError = null;
}

export async function recordApiError(service: string, error: string, statusCode?: number): Promise<boolean> {
  const circuit = getCircuit(service);

  // Only count transient errors toward circuit breaker
  const transientCodes = [429, 402, 500, 502, 503, 504];
  if (statusCode !== undefined && !transientCodes.includes(statusCode)) {
    return false; // not a circuit-breaker-worthy error
  }

  circuit.consecutiveErrors++;
  circuit.lastError = error;

  if (circuit.consecutiveErrors >= CIRCUIT_THRESHOLD && !circuit.tripped) {
    circuit.tripped = true;
    await alertError(
      "Circuit Breaker Tripped",
      `${service} has ${circuit.consecutiveErrors} consecutive errors. Last error: ${error}. Halting jobs for this service.`
    );
    return true; // circuit tripped
  }

  return circuit.tripped;
}

export function isCircuitOpen(service: string): boolean {
  return getCircuit(service).tripped;
}

export function resetCircuit(service: string): void {
  circuits.delete(service);
}

// ─── YIELD MONITOR ───

interface YieldStats {
  totalProcessed: number;
  validCommunities: number;
  source: string;
}

const yieldLog: YieldStats[] = [];

export function recordYield(source: string, total: number, valid: number): void {
  yieldLog.push({ totalProcessed: total, validCommunities: valid, source });
}

export async function checkYield(source: string, batchTotal: number, batchValid: number): Promise<boolean> {
  if (batchTotal < 50) return true; // too small a batch to evaluate

  const yieldRate = batchValid / batchTotal;

  if (yieldRate < 0.2) {
    await alertWarning(
      "Low Yield Alert",
      `Source "${source}": ${batchValid}/${batchTotal} valid (${(yieldRate * 100).toFixed(1)}%). Pipeline paused — yield below 20% threshold.`
    );
    return false; // yield too low
  }

  return true;
}

// ─── PER-SOURCE QUALITY TRACKING ───

export async function checkSourceQuality(source: string): Promise<void> {
  // Check rejection rate for this source in discovered_urls
  const result = await sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected
    FROM discovered_urls
    WHERE source = ${source}
    AND discovered_at > NOW() - INTERVAL '7 days'
  `;

  const { total, rejected } = result[0] as { total: number; rejected: number };

  if (total > 10 && rejected / total > 0.5) {
    await alertWarning(
      "High Rejection Rate",
      `Source "${source}": ${rejected}/${total} URLs rejected (${((rejected / total) * 100).toFixed(1)}%) in last 7 days. Consider deprioritizing.`
    );
  }
}

// ─── GEMINI REJECTION LOGGING ───

export async function logGeminiRejection(url: string, reason: string): Promise<void> {
  console.log(`[gemini-rejection] URL: ${url} | Reason: ${reason}`);
  // Also update discovered_urls if it exists
  await sql`
    UPDATE discovered_urls
    SET status = 'rejected', rejection_reason = ${reason}
    WHERE url = ${url} OR normalized_url = ${url}
  `.catch(() => {
    // URL might not be in discovered_urls (e.g., manual test)
  });
}
