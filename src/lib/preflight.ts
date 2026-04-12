import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "./env.js";

export async function preflightChecks(): Promise<void> {
  console.log("[preflight] Running startup checks...");

  const errors: string[] = [];

  // Check Spider.cloud API key
  if (!env.SPIDER_API_KEY || env.SPIDER_API_KEY === "") {
    errors.push("SPIDER_API_KEY is not set");
  } else {
    try {
      // Quick test — just check auth, don't actually crawl
      await axios.get("https://api.spider.cloud/data/credits", {
        headers: { Authorization: `Bearer ${env.SPIDER_API_KEY}` },
        timeout: 10000,
      });
      console.log("[preflight] Spider.cloud: OK");
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        errors.push(`Spider.cloud API key is invalid (HTTP ${status})`);
      } else {
        console.log(`[preflight] Spider.cloud: WARNING — could not verify (${err.message})`);
      }
    }
  }

  // Check Gemini API key
  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY === "") {
    errors.push("GEMINI_API_KEY is not set");
  } else {
    try {
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
      await model.generateContent("test");
      console.log("[preflight] Gemini API: OK");
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (msg.includes("API key not valid") || msg.includes("PERMISSION_DENIED")) {
        errors.push(`Gemini API key is invalid: ${msg}`);
      } else if (msg.includes("no longer available") || msg.includes("404")) {
        errors.push(`Gemini model deprecated: ${msg}`);
      } else if (msg.includes("429")) {
        console.log("[preflight] Gemini API: OK (rate limited but key valid)");
      } else {
        console.log(`[preflight] Gemini API: WARNING — ${msg}`);
      }
    }
  }

  // Check Serper API key
  if (!env.SERPER_API_KEY || env.SERPER_API_KEY === "") {
    errors.push("SERPER_API_KEY is not set");
  } else {
    console.log("[preflight] Serper API key: set");
  }

  // Check DB connection
  try {
    const { sql } = await import("../db/client.js");
    await sql`SELECT 1`;
    console.log("[preflight] Database: OK");
  } catch (err: any) {
    errors.push(`Database connection failed: ${err.message}`);
  }

  if (errors.length > 0) {
    console.error("\n[preflight] FATAL — cannot start worker:");
    errors.forEach((e) => console.error(`  ✗ ${e}`));
    console.error("\nFix these issues and restart.\n");
    process.exit(1);
  }

  console.log("[preflight] All checks passed.\n");
}
