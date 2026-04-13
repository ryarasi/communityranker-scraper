import { sql } from "../db/client.js";

// ─── URL NORMALIZATION ───

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid", "yclid",
  "msclkid", "twclid", "igshid",
]);

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);

    // Lowercase scheme + host
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();

    // Remove fragment
    url.hash = "";

    // Strip tracking params
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    // Sort remaining query params
    url.searchParams.sort();

    // Remove trailing slash (but keep root slash)
    let result = url.toString();
    if (result.endsWith("/") && url.pathname !== "/") {
      result = result.slice(0, -1);
    }

    return result;
  } catch {
    return rawUrl.toLowerCase().trim();
  }
}

// ─── PLATFORM CLASSIFICATION ───

interface UrlClassification {
  platform: string;
  valid: boolean;
  reason?: string;
}

const PLATFORM_PATTERNS: [RegExp, string][] = [
  [/discord\.(gg|com\/invite)\//, "discord"],
  [/reddit\.com\/r\//, "reddit"],
  [/circle\.so\//, "circle"],
  [/skool\.com\//, "skool"],
  [/slack\.com\//, "slack"],      // Note: slack.com itself is blocked, but workspace subdomains aren't
  [/t\.me\//, "telegram"],
  [/facebook\.com\/groups\//, "facebook"],
  [/community\./, "custom"],
  [/discourse\.|\.discourse\.org/, "discourse"],
  [/groups\.google\.com\//, "google_groups"],
  [/mighty\./, "mighty_networks"],
  [/guilded\.gg\//, "guilded"],
  [/matrix\.to\/|element\.io\//, "matrix"],
];

export function inferPlatform(url: string): string {
  for (const [pattern, platform] of PLATFORM_PATTERNS) {
    if (pattern.test(url)) return platform;
  }
  return "other";
}

// Hardcoded blocklist (supplementary to DB)
const HARDCODED_BLOCKLIST = new Set([
  "medium.com", "dev.to", "hashnode.com", "wordpress.com", "blogger.com",
  "substack.com", "linkedin.com", "twitter.com", "x.com", "youtube.com",
  "wikipedia.org", "crunchbase.com", "g2.com", "capterra.com",
  "coursera.org", "udemy.com", "skillshare.com", "producthunt.com",
  "thehiveindex.com", "disboard.org", "top.gg", "slofile.com", "tgstat.com",
  "discord.com", "designlab.com",
]);

export async function classifyUrl(url: string): Promise<UrlClassification> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");

    // Check hardcoded blocklist
    for (const blocked of HARDCODED_BLOCKLIST) {
      if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
        return { platform: "blocked", valid: false, reason: `Blocked domain: ${blocked}` };
      }
    }

    // Check DB blocklist
    const [dbBlocked] = await sql`
      SELECT domain, reason FROM blocked_domains
      WHERE ${hostname} = domain OR ${hostname} LIKE '%.' || domain
      LIMIT 1
    `;

    if (dbBlocked) {
      return { platform: "blocked", valid: false, reason: `Blocked: ${dbBlocked.reason}` };
    }

    const platform = inferPlatform(url);
    return { platform, valid: true };
  } catch {
    return { platform: "unknown", valid: false, reason: "Invalid URL" };
  }
}

// ─── DEDUPLICATION ───

export async function isDuplicate(normalizedUrl: string): Promise<boolean> {
  const [existing] = await sql`
    SELECT id FROM discovered_urls WHERE normalized_url = ${normalizedUrl} LIMIT 1
  `;
  return !!existing;
}

export async function isDuplicateCommunity(domain: string, name: string): Promise<boolean> {
  if (!domain && !name) return false;

  const [existing] = await sql`
    SELECT id FROM communities
    WHERE (domain = ${domain} AND domain IS NOT NULL)
       OR (LOWER(name) = ${name.toLowerCase()} AND name IS NOT NULL)
    LIMIT 1
  `;
  return !!existing;
}

// ─── INSERT DISCOVERED URL ───

interface DiscoveredUrlMetadata {
  basicName?: string;
  basicDescription?: string;
  basicMemberCount?: number;
  basicTopics?: string[];
}

export async function insertDiscoveredUrl(
  url: string,
  source: string,
  sourceUrl: string | null,
  metadata?: DiscoveredUrlMetadata
): Promise<{ inserted: boolean; id?: number; reason?: string }> {
  const normalized = normalizeUrl(url);
  const classification = await classifyUrl(url);

  if (!classification.valid) {
    return { inserted: false, reason: classification.reason };
  }

  // Check for duplicate
  if (await isDuplicate(normalized)) {
    return { inserted: false, reason: "Duplicate URL" };
  }

  try {
    const [result] = await sql`
      INSERT INTO discovered_urls (
        url, normalized_url, source, source_url, platform,
        basic_name, basic_description, basic_member_count, basic_topics, status
      ) VALUES (
        ${url}, ${normalized}, ${source}, ${sourceUrl},
        ${classification.platform},
        ${metadata?.basicName ?? null}, ${metadata?.basicDescription ?? null},
        ${metadata?.basicMemberCount ?? null},
        ${metadata?.basicTopics ? sql`${metadata.basicTopics}::text[]` : null},
        'pending'
      )
      ON CONFLICT (normalized_url) DO NOTHING
      RETURNING id
    `;

    if (result) {
      return { inserted: true, id: result.id };
    }
    return { inserted: false, reason: "Duplicate (concurrent insert)" };
  } catch (err: any) {
    return { inserted: false, reason: err.message };
  }
}

// ─── DISCORD INVITE RESOLUTION ───

export async function resolveDiscordInvite(inviteCode: string): Promise<{
  guildId: string;
  name: string;
  memberCount?: number;
  presenceCount?: number;
  description?: string;
  iconUrl: string | null;
} | null> {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/invites/${inviteCode}?with_counts=true`,
      { headers: { "User-Agent": "CommunityRanker/1.0" } }
    );

    // Parse rate limit headers for adaptive throttling
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAfter = response.headers.get("x-ratelimit-reset-after");
    if (remaining !== null) {
      (globalThis as any).__discordRateLimitRemaining = parseInt(remaining, 10);
    }
    if (resetAfter !== null) {
      (globalThis as any).__discordRateLimitReset = Date.now() / 1000 + parseFloat(resetAfter);
    }

    if (!response.ok) return null;

    const data: any = await response.json();
    const guild = data.guild;
    if (!guild) return null;

    return {
      guildId: guild.id,
      name: guild.name,
      memberCount: data.approximate_member_count,
      presenceCount: data.approximate_presence_count,
      description: guild.description,
      iconUrl: guild.icon
        ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=256`
        : null,
    };
  } catch {
    return null;
  }
}
