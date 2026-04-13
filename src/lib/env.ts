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
  CLOUDFLARE_DEPLOY_HOOK_URL: z.string().default(""),
  // Pipeline safeguard config
  DRY_RUN: z.string().default("false"),
  BUDGET_SPIDER_DAILY: z.string().default("5"),
  BUDGET_GEMINI_DAILY: z.string().default("2"),
  BUDGET_SERPER_DAILY: z.string().default("1"),
});

export const env = envSchema.parse(process.env);
