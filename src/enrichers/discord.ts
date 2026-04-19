import { sql } from "../db/client.js";

// Track Discord rate limit state
let discordRateLimitRemaining = 50;
let discordRateLimitReset = 0;

export interface DiscordEnrichment {
  name: string;
  description: string | null;
  memberCount: number | null;
  memberCountConfidence: "approximate";
  activityScore: number;
  logoUrl: string | null;
  coverImageUrl: string | null;
  platform: "discord";
  canonicalId: string;
  canonicalGuildId: string;
}

export interface DiscordEarlyRejection {
  rejected: true;
  reason:
    | "invalid_invite_format"
    | "cached_dead_invite"
    | "dead_invite_404"
    | "invite_without_guild"
    | "below_min_member_count"
    | "zero_presence_tiny_guild"
    | `discord_api_${number}`;
}

const INVITE_REGEX = /discord\.(?:gg|com\/invite)\/([a-zA-Z0-9-]{2,16})/;

async function isDeadInviteCached(code: string): Promise<boolean> {
  const [row] = await sql<{ invite_code: string }[]>`
    SELECT invite_code FROM dead_invites
    WHERE invite_code = ${code}
      AND last_confirmed_at > NOW() - INTERVAL '7 days'
    LIMIT 1
  `;
  return !!row;
}

async function cacheDeadInvite(code: string): Promise<void> {
  await sql`
    INSERT INTO dead_invites (invite_code)
    VALUES (${code})
    ON CONFLICT (invite_code) DO UPDATE
    SET last_confirmed_at = NOW(),
        hit_count = dead_invites.hit_count + 1
  `;
}

export async function enrichViaDiscordInvite(
  url: string
): Promise<DiscordEnrichment | DiscordEarlyRejection | null> {
  // Tier 0: format check. Permanent invite codes are 2-10 chars; vanity codes up to 16.
  const match = url.match(INVITE_REGEX);
  if (!match) return { rejected: true, reason: "invalid_invite_format" };
  const inviteCode = match[1];

  // Tier 0: known-dead cache (free, zero API cost).
  if (await isDeadInviteCached(inviteCode)) {
    return { rejected: true, reason: "cached_dead_invite" };
  }

  // Respect Discord rate limits before making the one API call.
  const now = Date.now() / 1000;
  if (discordRateLimitRemaining <= 1 && now < discordRateLimitReset) {
    const waitMs = (discordRateLimitReset - now) * 1000 + 100;
    console.log(`[discord] Rate limited, waiting ${Math.round(waitMs)}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  await new Promise((r) => setTimeout(r, 100));

  // Tier 1: one `with_counts=true` call gives us liveness + activity data.
  // Replaces the previous enrichment + vet-time double check.
  const response = await fetch(
    `https://discord.com/api/v10/invites/${inviteCode}?with_counts=true`,
    { headers: { "User-Agent": "CommunityRanker/1.0" } }
  );

  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetAfter = response.headers.get("x-ratelimit-reset-after");
  if (remaining !== null) discordRateLimitRemaining = parseInt(remaining, 10);
  if (resetAfter !== null) discordRateLimitReset = Date.now() / 1000 + parseFloat(resetAfter);

  if (response.status === 404) {
    await cacheDeadInvite(inviteCode);
    return { rejected: true, reason: "dead_invite_404" };
  }
  if (!response.ok) {
    return { rejected: true, reason: `discord_api_${response.status}` as const };
  }

  const data: any = await response.json();
  const guild = data.guild;
  if (!guild) return { rejected: true, reason: "invite_without_guild" };

  const memberCount: number = data.approximate_member_count ?? 0;
  const presenceCount: number = data.approximate_presence_count ?? 0;

  // Tier 2: instant activity-based filter (no extra API call).
  if (memberCount < 25) {
    return { rejected: true, reason: "below_min_member_count" };
  }
  if (presenceCount === 0 && memberCount < 100) {
    return { rejected: true, reason: "zero_presence_tiny_guild" };
  }

  const activityScore =
    memberCount > 0 ? Math.min(100, (presenceCount / memberCount) * 100) : 0;

  return {
    name: guild.name,
    description: guild.description ?? null,
    memberCount,
    memberCountConfidence: "approximate",
    activityScore: Math.round(activityScore * 100) / 100,
    logoUrl: guild.icon
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=256`
      : null,
    coverImageUrl: null,
    platform: "discord",
    canonicalId: `discord://guild/${guild.id}`,
    canonicalGuildId: guild.id,
  };
}

export function isDiscordRejection(
  result: DiscordEnrichment | DiscordEarlyRejection | null
): result is DiscordEarlyRejection {
  return !!result && (result as DiscordEarlyRejection).rejected === true;
}
