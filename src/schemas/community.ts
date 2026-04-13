import { z } from "zod";

export const platformEnum = z.enum([
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
]);

export const memberCountConfidenceEnum = z.enum([
  "exact",
  "approximate",
  "unknown",
]);

export const accessModelEnum = z.enum([
  "open",
  "approval_required",
  "invite_only",
  "paid",
  "hybrid",
]);

export const activityLevelEnum = z.enum([
  "very_active",
  "active",
  "moderate",
  "low",
  "unknown",
]);

export const geoScopeEnum = z.enum([
  "global",
  "regional",
  "national",
  "local",
  "unknown",
]);

// New schema with strict validation — Gemini returns valid:false for non-community pages
export const communityExtractionSchema = z.discriminatedUnion("valid", [
  // Valid community extraction
  z.object({
    valid: z.literal(true),
    name: z.string(),
    description: z.string(),
    primaryUrl: z.string(),
    platform: platformEnum,
    memberCount: z.number().nullable(),
    memberCountConfidence: memberCountConfidenceEnum,
    accessModel: accessModelEnum,
    pricingMonthly: z.number().nullable(),
    topics: z.array(z.string()),
    activityLevel: activityLevelEnum,
    geoScope: geoScopeEnum,
    language: z.string(),
    foundedYear: z.number().nullable(),
    founderName: z.string().nullable(),
    uniqueValue: z.string().nullable(),
  }),
  // Invalid page — not a community
  z.object({
    valid: z.literal(false),
    reason: z.string(),
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
      enum: platformEnum.options,
    },
    memberCount: { type: ["number", "null"] },
    memberCountConfidence: {
      type: "string",
      enum: memberCountConfidenceEnum.options,
    },
    accessModel: {
      type: "string",
      enum: accessModelEnum.options,
    },
    pricingMonthly: { type: ["number", "null"] },
    topics: { type: "array", items: { type: "string" } },
    activityLevel: {
      type: "string",
      enum: activityLevelEnum.options,
    },
    geoScope: {
      type: "string",
      enum: geoScopeEnum.options,
    },
    language: { type: "string" },
    foundedYear: { type: ["number", "null"] },
    founderName: { type: ["string", "null"] },
    uniqueValue: { type: ["string", "null"] },
  },
  required: ["valid"],
};
