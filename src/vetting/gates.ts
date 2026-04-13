import axios from "axios";
import { sql } from "../db/client.js";

export interface GateResult {
  gate: string;
  passed: boolean;
  score: number;
  details: Record<string, any>;
}

interface Community {
  id: string;
  name: string;
  primaryUrl: string;
  domain: string;
  platform: string;
  memberCount: number | null;
  activityScore: number | null;
  description: string | null;
  longDescription: string | null;
}

// ─── GATE 1: LIVENESS ───
// Does the primary URL still resolve?

export async function checkLiveness(community: Community): Promise<GateResult> {
  const gate = "liveness";

  if (!community.primaryUrl) {
    return { gate, passed: false, score: 0, details: { reason: "No primary URL" } };
  }

  try {
    // For Discord invites, check via API
    if (community.platform === "discord") {
      const match = community.primaryUrl.match(/discord\.(?:gg|com\/invite)\/([a-zA-Z0-9-]+)/);
      if (match) {
        const response = await fetch(`https://discord.com/api/v10/invites/${match[1]}`, {
          headers: { "User-Agent": "CommunityRanker/1.0" },
        });
        const alive = response.ok;
        return { gate, passed: alive, score: alive ? 100 : 0, details: { status: response.status } };
      }
    }

    // For Reddit, check the subreddit about page
    if (community.platform === "reddit") {
      const match = community.primaryUrl.match(/reddit\.com\/r\/([^\/\?#]+)/);
      if (match) {
        const response = await axios.get(
          `https://www.reddit.com/r/${match[1]}/about.json`,
          { headers: { "User-Agent": "CommunityRanker/1.0" }, timeout: 10_000 }
        );
        const data = response.data?.data;
        const isBanned = data?.subreddit_type === "archived" || data?.over_18 === true && data?.title === "";
        return { gate, passed: !isBanned, score: isBanned ? 0 : 100, details: { type: data?.subreddit_type } };
      }
    }

    // For other platforms, HEAD request
    const response = await axios.head(community.primaryUrl, {
      timeout: 10_000,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });

    return { gate, passed: true, score: 100, details: { status: response.status } };
  } catch (err: any) {
    return { gate, passed: false, score: 0, details: { error: err.message } };
  }
}

// ─── GATE 2: ACTIVITY ───
// Does the community have enough members and engagement?

export async function checkActivity(community: Community): Promise<GateResult> {
  const gate = "activity";
  const members = community.memberCount ?? 0;
  const activity = parseFloat(String(community.activityScore ?? 0));

  let passed = false;
  let score = 0;

  if (members >= 50 && activity >= 5) {
    passed = true;
    score = Math.min(100, (members / 1000) * 20 + activity);
  } else if (members >= 25 && activity >= 15) {
    // Small but mighty
    passed = true;
    score = Math.min(80, activity * 2);
  } else if (members < 25 || activity < 2) {
    passed = false;
    score = Math.max(0, members * 0.5 + activity * 2);
  } else {
    // Borderline
    passed = true;
    score = Math.min(50, members * 0.3 + activity);
  }

  return {
    gate,
    passed,
    score: Math.round(score * 100) / 100,
    details: { memberCount: members, activityScore: activity },
  };
}

// ─── GATE 3: AUTHENTICITY ───
// Is this a real community, not a sales funnel?

const SALES_KEYWORDS = [
  "exclusive opportunity", "limited spots", "make money", "passive income",
  "financial freedom", "dm me", "click the link", "sign up now",
  "once in a lifetime", "guaranteed results", "get rich", "mlm",
  "network marketing", "pyramid", "hustle culture",
];

export async function checkAuthenticity(community: Community): Promise<GateResult> {
  const gate = "authenticity";
  const text = `${community.description ?? ""} ${community.longDescription ?? ""}`.toLowerCase();

  // Count sales keyword matches
  let redFlags = 0;
  const matchedKeywords: string[] = [];

  for (const keyword of SALES_KEYWORDS) {
    if (text.includes(keyword)) {
      redFlags++;
      matchedKeywords.push(keyword);
    }
  }

  // Check description length
  const descLength = (community.description ?? "").length;
  if (descLength < 20) redFlags++;

  const passed = redFlags < 3;
  const score = Math.max(0, 100 - redFlags * 25);

  return {
    gate,
    passed,
    score,
    details: { redFlags, matchedKeywords, descriptionLength: descLength },
  };
}

// ─── GATE 4: LEGITIMACY ───
// Is the platform recognized? Is the domain not blocked?

export async function checkLegitimacy(community: Community): Promise<GateResult> {
  const gate = "legitimacy";

  const recognizedPlatforms = new Set([
    "discord", "slack", "reddit", "circle", "mighty_networks", "skool",
    "discourse", "facebook", "telegram", "whatsapp", "custom", "guilded",
    "matrix", "google_groups",
  ]);

  const platformRecognized = recognizedPlatforms.has(community.platform) || community.platform === "other";

  // Check against blocked domains
  let domainBlocked = false;
  if (community.domain) {
    const [blocked] = await sql`
      SELECT domain FROM blocked_domains
      WHERE ${community.domain} = domain OR ${community.domain} LIKE '%.' || domain
      LIMIT 1
    `;
    domainBlocked = !!blocked;
  }

  const passed = platformRecognized && !domainBlocked;
  const score = passed ? 100 : 0;

  return {
    gate,
    passed,
    score,
    details: {
      platform: community.platform,
      platformRecognized,
      domain: community.domain,
      domainBlocked,
    },
  };
}

// ─── GATE 5: QUALITY SCORE (composite) ───

export async function computeQualityScore(
  community: Community,
  gateResults: GateResult[]
): Promise<GateResult> {
  const gate = "quality";

  const members = community.memberCount ?? 0;
  const activity = parseFloat(String(community.activityScore ?? 0));

  // Size score (15%)
  const sizeScore = members > 0 ? Math.min(100, (Math.log(members) / Math.log(100000)) * 100) : 0;

  // Engagement score (30%)
  const engagementScore = Math.min(100, activity);

  // Content score (20%) — description quality
  const descLength = (community.description ?? "").length;
  const contentScore = Math.min(100, descLength * 0.5);

  // Freshness score (15%) — we just scraped it, so 100
  const freshnessScore = 100;

  // Signal score (20%) — how many sources discovered this URL
  const sourceResult = await sql`
    SELECT COUNT(DISTINCT source) as count FROM discovered_urls
    WHERE community_id = ${community.id}
  `;
  const sourceCount = Number(sourceResult[0]?.count ?? 1);
  const signalScore = sourceCount === 1 ? 20 : sourceCount === 2 ? 50 : sourceCount >= 3 ? 80 : 100;

  const finalScore = (
    sizeScore * 0.15 +
    engagementScore * 0.30 +
    contentScore * 0.20 +
    freshnessScore * 0.15 +
    signalScore * 0.20
  );

  const passed = finalScore >= 40;

  return {
    gate,
    passed,
    score: Math.round(finalScore * 100) / 100,
    details: {
      sizeScore: Math.round(sizeScore),
      engagementScore: Math.round(engagementScore),
      contentScore: Math.round(contentScore),
      freshnessScore,
      signalScore,
      sourceCount,
    },
  };
}

// ─── RUN ALL GATES ───

export async function runVettingGates(community: Community): Promise<{
  allPassed: boolean;
  qualityScore: number;
  results: GateResult[];
}> {
  const results: GateResult[] = [];

  // Run gates sequentially
  const liveness = await checkLiveness(community);
  results.push(liveness);

  // Record each result
  await recordGateResult(community.id, liveness);

  if (!liveness.passed) {
    return { allPassed: false, qualityScore: 0, results };
  }

  const activity = await checkActivity(community);
  results.push(activity);
  await recordGateResult(community.id, activity);

  const authenticity = await checkAuthenticity(community);
  results.push(authenticity);
  await recordGateResult(community.id, authenticity);

  const legitimacy = await checkLegitimacy(community);
  results.push(legitimacy);
  await recordGateResult(community.id, legitimacy);

  const quality = await computeQualityScore(community, results);
  results.push(quality);
  await recordGateResult(community.id, quality);

  const allPassed = results.every((r) => r.passed);

  return { allPassed, qualityScore: quality.score, results };
}

async function recordGateResult(communityId: string, result: GateResult): Promise<void> {
  await sql`
    INSERT INTO vetting_results (community_id, gate_name, passed, score, details)
    VALUES (${communityId}, ${result.gate}, ${result.passed}, ${result.score}, ${JSON.stringify(result.details)}::jsonb)
  `;
}
