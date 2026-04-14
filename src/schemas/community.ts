import { z } from "zod";

// ─── Raw enum values ───
// Kept as plain tuples so the JSON schema below (`communityJsonSchema`) can reference them.
// The Zod validators below wrap these with a preprocess step that coerces Gemini's
// occasional synonyms (e.g. "free" for "open") to the canonical value instead of
// discarding a paid Spider+Gemini scrape over a minor enum mismatch.

const PLATFORM_VALUES = [
  "discord",
  "slack",
  "reddit",
  "circle",
  "mighty_networks",
  "skool",
  "discourse",
  "facebook",
  "telegram",
  "whatsapp",
  "custom",
  "other",
] as const;

const MEMBER_COUNT_CONFIDENCE_VALUES = ["exact", "approximate", "unknown"] as const;
const ACCESS_MODEL_VALUES = ["open", "approval_required", "invite_only", "paid", "hybrid"] as const;
const ACTIVITY_LEVEL_VALUES = ["very_active", "active", "moderate", "low", "unknown"] as const;
const GEO_SCOPE_VALUES = ["global", "regional", "national", "local", "unknown"] as const;

function coercedEnum<T extends readonly [string, ...string[]]>(
  values: T,
  synonyms: Record<string, T[number]>,
  fallback: T[number]
) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return fallback;
    const lower = v.toLowerCase().trim();
    if ((values as readonly string[]).includes(lower)) return lower;
    if (synonyms[lower]) return synonyms[lower];
    return fallback;
  }, z.enum(values));
}

export const platformEnum = coercedEnum(
  PLATFORM_VALUES,
  {
    mighty: "mighty_networks",
    "mighty networks": "mighty_networks",
    fb: "facebook",
    tg: "telegram",
    wa: "whatsapp",
    web: "custom",
    website: "custom",
  },
  "other"
);

export const memberCountConfidenceEnum = coercedEnum(
  MEMBER_COUNT_CONFIDENCE_VALUES,
  { estimate: "approximate", estimated: "approximate", rough: "approximate", "n/a": "unknown", none: "unknown" },
  "unknown"
);

export const accessModelEnum = coercedEnum(
  ACCESS_MODEL_VALUES,
  {
    free: "open",
    public: "open",
    "free to join": "open",
    application: "approval_required",
    "application required": "approval_required",
    approval: "approval_required",
    moderated: "approval_required",
    vetted: "approval_required",
    private: "invite_only",
    invite: "invite_only",
    "invite-only": "invite_only",
    closed: "invite_only",
    subscription: "paid",
    membership: "paid",
    premium: "paid",
    freemium: "hybrid",
    mixed: "hybrid",
  },
  "open"
);

export const activityLevelEnum = coercedEnum(
  ACTIVITY_LEVEL_VALUES,
  {
    "very active": "very_active",
    high: "very_active",
    busy: "very_active",
    medium: "moderate",
    average: "moderate",
    quiet: "low",
    inactive: "low",
    dead: "low",
    "n/a": "unknown",
  },
  "unknown"
);

export const geoScopeEnum = coercedEnum(
  GEO_SCOPE_VALUES,
  {
    worldwide: "global",
    international: "global",
    country: "national",
    city: "local",
    "n/a": "unknown",
  },
  "unknown"
);

// ─── Numeric helper: accept number, numeric string, or null-ish ───
// Gemini sometimes returns "10000", "10,000", "10K", or omits the field.
// Parse what we can; fall back to null rather than rejecting the whole extraction.
const looseNumberNullable = z.preprocess((v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase().replace(/,/g, "");
    if (s === "null" || s === "none" || s === "unknown" || s === "n/a") return null;
    const kMatch = s.match(/^([\d.]+)\s*k$/);
    if (kMatch) return Math.round(parseFloat(kMatch[1]!) * 1000);
    const mMatch = s.match(/^([\d.]+)\s*m$/);
    if (mMatch) return Math.round(parseFloat(mMatch[1]!) * 1_000_000);
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

const looseStringNullable = z.preprocess((v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "none" || t.toLowerCase() === "unknown") return null;
  return t;
}, z.string().nullable());

// Schema tolerates Gemini's typical near-misses (synonyms, numeric strings, missing optional
// fields) so a single enum drift doesn't waste the Spider+Gemini spend on the whole record.
// Only the true/false discriminator + the core identity fields (name, primaryUrl) are strict.
export const communityExtractionSchema = z.discriminatedUnion("valid", [
  z.object({
    valid: z.literal(true),
    name: z.string().min(1),
    description: z.string().catch(""),
    primaryUrl: z.string().min(1),
    platform: platformEnum,
    memberCount: looseNumberNullable,
    memberCountConfidence: memberCountConfidenceEnum,
    accessModel: accessModelEnum,
    pricingMonthly: looseNumberNullable,
    topics: z.array(z.string()).catch([]),
    activityLevel: activityLevelEnum,
    geoScope: geoScopeEnum,
    language: z.string().catch("en"),
    foundedYear: looseNumberNullable,
    founderName: looseStringNullable,
    uniqueValue: looseStringNullable,
  }),
  z.object({
    valid: z.literal(false),
    reason: z.string().catch("unspecified"),
  }),
]);

export type CommunityExtraction = z.infer<typeof communityExtractionSchema>;

export const communityJsonSchema = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    reason: { type: "string", description: "Only if valid=false" },
    name: { type: "string" },
    description: { type: "string", description: "2-3 sentences" },
    primaryUrl: { type: "string" },
    platform: {
      type: "string",
      enum: PLATFORM_VALUES,
    },
    memberCount: { type: ["number", "null"] },
    memberCountConfidence: {
      type: "string",
      enum: MEMBER_COUNT_CONFIDENCE_VALUES,
    },
    accessModel: {
      type: "string",
      enum: ACCESS_MODEL_VALUES,
    },
    pricingMonthly: { type: ["number", "null"] },
    topics: { type: "array", items: { type: "string" } },
    activityLevel: {
      type: "string",
      enum: ACTIVITY_LEVEL_VALUES,
    },
    geoScope: {
      type: "string",
      enum: GEO_SCOPE_VALUES,
    },
    language: { type: "string" },
    foundedYear: { type: ["number", "null"] },
    founderName: { type: ["string", "null"] },
    uniqueValue: { type: ["string", "null"] },
  },
  required: ["valid"],
};
