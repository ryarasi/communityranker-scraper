import axios from "axios";
import { env } from "./env.js";

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes
let lastTriggeredAt = 0;

export async function triggerDeploy(): Promise<void> {
  const hookUrl = env.CLOUDFLARE_DEPLOY_HOOK_URL;
  if (!hookUrl) return; // silently skip if no hook configured

  const now = Date.now();
  if (now - lastTriggeredAt < DEBOUNCE_MS) {
    console.log(`[deploy-hook] Skipping — last trigger was ${Math.round((now - lastTriggeredAt) / 1000)}s ago (debounce: 15 min)`);
    return;
  }

  try {
    await axios.post(hookUrl);
    lastTriggeredAt = now;
    console.log("[deploy-hook] Triggered Cloudflare Pages rebuild");
  } catch (err: any) {
    console.error(`[deploy-hook] Failed to trigger rebuild: ${err.message}`);
  }
}
