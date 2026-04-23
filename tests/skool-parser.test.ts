import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSkoolDiscoveryPage,
  extractSlug,
} from "../src/harvesters/skool-discovery.js";

// Fixture: the minimum __NEXT_DATA__ shape returned by skool.com/discovery
// (verified 2026-04-23 via gh-api probe). We don't need the full 165 KB blob
// — just the props.pageProps.{groups,numGroups} branch the parser reads.
function buildFixtureHtml(payload: unknown, extra = ""): string {
  return `<!doctype html><html><head>${extra}</head><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>
  </body></html>`;
}

const VALID_GROUPS = [
  {
    id: "aaa",
    name: "thatpickleballschool",
    displayName: "That Pickleball School",
    totalMembers: 1234,
    description: "Pickleball community",
  },
  {
    id: "bbb",
    name: "ai-automation-society",
    displayName: "AI Automation Society",
    totalMembers: 338011,
  },
  {
    id: "ccc",
    name: "minimal",
    // no display name, no member count
  },
];

describe("parseSkoolDiscoveryPage", () => {
  it("extracts groups + numGroups from a well-formed __NEXT_DATA__ blob", () => {
    const html = buildFixtureHtml({
      props: {
        pageProps: {
          groups: VALID_GROUPS,
          numGroups: 1000,
        },
      },
    });
    const parsed = parseSkoolDiscoveryPage(html);
    assert.equal(parsed.groups.length, 3);
    assert.equal(parsed.totalGroupsAvailable, 1000);
  });

  it("returns empty structure when the page has no __NEXT_DATA__ tag", () => {
    const parsed = parseSkoolDiscoveryPage("<html><body>nothing</body></html>");
    assert.deepEqual(parsed, { groups: [], totalGroupsAvailable: null });
  });

  it("returns empty structure when the JSON is malformed", () => {
    const html =
      '<script id="__NEXT_DATA__">{this is not valid JSON</script>';
    const parsed = parseSkoolDiscoveryPage(html);
    assert.deepEqual(parsed, { groups: [], totalGroupsAvailable: null });
  });

  it("tolerates empty groups array", () => {
    const html = buildFixtureHtml({
      props: { pageProps: { groups: [], numGroups: 0 } },
    });
    const parsed = parseSkoolDiscoveryPage(html);
    assert.equal(parsed.groups.length, 0);
    assert.equal(parsed.totalGroupsAvailable, 0);
  });

  it("ignores unrelated script tags and attribute variations", () => {
    const html = `<!doctype html><html><body>
      <script type="application/json">{"groups":[{"name":"decoy"}]}</script>
      <script id="__NEXT_DATA__" type="application/json" nonce="abc">${JSON.stringify(
        { props: { pageProps: { groups: [{ name: "real-slug" }] } } }
      )}</script>
    </body></html>`;
    const parsed = parseSkoolDiscoveryPage(html);
    assert.equal(parsed.groups.length, 1);
    assert.equal((parsed.groups[0] as { name: string }).name, "real-slug");
  });
});

describe("extractSlug", () => {
  it("accepts well-formed kebab-case slugs", () => {
    assert.equal(extractSlug({ name: "ai-automation-society" }), "ai-automation-society");
    assert.equal(extractSlug({ name: "thatpickleballschool" }), "thatpickleballschool");
    assert.equal(extractSlug({ name: "b2b-marketers-101" }), "b2b-marketers-101");
  });

  it("lowercases mixed-case slugs", () => {
    assert.equal(extractSlug({ name: "MixedCase" }), null); // must already be lowercase
    assert.equal(extractSlug({ name: "AI-Automation" }), null);
  });

  it("rejects slugs with whitespace, punctuation, or bad boundaries", () => {
    assert.equal(extractSlug({ name: "has space" }), null);
    assert.equal(extractSlug({ name: "-leading" }), null);
    assert.equal(extractSlug({ name: "trailing-" }), null);
    assert.equal(extractSlug({ name: "with/slash" }), null);
    assert.equal(extractSlug({ name: "" }), null);
    assert.equal(extractSlug({ name: "ab" }), null); // too short
  });

  it("rejects non-string name fields", () => {
    assert.equal(extractSlug({ name: undefined }), null);
    assert.equal(extractSlug({ name: 123 as unknown }), null);
    assert.equal(extractSlug({}), null);
  });
});
