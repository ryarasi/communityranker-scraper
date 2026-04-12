import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  DATABASE_URL: z.string().default(""),
  SPIDER_API_KEY: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),
  SERPER_API_KEY: z.string().default(""),
  DATAFORSEO_LOGIN: z.string().default(""),
  DATAFORSEO_PASSWORD: z.string().default(""),
  DISCORD_WEBHOOK_URL: z.string().default(""),
});

export const env = envSchema.parse(process.env);
