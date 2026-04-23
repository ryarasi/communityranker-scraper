import { sql } from "../db/client.js";

// Staggered-seed helper. Ragav's §8 Q3 answer: use "STAGGERED mode" so bulk
// seeds don't flood the enrichment queue. Each harvester declares its own
// per-source cap + priority; we gate the next insert on "how many rows did
// we insert today from this source?".

export async function todayInsertedCount(source: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM discovered_urls
    WHERE source = ${source}
      AND discovered_at >= CURRENT_DATE
  `;
  return row?.count ?? 0;
}

export async function remainingDailyCap(
  source: string,
  maxDaily: number
): Promise<number> {
  const already = await todayInsertedCount(source);
  return Math.max(0, maxDaily - already);
}
