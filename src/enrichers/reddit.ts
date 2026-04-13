import axios from "axios";

export interface RedditEnrichment {
  name: string;
  description: string;
  longDescription: string | null;
  memberCount: number;
  memberCountConfidence: "exact";
  activityScore: number;
  accessModel: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  foundedYear: number | null;
  language: string;
  platform: "reddit";
}

export async function enrichViaRedditApi(url: string): Promise<RedditEnrichment | null> {
  // Parse subreddit name from URL
  const match = url.match(/reddit\.com\/r\/([^\/\?#]+)/);
  if (!match) return null;

  const subredditName = match[1];

  try {
    const response = await axios.get(
      `https://www.reddit.com/r/${subredditName}/about.json`,
      {
        headers: { "User-Agent": "CommunityRanker/1.0" },
        timeout: 10_000,
      }
    );

    const data = response.data?.data;
    if (!data) return null;

    const subscribers = data.subscribers ?? 0;
    const activeUsers = data.accounts_active ?? 0;
    const activityScore = subscribers > 0 ? Math.min(100, (activeUsers / subscribers) * 1000) : 0;

    let accessModel = "open";
    if (data.subreddit_type === "private") accessModel = "invite_only";
    else if (data.subreddit_type === "restricted") accessModel = "approval_required";

    const createdUtc = data.created_utc;
    const foundedYear = createdUtc ? new Date(createdUtc * 1000).getFullYear() : null;

    // Icon: prefer community_icon, then icon_img
    let logoUrl = data.community_icon || data.icon_img || null;
    if (logoUrl) {
      // Reddit URLs sometimes have HTML-encoded ampersands
      logoUrl = logoUrl.replace(/&amp;/g, "&");
    }

    let coverImageUrl = data.banner_background_image || data.banner_img || null;
    if (coverImageUrl) {
      coverImageUrl = coverImageUrl.replace(/&amp;/g, "&");
    }

    return {
      name: data.display_name_prefixed ?? `r/${subredditName}`,
      description: data.public_description || data.title || "",
      longDescription: data.description || null,
      memberCount: subscribers,
      memberCountConfidence: "exact",
      activityScore: Math.round(activityScore * 100) / 100,
      accessModel,
      logoUrl,
      coverImageUrl,
      foundedYear,
      language: data.lang || "en",
      platform: "reddit",
    };
  } catch (err: any) {
    console.error(`[reddit] Failed to enrich r/${subredditName}:`, err.message);
    return null;
  }
}
