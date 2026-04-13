import axios from "axios";
import { env } from "./env.js";

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes
let lastTriggeredAt = 0;

const CF_PROJECT_NAME = "communityranker-web";

export async function triggerDeploy(): Promise<void> {
  const now = Date.now();
  if (now - lastTriggeredAt < DEBOUNCE_MS) {
    console.log(`[deploy-hook] Skipping — last trigger was ${Math.round((now - lastTriggeredAt) / 1000)}s ago (debounce: 15 min)`);
    return;
  }

  // Prefer Cloudflare API if credentials are available
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CF_PROJECT_NAME}/deployments`,
        {},
        {
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      lastTriggeredAt = now;
      console.log("[deploy-hook] Triggered Cloudflare Pages rebuild via API");
      return;
    } catch (err: any) {
      console.error(`[deploy-hook] Cloudflare API failed: ${err?.response?.data?.errors?.[0]?.message ?? err.message}`);
    }
  }

  // Fallback to deploy hook URL if configured
  if (env.CLOUDFLARE_DEPLOY_HOOK_URL) {
    try {
      await axios.post(env.CLOUDFLARE_DEPLOY_HOOK_URL);
      lastTriggeredAt = now;
      console.log("[deploy-hook] Triggered Cloudflare Pages rebuild via hook URL");
    } catch (err: any) {
      console.error(`[deploy-hook] Hook URL failed: ${err.message}`);
    }
    return;
  }

  // No credentials configured
  console.log("[deploy-hook] No Cloudflare credentials configured, skipping rebuild trigger");
}
