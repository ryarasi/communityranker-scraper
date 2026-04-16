import axios from "axios";
import { env } from "./env.js";
import { sql } from "../db/client.js";

const DISCORD_WEBHOOK = env.DISCORD_WEBHOOK_URL;

async function getPublishedTotal(): Promise<number | null> {
  try {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM communities WHERE status = 'published'
    `;
    return row?.count ?? null;
  } catch {
    return null;
  }
}

export async function sendAlert(
  title: string,
  message: string,
  color: number = 0x00639a // secondary blue
): Promise<void> {
  if (!DISCORD_WEBHOOK) return; // silently skip if no webhook configured

  const total = await getPublishedTotal();
  const footerText =
    total !== null
      ? `CommunityRanker Pipeline · ${total.toLocaleString()} total published`
      : "CommunityRanker Pipeline";

  try {
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [
        {
          title,
          description: message,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: footerText },
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
