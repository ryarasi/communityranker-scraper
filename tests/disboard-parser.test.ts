import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDisboardPage } from "../src/harvesters/disboard.js";

// Fixture: a simplified slice of disboard.org/servers/tag/community HTML.
// Real Disboard markup is verbose; what matters for the parser is that each
// server card contains (a) an https:// discord.gg or discord.com/invite URL,
// (b) a "N,NNN Members" copy string, and (c) an `<h3>` or `.server-name`
// title within the ±500-char neighbourhood of the invite.
const FIXTURE_HTML = `
<!doctype html><html><body>
<main>
<section class="listing">
  <article class="server-card">
    <h3>Test Community Alpha</h3>
    <p>A chill place for testers.</p>
    <span>1,234 Members</span>
    <a href="https://discord.gg/abc123">Join</a>
  </article>
  <article class="server-card">
    <h3>Beta Devs Hangout</h3>
    <p>No member count here.</p>
    <a href="https://discord.gg/betadevs">Invite</a>
  </article>
  <article class="server-card">
    <h3>Huge Gamer Guild</h3>
    <span>123,456 Members</span>
    <a href="https://discord.com/invite/huge-game">Join</a>
  </article>
  <!-- duplicate invite should be deduped -->
  <article class="server-card">
    <h3>Dup</h3>
    <a href="https://discord.gg/abc123">Re-listed</a>
  </article>
</section>
</main>
</body></html>
`;

describe("parseDisboardPage", () => {
  it("extracts invite URLs from server cards", () => {
    const cards = parseDisboardPage(FIXTURE_HTML);
    assert.ok(cards.length >= 3, `expected at least 3 cards, got ${cards.length}`);
    const urls = cards.map((c) => c.inviteUrl);
    assert.ok(urls.includes("https://discord.gg/abc123"));
    assert.ok(urls.includes("https://discord.gg/betadevs"));
    // discord.com/invite/ URLs get canonicalised back to discord.gg for pipeline consistency
    assert.ok(urls.some((u) => u.includes("huge-game")));
  });

  it("dedupes repeated invites on the same page", () => {
    const cards = parseDisboardPage(FIXTURE_HTML);
    const codes = cards.map((c) => c.inviteUrl);
    assert.equal(new Set(codes).size, codes.length, "invite URLs should be unique");
  });

  it("parses member-count hints when present", () => {
    const cards = parseDisboardPage(FIXTURE_HTML);
    const alpha = cards.find((c) => c.inviteUrl.endsWith("/abc123"));
    assert.ok(alpha, "alpha card present");
    assert.equal(alpha!.memberHint, 1234);

    const huge = cards.find((c) => c.inviteUrl.includes("huge-game"));
    assert.ok(huge);
    assert.equal(huge!.memberHint, 123456);
  });

  it("parses name hints from h3 or .server-name", () => {
    const cards = parseDisboardPage(FIXTURE_HTML);
    const alpha = cards.find((c) => c.inviteUrl.endsWith("/abc123"));
    assert.ok(alpha);
    assert.ok(alpha!.name && alpha!.name.includes("Test Community Alpha"));
  });

  it("returns empty for HTML with no invites", () => {
    assert.deepEqual(parseDisboardPage("<html><body>nothing here</body></html>"), []);
  });

  it("ignores scripts + styles", () => {
    const polluted = `
      <script>var x = "https://discord.gg/fakeFromScript";</script>
      <style>.x{content:"https://discord.gg/fakeFromStyle"}</style>
      <article><h3>Real</h3><a href="https://discord.gg/realOne">link</a></article>
    `;
    const cards = parseDisboardPage(polluted);
    const urls = cards.map((c) => c.inviteUrl);
    assert.ok(urls.includes("https://discord.gg/realOne"));
    assert.ok(!urls.some((u) => u.includes("fakeFromScript")));
    assert.ok(!urls.some((u) => u.includes("fakeFromStyle")));
  });
});
