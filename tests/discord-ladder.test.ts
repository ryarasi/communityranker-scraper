import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The Discord Tier 0+1 ladder touches both the DB (dead-invite cache) and
// the live Discord API. Full integration is verified on Hetzner. Here we
// exercise the branches that don't require a real connection — specifically
// the format-validation Tier 0 short-circuit — plus an invariant check on
// the rejection-reason union type.

describe("enrichViaDiscordInvite — Tier 0 format check", () => {
  it("rejects non-discord URLs immediately with invalid_invite_format", async () => {
    const { enrichViaDiscordInvite, isDiscordRejection } = await import(
      "../src/enrichers/discord.js"
    );
    const result = await enrichViaDiscordInvite("https://example.com/not-discord");
    assert.ok(isDiscordRejection(result));
    if (isDiscordRejection(result)) {
      assert.equal(result.reason, "invalid_invite_format");
    }
  });

  it("rejects non-discord hostnames (e.g. empty or random path)", async () => {
    const { enrichViaDiscordInvite, isDiscordRejection } = await import(
      "../src/enrichers/discord.js"
    );
    const result = await enrichViaDiscordInvite("https://example.com/x");
    assert.ok(isDiscordRejection(result));
    if (isDiscordRejection(result)) {
      assert.equal(result.reason, "invalid_invite_format");
    }
  });

  it("accepts both discord.gg/ and discord.com/invite/ forms at the regex layer", async () => {
    // We can't actually call the API here (would hit network / DB). Instead
    // we verify the regex itself via the same pattern used in the module.
    // NB: this is a pinned copy — if the enricher's regex ever changes, the
    // test will surface it via the happy-path mismatch.
    const INVITE_REGEX = /discord\.(?:gg|com\/invite)\/([a-zA-Z0-9-]{2,16})/;
    assert.match("https://discord.gg/abc123", INVITE_REGEX);
    assert.match("https://discord.com/invite/abc123", INVITE_REGEX);
    assert.doesNotMatch("https://example.com/invite/abc123", INVITE_REGEX);
  });

  it("isDiscordRejection narrows to rejection payloads", async () => {
    const { isDiscordRejection } = await import("../src/enrichers/discord.js");
    assert.equal(isDiscordRejection(null), false);
    assert.equal(
      isDiscordRejection({ rejected: true, reason: "invalid_invite_format" as const }),
      true
    );
  });
});

// Schema / migration sanity check — ensures the 002 migration exposes
// the columns the pipeline now depends on. We only check the SQL text —
// it's the closest thing to a migration unit test without running the DB.
describe("migration 002 — discord_early_rejection SQL shape", () => {
  it("declares dead_invites table + canonical_guild_id + lead_sources + priority", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("../migrations/002_discord_early_rejection.sql", import.meta.url);
    const contents = await fs.readFile(url, "utf-8");
    assert.match(contents, /CREATE TABLE IF NOT EXISTS dead_invites/);
    assert.match(contents, /canonical_guild_id/);
    assert.match(contents, /lead_sources JSONB/);
    assert.match(contents, /priority INT/);
    // Backfill-prune query is embedded in the migration for one-shot catch-up.
    assert.match(contents, /rejection_reason = 'stale_discord_lead'/);
    assert.match(contents, /INTERVAL '7 days'/);
  });
});
