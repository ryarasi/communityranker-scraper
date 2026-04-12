# CommunityRanker Scraper

Scraping and extraction pipeline for CommunityRanker — discovers, scrapes, and structures community data.

## Stack

- **Spider.cloud** for web scraping
- **Gemini 2.5 Flash-Lite** for structured data extraction
- **Serper.dev** for community discovery
- **Graphile Worker** for job orchestration
- **PostgreSQL** for data storage

## Development

```bash
pnpm install
pnpm dev
```

## Pipeline

1. **Discover** — find new communities via Serper + platform APIs
2. **Scrape** — fetch pages via Spider.cloud → markdown
3. **Extract** — send markdown to Gemini → structured JSON
4. **Upsert** — write to PostgreSQL
5. **Refresh** — nightly stale listing re-scrape
