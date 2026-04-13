import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env.js";
import {
  communityExtractionSchema,
  type CommunityExtraction,
} from "../schemas/community.js";
import { recordApiSuccess, recordApiError, isCircuitOpen, logSpend, DRY_RUN, dryRunLog } from "../lib/safeguards.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

// Strict extraction prompt — rejects non-community pages
const EXTRACTION_PROMPT = `You are extracting data about ONE specific online community from its own landing page.

HARD RULES — VIOLATING ANY OF THESE MEANS RETURN {"valid": false}:
1. This page MUST be the community's own page — its homepage, landing page, about page, or platform profile. If this is a blog post, listicle, directory, news article, comparison article, or any page that discusses MULTIPLE communities, return {"valid": false, "reason": "not a community page"}.
2. The entity described must be a COMMUNITY — a place where people gather, discuss, and interact with each other. Products, tools, companies, SaaS platforms, courses without community features, newsletters, podcasts, event/conference pages, and personal blogs are NOT communities. A community MUST have ongoing member-to-member interaction (forums, chat, discussions).
3. Only extract data explicitly stated on the page. If a field's value cannot be determined, use null. NEVER estimate or fabricate.
4. Member counts must come directly from the page. If the page says "10,000+ members," extract 10000 with confidence "approximate." If no count is mentioned, use null.
5. If the page contains only dates older than 12 months with no recent activity, return {"valid": false, "reason": "appears inactive — no recent content"}.

Return a JSON object matching this schema:
{
  "valid": true/false,
  "reason": "string (only if valid=false)",
  "name": "string",
  "description": "string (2-3 sentences)",
  "primaryUrl": "string",
  "platform": "discord|slack|reddit|circle|mighty_networks|skool|discourse|facebook|telegram|whatsapp|custom|other",
  "memberCount": number or null,
  "memberCountConfidence": "exact|approximate|unknown",
  "accessModel": "open|approval_required|invite_only|paid|hybrid",
  "pricingMonthly": number or null,
  "topics": ["string", ...],
  "activityLevel": "very_active|active|moderate|low|unknown",
  "geoScope": "global|regional|national|local|unknown",
  "language": "string (ISO 639-1)",
  "foundedYear": number or null,
  "founderName": "string or null",
  "uniqueValue": "string or null (what makes this community unique?)"
}`;

// SEO content generation prompt
const SEO_PROMPT = `Given this community data, generate the following SEO content fields.
Be factual, specific, and helpful. Do not invent information not present in the data.

Generate a JSON object with:
1. "who_should_join": A 2-sentence paragraph describing who would benefit most
2. "how_to_join": Step-by-step instructions (2-4 steps)
3. "faq": Array of 3-5 FAQ objects [{"question": "...", "answer": "..."}] targeting common searches. Include: "How many members does X have?", "Is X free?", "Is X active?"
4. "long_description": A 100-150 word expanded description suitable for SEO body copy`;

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

// Cost estimation: Gemini 2.5 Flash-Lite is ~$0.00025 per request on average
const GEMINI_COST_PER_REQUEST = 0.00025;

export async function extractCommunityData(
  markdown: string
): Promise<CommunityExtraction> {
  if (DRY_RUN) {
    dryRunLog("extract", `Would call Gemini with ${markdown.length} chars of markdown`);
    return { valid: false, reason: "dry_run" };
  }

  if (isCircuitOpen("gemini")) {
    throw new GeminiConfigError("Gemini circuit breaker is open — too many consecutive errors");
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction: EXTRACTION_PROMPT,
  });

  try {
    const result = await model.generateContent(markdown);
    const text = result.response.text();

    // Extract JSON from the response (handle markdown code blocks)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [
      null,
      text,
    ];
    const jsonStr = (jsonMatch[1] ?? text).trim();

    const parsed = JSON.parse(jsonStr);
    const validated = communityExtractionSchema.parse(parsed);

    await recordApiSuccess("gemini");
    logSpend("gemini", GEMINI_COST_PER_REQUEST, "extract");

    return validated;
  } catch (err: any) {
    const msg = err?.message ?? String(err);

    // Non-retryable: model deprecated, API key invalid, quota exhausted permanently
    if (
      msg.includes("404 Not Found") ||
      msg.includes("no longer available") ||
      msg.includes("API key not valid") ||
      msg.includes("PERMISSION_DENIED")
    ) {
      await recordApiError("gemini", msg, 401);
      throw new GeminiConfigError(
        `Gemini config error (will not retry): ${msg}`
      );
    }

    // Rate limit or server error
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
      await recordApiError("gemini", msg, 429);
    } else if (msg.includes("500") || msg.includes("INTERNAL")) {
      await recordApiError("gemini", msg, 500);
    }

    throw err;
  }
}

export async function generateSeoContent(
  communityData: { name: string; platform: string; memberCount?: number | null; description: string; topics?: string[]; accessModel?: string }
): Promise<{
  whoShouldJoin: string;
  howToJoin: string;
  faqJson: Array<{ question: string; answer: string }>;
  longDescription: string;
} | null> {
  if (DRY_RUN) {
    dryRunLog("seo", `Would generate SEO content for ${communityData.name}`);
    return null;
  }

  if (isCircuitOpen("gemini")) return null;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction: SEO_PROMPT,
  });

  const prompt = `Community: ${communityData.name} on ${communityData.platform} with ${communityData.memberCount ?? "unknown"} members
Description: ${communityData.description}
Topics: ${communityData.topics?.join(", ") ?? "general"}
Access: ${communityData.accessModel ?? "open"}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
    const jsonStr = (jsonMatch[1] ?? text).trim();

    const parsed = JSON.parse(jsonStr);

    await recordApiSuccess("gemini");
    logSpend("gemini", GEMINI_COST_PER_REQUEST, "seo_content");

    return {
      whoShouldJoin: parsed.who_should_join ?? "",
      howToJoin: parsed.how_to_join ?? "",
      faqJson: parsed.faq ?? [],
      longDescription: parsed.long_description ?? "",
    };
  } catch (err: any) {
    console.error(`[gemini] SEO content generation failed for ${communityData.name}:`, err.message);
    return null;
  }
}
