import axios from "axios";
import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { DRY_RUN, dryRunLog, isCircuitOpen, recordApiError, recordApiSuccess } from "../lib/safeguards.js";
import { remainingDailyCap } from "../lib/daily-cap.js";

// Awesome-list harvester (throughput-strategy §3.2).
//
// Each of these repos is a curated README listing community invites:
// `discord.gg/...`, `t.me/...`, `slack.com/...`, `skool.com/...`,
// `circle.so/...`. We fetch the raw markdown via GitHub's `raw.githubusercontent.com`
// host (no API key needed, no rate limit for anonymous pulls of public files
// up to ~5,000 req/hour per IP) and regex-extract URLs matching our
// community-platform patterns. Each URL is inserted with
// `source = 'awesome_list:<repo>'` so the yield monitor + priority helper
// can segment performance per repo.

export const AWESOME_LIST_REPOS: { repo: string; paths: string[] }[] = [
  { repo: "Romaixn/awesome-communities", paths: ["README.md"] },
  { repo: "ljosberinn/awesome-dev-discord", paths: ["README.md"] },
  { repo: "mhxion/awesome-discord-communities", paths: ["README.md"] },
  { repo: "AntJanus/awesome-discords", paths: ["README.md"] },
  { repo: "iVieL/awesome-programming-discord", paths: ["README.md"] },
];

export const AWESOME_LIST_MAX_DAILY = parseInt(
  process.env.AWESOME_LIST_MAX_DAILY ?? "500",
  10
);

const CIRCUIT_KEY = "awesome_lists";

// URL extraction regex. Covers the platforms Ragav listed in the spec.
// Capture the full URL (scheme optional). We greedily consume path + any
// query, stopping at whitespace / markdown delimiters. Discord invite codes
// are left generous here (up to 32 chars) because community-curated lists
// sometimes paste custom vanity-looking slugs — the Discord enricher
// regex ({2,16}) will surface the real truth downstream.
export const COMMUNITY_URL_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(discord\.gg\/[a-zA-Z0-9-]{2,32}|discord\.com\/invite\/[a-zA-Z0-9-]{2,32}|t\.me\/[a-zA-Z0-9_]+|[a-zA-Z0-9-]+\.slack\.com(?:\/[^\s)>\],]*)?|join\.slack\.com\/t\/[^\s)>\],]+|skool\.com\/[^\s)>\],]+|circle\.so\/[^\s)>\],]+)/gi;

export interface ExtractedUrl {
  url: string;
}

export function extractCommunityUrls(markdown: string): ExtractedUrl[] {
  const seen = new Set<string>();
  const out: ExtractedUrl[] = [];
  const matches = markdown.matchAll(COMMUNITY_URL_REGEX);
  for (const m of matches) {
    const raw = m[1] ?? m[0];
    // Ensure scheme.
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    // Trim trailing markdown punctuation that slipped past the regex.
    const cleaned = url.replace(/[).,\]>]+$/u, "");
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push({ url: cleaned });
    }
  }
  return out;
}

async function fetchRawReadme(repo: string, path: string): Promise<string | null> {
  if (isCircuitOpen(CIRCUIT_KEY)) return null;
  // Try `master` then `main`. Most of the listed repos are old enough to use `master`.
  for (const branch of ["master", "main"]) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
    try {
      const response = await axios.get(url, {
        headers: { "User-Agent": "CommunityRankerBot/1.0" },
        timeout: 15_000,
      });
      await recordApiSuccess(CIRCUIT_KEY);
      return response.data as string;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) continue; // try next branch
      await recordApiError(CIRCUIT_KEY, err.message, status);
      return null;
    }
  }
  return null;
}

export async function harvestAwesomeLists(): Promise<number> {
  if (DRY_RUN) {
    dryRunLog("awesome_lists", `Would pull ${AWESOME_LIST_REPOS.length} repos (cap ${AWESOME_LIST_MAX_DAILY}/day)`);
    return 0;
  }

  let inserted = 0;

  for (const { repo, paths } of AWESOME_LIST_REPOS) {
    const source = `awesome_list:${repo}`;
    let cap = await remainingDailyCap(source, AWESOME_LIST_MAX_DAILY);
    if (cap <= 0) {
      console.log(`[awesome_lists] ${repo}: daily cap reached`);
      continue;
    }

    for (const path of paths) {
      if (cap <= 0) break;
      const md = await fetchRawReadme(repo, path);
      if (!md) continue;

      const urls = extractCommunityUrls(md);
      console.log(`[awesome_lists] ${repo}/${path}: extracted ${urls.length} URLs`);

      for (const { url } of urls) {
        if (cap <= 0) break;
        const result = await insertDiscoveredUrl(url, source, null);
        if (result.inserted) {
          inserted++;
          cap--;
        }
      }
    }
  }

  console.log(`[awesome_lists] Inserted ${inserted} new URLs`);
  return inserted;
}
