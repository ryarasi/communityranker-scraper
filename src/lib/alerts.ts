import axios from "axios";
import { env } from "./env.js";

const DISCORD_WEBHOOK = env.DISCORD_WEBHOOK_URL;

export async function sendAlert(
  title: string,
  message: string,
  color: number = 0x00639a // secondary blue
): Promise<void> {
  if (!DISCORD_WEBHOOK) return; // silently skip if no webhook configured

  try {
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [
        {
          title,
          description: message,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: "CommunityRanker Pipeline" },
        },
      ],
    });
  } catch {
    // Don't crash the pipeline if Discord is down
    console.error(`[alerts] Failed to send Discord alert: ${title}`);
  }
}

export async function alertError(title: string, message: string) {
  return sendAlert(`❌ ${title}`, message, 0xba1a1a); // error red
}

export async function alertSuccess(title: string, message: string) {
  return sendAlert(`✅ ${title}`, message, 0x22c55e); // green
}

export async function alertWarning(title: string, message: string) {
  return sendAlert(`⚠️ ${title}`, message, 0xf59e0b); // amber
}
