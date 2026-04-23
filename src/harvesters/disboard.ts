import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { DRY_RUN, dryRunLog, isCircuitOpen } from "../lib/safeguards.js";
import { remainingDailyCap } from "../lib/daily-cap.js";
import { httpGet, CircuitOpenError, DeadTargetError } from "../lib/http.js";

// Disboard harvester (throughput-strategy §3.1).
//
// `disboard.org/robots.txt` (verified 2026-04-18) allows everything except
// `/server/join/*`. We never touch that path — we only fetch the public
// tag-listing pages and pull the invite URLs embedded in each server card.
//
// Each card links to `disboard.org/server/join/<invite-code>` (disallowed for
// us) but the card itself also includes a visible `discord.gg/<code>` URL
// which is the standard Discord public invite. We extract THAT string and
// feed it into the pipeline as a normal Discord URL — the Discord enricher
// takes it from there.

const DISBOARD_BASE = "https://disboard.org";
const SOURCE = "disboard";
const CIRCUIT_KEY = "disboard";
export const DISBOARD_MAX_DAILY = parseInt(
  process.env.DISBOARD_MAX_DAILY ?? "300",
  10
);

// Start with a hand-picked set of the largest evergreen Disboard tags.
// Ops can rotate this list based on per-tag yield over time.
const DEFAULT_TAGS = [
  "community", "gaming", "programming", "technology", "art", "music",
  "anime", "education", "writing", "startup", "crypto", "design",
  "photography", "science", "fitness", "cooking", "language",
  "finance", "marketing", "productivity", "mental-health", "career",
  "ai", "data-science", "web-development", "mobile-development",
  "open-source", "indie-dev", "game-dev", "entrepreneurship",
];

// Pull a `discord.gg/<code>` or `discord.com/invite/<code>` invite out of an
// HTML fragment (a single server card, or a page). We accept either form
// because Disboard has cycled through both over the years.
const INVITE_EXTRACT =
  /https?:\/\/(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9-]{2,16})/g;

export interface DisboardCard {
  inviteUrl: string;
  memberHint: number | null;
  name: string | null;
}

// Rough card extractor. Disboard's HTML is server-rendered and historically
// wraps each server in `<div class="server-card">`…`</div>` or similar. We
// avoid a full DOM parse (to keep deps small) and do a tolerant regex pass:
// split on common card delimiters, then inside each slice grab the first
// invite + any member-count digit cluster + best-guess name.
export function parseDisboardPage(html: string): DisboardCard[] {
  // Strip scripts/styles to reduce false positives.
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  // Use invite-URL locations as card anchors. Each unique invite is one card.
  const cards: DisboardCard[] = [];
  const seen = new Set<string>();

  const matches = clean.matchAll(INVITE_EXTRACT);
  for (const m of matches) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);

    const inviteUrl = `https://discord.gg/${code}`;
    // Look around the invite for member/name hints. Disboard cards have the
    // invite button last, with name + member count earlier in the card. A
    // ±500 char window captures the card but can leak into the previous
    // card's data for short cards, so we pick the CLOSEST match to the invite.
    const idx = m.index ?? 0;
    const startAt = Math.max(0, idx - 800);
    const windowStr = clean.slice(startAt, idx + 200);
    const relIdx = idx - startAt;

    // Closest member-count match to the invite position.
    const memberHint = findClosest(
      windowStr,
      /([0-9][0-9,]{0,7})\s*members/gi,
      relIdx,
      (m) => parseInt(m[1].replace(/,/g, ""), 10)
    );

    // Closest name match (h3 preferred, then `.server-name`).
    const name =
      findClosest(
        windowStr,
        /<h3[^>]*>\s*([^<]{3,100})\s*<\/h3>/gi,
        relIdx,
        (m) => m[1].trim()
      ) ??
      findClosest(
        windowStr,
        /server-name[^>]*>\s*([^<]{3,100})\s*</gi,
        relIdx,
        (m) => m[1].trim()
      );

    cards.push({ inviteUrl, memberHint, name });
  }

  return cards;
}

// Pick the match nearest to `anchor` (preferring matches BEFORE the anchor,
// since Disboard cards place the invite at the end).
function findClosest<T>(
  hay: string,
  regex: RegExp,
  anchor: number,
  extract: (m: RegExpMatchArray) => T
): T | null {
  let best: { value: T; distance: number } | null = null;
  for (const m of hay.matchAll(regex)) {
    const pos = m.index ?? 0;
    // Prefer matches before the invite by halving post-anchor distance scores.
    const rawDistance = Math.abs(pos - anchor);
    const distance = pos <= anchor ? rawDistance : rawDistance * 2;
    if (!best || distance < best.distance) {
      best = { value: extract(m), distance };
    }
  }
  return best ? best.value : null;
}

// Tracks the last-fetched URL so subsequent requests send a Referer that
// matches an organic browse (Disboard flags non-browser traffic by looking
// at fingerprint consistency — a request with no Referer to the third
// tag page in a row is a clear tell).
let lastDisboardUrl: string | undefined;

async function fetchDisboardTag(tag: string): Promise<string | null> {
  if (isCircuitOpen(CIRCUIT_KEY)) {
    console.log(`[disboard] Circuit open, skipping tag=${tag}`);
    return null;
  }
  const url = `${DISBOARD_BASE}/servers/tag/${encodeURIComponent(tag)}`;
  try {
    const result = await httpGet(url, {
      circuitKey: CIRCUIT_KEY,
      referer: lastDisboardUrl,
      minDelayMs: 1_500,
      maxDelayMs: 3_000,
      maxRetries: 3,
      timeout: 20_000,
    });
    lastDisboardUrl = url;
    return result.body;
  } catch (err: unknown) {
    if (err instanceof CircuitOpenError) {
      console.log(`[disboard] Circuit tripped, skipping tag=${tag}`);
      return null;
    }
    if (err instanceof DeadTargetError) {
      console.log(`[disboard] tag=${tag} 404/410, skipping`);
      return null;
    }
    console.error(`[disboard] tag=${tag} fetch failed: ${(err as Error).message}`);
    return null;
  }
}

export async function harvestDisboard(
  tags: string[] = DEFAULT_TAGS
): Promise<number> {
  if (DRY_RUN) {
    dryRunLog("disboard", `Would fetch ${tags.length} tags (cap ${DISBOARD_MAX_DAILY}/day)`);
    return 0;
  }

  let cap = await remainingDailyCap(SOURCE, DISBOARD_MAX_DAILY);
  if (cap <= 0) {
    console.log(`[disboard] Daily cap of ${DISBOARD_MAX_DAILY} already reached`);
    return 0;
  }

  let inserted = 0;

  for (const tag of tags) {
    if (cap <= 0) break;

    const html = await fetchDisboardTag(tag);
    if (!html) continue;

    const cards = parseDisboardPage(html);
    console.log(`[disboard] tag=${tag} parsed ${cards.length} cards`);

    for (const card of cards) {
      if (cap <= 0) break;
      const result = await insertDiscoveredUrl(card.inviteUrl, SOURCE, null, {
        basicName: card.name ?? undefined,
        basicMemberCount: card.memberHint ?? undefined,
      });
      if (result.inserted) {
        inserted++;
        cap--;
      }
    }
    // Pacing is handled by httpGet's pre-request delay (1.5-3s random).
  }

  console.log(`[disboard] Inserted ${inserted} new invite URLs`);
  return inserted;
}
