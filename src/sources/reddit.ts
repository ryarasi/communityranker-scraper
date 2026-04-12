import axios from "axios";

export interface SubredditResult {
  name: string;
  url: string;
  subscribers: number;
  description: string;
}

export async function discoverSubreddits(
  topic: string
): Promise<SubredditResult[]> {
  const response = await axios.get(
    `https://www.reddit.com/subreddits/search.json`,
    {
      params: { q: topic, limit: 25, sort: "relevance" },
      headers: { "User-Agent": "CommunityRanker/1.0" },
      timeout: 15_000,
    }
  );

  const children: SubredditResult[] = (
    response.data?.data?.children ?? []
  ).map(
    (child: {
      data: {
        display_name: string;
        url: string;
        subscribers: number;
        public_description: string;
      };
    }) => ({
      name: child.data.display_name,
      url: `https://www.reddit.com${child.data.url}`,
      subscribers: child.data.subscribers ?? 0,
      description: child.data.public_description ?? "",
    })
  );

  return children;
}
