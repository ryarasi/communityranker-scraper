import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCommunityUrls } from "../src/harvesters/awesome-lists.js";

// Fixture: a slice resembling actual awesome-* README content. Mixed markdown
// link syntax, bare URLs, and code-fenced blocks — the extractor should pick
// up all forms and dedupe.
const FIXTURE_MD = `
# Awesome Communities

A curated list.

## Discord

- **Rust Community** — [discord.gg/rust-lang-community](https://discord.gg/rust-lang-community) — Official Rust server.
- **Python Devs**: https://discord.com/invite/python-devs
- Bare mention: discord.gg/bare-one
- Trailing paren: (https://discord.gg/paren-test)
- Duplicate: https://discord.gg/rust-lang-community

## Telegram

- [TG chat](https://t.me/some_group)

## Slack

- [Team workspace](https://join.slack.com/t/examplewksp/shared_invite/zt-abc)
- [Tenant sub](https://examplewksp.slack.com/)

## Skool / Circle

- [Skool](https://www.skool.com/example-community)
- [Circle](https://circle.so/example-brand)

## Not a community

- https://twitter.com/ignore-this
- [Medium post](https://medium.com/@x/post)
`;

describe("extractCommunityUrls", () => {
  it("picks up discord.gg + discord.com/invite URLs", () => {
    const urls = extractCommunityUrls(FIXTURE_MD).map((u) => u.url);
    assert.ok(urls.some((u) => u.endsWith("/rust-lang-community")));
    assert.ok(urls.some((u) => u.includes("/python-devs")));
    assert.ok(urls.some((u) => u.endsWith("/bare-one")));
  });

  it("canonicalises bare URLs to https://", () => {
    const urls = extractCommunityUrls(FIXTURE_MD).map((u) => u.url);
    const bare = urls.find((u) => u.endsWith("/bare-one"));
    assert.ok(bare);
    assert.ok(bare!.startsWith("https://"), `expected https:// prefix, got ${bare}`);
  });

  it("strips trailing markdown punctuation (parens, commas)", () => {
    const urls = extractCommunityUrls(FIXTURE_MD).map((u) => u.url);
    const paren = urls.find((u) => u.includes("paren-test"));
    assert.ok(paren);
    assert.ok(!paren!.endsWith(")"));
    assert.ok(!paren!.endsWith(","));
  });

  it("dedupes repeated URLs", () => {
    const urls = extractCommunityUrls(FIXTURE_MD).map((u) => u.url);
    const rust = urls.filter((u) => u.endsWith("/rust-lang-community"));
    assert.equal(rust.length, 1, "rust-lang-community should appear exactly once");
  });

  it("extracts telegram, slack, skool, circle URLs", () => {
    const urls = extractCommunityUrls(FIXTURE_MD).map((u) => u.url);
    assert.ok(urls.some((u) => u.includes("t.me/some_group")));
    assert.ok(urls.some((u) => u.includes("join.slack.com/t/examplewksp")));
    assert.ok(urls.some((u) => u.includes("examplewksp.slack.com")));
    assert.ok(urls.some((u) => u.includes("skool.com/example-community")));
    assert.ok(urls.some((u) => u.includes("circle.so/example-brand")));
  });

  it("returns empty for markdown with no community URLs", () => {
    assert.deepEqual(
      extractCommunityUrls("# Empty\n\nNothing here."),
      []
    );
  });
});
