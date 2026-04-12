import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env.js";
import {
  communityExtractionSchema,
  communityJsonSchema,
  type CommunityExtraction,
} from "../schemas/community.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are a structured data extractor for a community directory.
Extract community information from the following webpage markdown.
Return ONLY a valid JSON object matching this exact schema.
If a field cannot be determined from the content, use null.
Never guess or hallucinate values — use null if uncertain.

JSON Schema:
${JSON.stringify(communityJsonSchema, null, 2)}`;

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

export async function extractCommunityData(
  markdown: string
): Promise<CommunityExtraction> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction: SYSTEM_PROMPT,
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
    return communityExtractionSchema.parse(parsed);
  } catch (err: any) {
    const msg = err?.message ?? String(err);

    // Non-retryable: model deprecated, API key invalid, quota exhausted permanently
    if (
      msg.includes("404 Not Found") ||
      msg.includes("no longer available") ||
      msg.includes("API key not valid") ||
      msg.includes("PERMISSION_DENIED")
    ) {
      throw new GeminiConfigError(
        `Gemini config error (will not retry): ${msg}`
      );
    }

    throw err;
  }
}
