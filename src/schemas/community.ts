import { z } from "zod";

export const platformEnum = z.enum([
  "discord",
  "slack",
  "reddit",
  "facebook",
  "telegram",
  "whatsapp",
  "circle",
  "mighty_networks",
  "guild",
  "meetup",
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
  "inactive",
  "unknown",
]);

export const geoScopeEnum = z.enum([
  "global",
  "regional",
  "national",
  "local",
  "unknown",
]);

export const communityExtractionSchema = z.object({
  name: z.string(),
  description: z.string(),
  primaryUrl: z.string(),
  platform: platformEnum,
  memberCount: z.number().nullable(),
  memberCountConfidence: memberCountConfidenceEnum,
  foundedYear: z.number().nullable(),
  accessModel: accessModelEnum,
  pricingMonthly: z.number().nullable(),
  topics: z.array(z.string()),
  activityLevel: activityLevelEnum,
  geoScope: geoScopeEnum,
  language: z.string(),
});

export type CommunityExtraction = z.infer<typeof communityExtractionSchema>;

export const communityJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
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
    foundedYear: { type: ["number", "null"] },
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
  },
  required: [
    "name",
    "description",
    "primaryUrl",
    "platform",
    "memberCount",
    "memberCountConfidence",
    "foundedYear",
    "accessModel",
    "pricingMonthly",
    "topics",
    "activityLevel",
    "geoScope",
    "language",
  ],
};
