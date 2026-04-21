import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePriority } from "../src/lib/priority.js";

describe("computePriority", () => {
  it("gives no bump for a plain Serper lead", () => {
    assert.equal(
      computePriority({ source: "serper", platform: "other" }),
      0
    );
  });

  it("bumps curated-list sources by +30", () => {
    assert.equal(
      computePriority({
        source: "awesome_list:Romaixn/awesome-communities",
        platform: "discord",
      }),
      // +30 curated + +20 free-enricher (discord)
      50
    );
  });

  it("bumps hive_sitemap + hive_sitemap_seed prefixes", () => {
    assert.equal(
      computePriority({ source: "hive_sitemap_seed", platform: "reddit" }),
      50
    );
    assert.equal(
      computePriority({ source: "hive_sitemap", platform: "reddit" }),
      50
    );
  });

  it("bumps Disboard high-member cards by +15 (in addition to discord free-enricher)", () => {
    assert.equal(
      computePriority({ source: "disboard", platform: "discord", memberHint: 500 }),
      35 // +20 free + +15 disboard-high-member
    );
  });

  it("does NOT bump Disboard when member hint below 100", () => {
    assert.equal(
      computePriority({ source: "disboard", platform: "discord", memberHint: 40 }),
      20 // free-enricher only
    );
    assert.equal(
      computePriority({ source: "disboard", platform: "discord", memberHint: null }),
      20
    );
  });

  it("applies multi-source boost when extraSources >= 1", () => {
    assert.equal(
      computePriority({ source: "serper", platform: "discord", extraSources: 1 }),
      45 // +20 free + +25 multi-source
    );
  });

  it("bumps linkedin-followup by +10", () => {
    assert.equal(
      computePriority({ source: "linkedin-followup:example-co", platform: "other" }),
      10
    );
  });

  it("returns 0 for random platform-less source", () => {
    assert.equal(
      computePriority({ source: "user_submission", platform: null }),
      30 // curated bump only
    );
  });
});
