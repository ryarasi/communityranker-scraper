import { insertDiscoveredUrl } from "../lib/url-validator.js";
import { DRY_RUN, dryRunLog, isCircuitOpen } from "../lib/safeguards.js";
import { remainingDailyCap } from "../lib/daily-cap.js";
import { httpGet, CircuitOpenError, DeadTargetError } from "../lib/http.js";

// Skool /discovery harvester.
//
// skool.com's robots.txt (verified 2026-04-23) is permissive: `Allow: /`,
// only `/*/--/*` post-detail URLs are disallowed. The /discovery page is a
// standard Next.js server-rendered page that embeds the full list of
// communities visible to the search as a JSON blob inside a
// `<script id="__NEXT_DATA__">` tag. We hit it with `?q=<letter>&p=<page>`
// and extract `props.pageProps.groups[].name` — each `name` is the community
// slug (e.g. `thatpickleballschool`), and the full URL is
// `https://www.skool.com/<slug>`.
//
// Per 2026-04-23 probes we see ~30 groups per page, up to 33 pages per term
// (server caps at 1000 results), with zero AWS-WAF challenge on plain
// Mozilla UAs. We layer http.ts UA rotation on top for defense-in-depth.

const DISCOVERY_URL = "https://www.skool.com/discovery";
const SOURCE = "skool_discovery";
const CIRCUIT_KEY = "skool_discovery";
const MAX_PAGES_PER_TERM = 33;

export const SKOOL_DISCOVERY_MAX_DAILY = parseInt(
  process.env.SKOOL_DISCOVERY_MAX_DAILY ?? "200",
  10
);

// Single-letter alphabet sweep — confirmed to yield ~400-500 unique slugs per
// full run in 2026-04-23 research. Can be expanded to two-letter combos via
// the SKOOL_DISCOVERY_TERMS env var once the single-letter pass stabilises.
const DEFAULT_TERMS = "abcdefghijklmnopqrstuvwxyz".split("");

function resolveTerms(): string[] {
  const override = process.env.SKOOL_DISCOVERY_TERMS;
  if (!override) return DEFAULT_TERMS;
  return override
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

// Skool community slugs are kebab-case, 3-64 chars, alphanumeric + hyphens,
// must start and end with alphanum. Rejects stray whitespace, capital
// letters, or characters that would break a URL path.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

// What the __NEXT_DATA__ JSON carries per community.
// Additional fields (totalMembers, displayName, etc.) are present but we only
// pluck the ones we can feed into discovered_urls without extra validation.
export interface SkoolGroupRecord {
  name?: unknown;
  displayName?: unknown;
  totalMembers?: unknown;
  description?: unknown;
}

export interface ParsedSkoolPage {
  groups: SkoolGroupRecord[];
  totalGroupsAvailable: number | null;
}

export function parseSkoolDiscoveryPage(html: string): ParsedSkoolPage {
  const empty: ParsedSkoolPage = { groups: [], totalGroupsAvailable: null };

  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return empty;

  let blob: any;
  try {
    blob = JSON.parse(match[1]);
  } catch {
    return empty;
  }

  const pageProps = blob?.props?.pageProps;
  if (!pageProps) return empty;

  const rawGroups = pageProps.groups;
  const groups: SkoolGroupRecord[] = Array.isArray(rawGroups)
    ? rawGroups.filter((g) => g && typeof g === "object")
    : [];

  const total =
    typeof pageProps.numGroups === "number" ? pageProps.numGroups : null;

  return { groups, totalGroupsAvailable: total };
}

export function extractSlug(group: SkoolGroupRecord): string | null {
  if (typeof group.name !== "string") return null;
  const slug = group.name.trim();
  // Skool's real slugs are always lowercase (verified via Apify sample +
  // live probe). Reject MixedCase and anything that would normally route
  // through Skool's canonicalisation — we'd rather drop outliers than
  // ingest non-community URLs.
  if (!SLUG_RE.test(slug)) return null;
  return slug;
}

function toMemberCount(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return undefined;
}

function toDisplayName(group: SkoolGroupRecord, slug: string): string {
  if (typeof group.displayName === "string" && group.displayName.trim().length > 0) {
    return group.displayName.trim();
  }
  return slug.replace(/-/g, " ");
}

function buildPageUrl(term: string, page: number): string {
  const qp = new URLSearchParams();
  qp.set("q", term);
  if (page > 1) qp.set("p", String(page));
  return `${DISCOVERY_URL}?${qp.toString()}`;
}

export async function harvestSkoolDiscovery(): Promise<number> {
  if (DRY_RUN) {
    dryRunLog(
      "skool_discovery",
      `Would sweep ${resolveTerms().length} terms (cap ${SKOOL_DISCOVERY_MAX_DAILY}/day)`
    );
    return 0;
  }

  let cap = await remainingDailyCap(SOURCE, SKOOL_DISCOVERY_MAX_DAILY);
  if (cap <= 0) {
    console.log(
      `[skool_discovery] Daily cap of ${SKOOL_DISCOVERY_MAX_DAILY} already reached`
    );
    return 0;
  }

  const terms = resolveTerms();
  let inserted = 0;
  let previousUrl: string | undefined;

  outer: for (const term of terms) {
    if (cap <= 0) break;
    if (isCircuitOpen(CIRCUIT_KEY)) {
      console.log(`[skool_discovery] Circuit open, stopping sweep`);
      break;
    }

    for (let page = 1; page <= MAX_PAGES_PER_TERM; page++) {
      if (cap <= 0) break outer;

      const url = buildPageUrl(term, page);
      let body: string;
      try {
        const result = await httpGet(url, {
          circuitKey: CIRCUIT_KEY,
          referer: previousUrl,
          minDelayMs: 600,
          maxDelayMs: 1_200,
          maxRetries: 3,
          timeout: 20_000,
        });
        body = result.body;
        previousUrl = url;
      } catch (err: unknown) {
        if (err instanceof CircuitOpenError) {
          console.log(`[skool_discovery] Circuit tripped, stopping sweep`);
          break outer;
        }
        if (err instanceof DeadTargetError) {
          // Discovery pagination past the data — move to next term.
          console.log(
            `[skool_discovery] term=${term} page=${page} dead target, next term`
          );
          break;
        }
        console.error(
          `[skool_discovery] term=${term} page=${page} fetch failed: ${(err as Error).message}`
        );
        break; // move to next term, don't burn the whole sweep on one bad page
      }

      const parsed = parseSkoolDiscoveryPage(body);
      if (parsed.groups.length === 0) {
        // Pagination exhausted for this term — move on.
        console.log(
          `[skool_discovery] term=${term} page=${page} empty groups, next term`
        );
        break;
      }

      let insertedThisPage = 0;
      for (const group of parsed.groups) {
        if (cap <= 0) break;
        const slug = extractSlug(group);
        if (!slug) continue;

        const result = await insertDiscoveredUrl(
          `https://www.skool.com/${slug}`,
          SOURCE,
          null,
          {
            basicName: toDisplayName(group, slug),
            basicMemberCount: toMemberCount(group.totalMembers),
            basicDescription:
              typeof group.description === "string"
                ? group.description
                : undefined,
          }
        );
        if (result.inserted) {
          inserted++;
          insertedThisPage++;
          cap--;
        }
      }

      console.log(
        `[skool_discovery] term=${term} page=${page} groups=${parsed.groups.length} inserted=${insertedThisPage} (cap remaining ${cap})`
      );
    }
  }

  console.log(`[skool_discovery] Total: ${inserted} new URLs inserted`);
  return inserted;
}
