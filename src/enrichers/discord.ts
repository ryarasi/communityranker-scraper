import { resolveDiscordInvite } from "../lib/url-validator.js";

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
}

export async function enrichViaDiscordInvite(url: string): Promise<DiscordEnrichment | null> {
  // Extract invite code from URL
  const match = url.match(/discord\.(?:gg|com\/invite)\/([a-zA-Z0-9-]+)/);
  if (!match) return null;

  const inviteCode = match[1];
  const guild = await resolveDiscordInvite(inviteCode);

  if (!guild) return null;

  const activityScore =
    guild.memberCount && guild.presenceCount
      ? Math.min(100, (guild.presenceCount / guild.memberCount) * 100)
      : 0;

  return {
    name: guild.name,
    description: guild.description ?? null,
    memberCount: guild.memberCount ?? null,
    memberCountConfidence: "approximate",
    activityScore: Math.round(activityScore * 100) / 100,
    logoUrl: guild.iconUrl ?? null,
    coverImageUrl: null,
    platform: "discord",
    canonicalId: `discord://guild/${guild.guildId}`,
  };
}
