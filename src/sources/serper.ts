import axios from "axios";
import { env } from "../lib/env.js";

const SERPER_API_URL = "https://google.serper.dev/search";

export interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

export async function searchCommunities(
  topic: string,
  platform?: string
): Promise<SerperResult[]> {
  const query = platform
    ? `${topic} community ${platform}`
    : `${topic} online community`;

  const response = await axios.post(
    SERPER_API_URL,
    { q: query, num: 20 },
    {
      headers: {
        "X-API-KEY": env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  const organic: SerperResult[] = (response.data.organic ?? []).map(
    (r: { title: string; link: string; snippet: string }) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    })
  );

  return organic;
}
