const { composeExternalFirstFeed } = require("../../src/layer3/feed/feedComposer");

describe("layer3/feedComposer", () => {
  test("composes deterministic feed items and resolves up to maxOffersPerRole", async () => {
    const resolveOffer = jest.fn(async ({ url, market }) => ({
      offerId: `offer_${url.split("/").pop()}`,
      source: "external",
      market,
      canonicalUrl: url,
      domain: "example.com",
      title: "Example",
      lastCheckedAt: new Date("2025-01-01T00:00:00.000Z").toISOString(),
      disclosure: { type: "unknown", text: "Disclosure" },
    }));

    const result = await composeExternalFirstFeed({
      market: "US",
      locale: "en-US",
      roleIds: ["ROLE:b", "ROLE:a", "ROLE:a"],
      maxOffersPerRole: 2,
      linkIndexOverride: {
        "ROLE:a": ["https://example.com/a1", "https://example.com/a2", "https://example.com/a3"],
        "ROLE:b": ["https://example.com/b1"],
      },
      resolveOffer,
    });

    expect(result.market).toBe("US");
    expect(result.feedItems.map((i) => i.roleId)).toEqual(["ROLE:a", "ROLE:b"]);
    expect(result.feedItems[0].offers.map((o) => o.canonicalUrl)).toEqual([
      "https://example.com/a1",
      "https://example.com/a2",
    ]);
    expect(result.feedItems[1].offers.map((o) => o.canonicalUrl)).toEqual(["https://example.com/b1"]);
    expect(resolveOffer).toHaveBeenCalledTimes(3);
    expect(result.errors).toEqual([]);
  });

  test("collects resolve errors but remains deterministic", async () => {
    const resolveOffer = jest.fn(async ({ url }) => {
      const error = new Error("blocked");
      error.code = url.endsWith("bad") ? "DOMAIN_NOT_ALLOWED" : "RESOLVE_FAILED";
      throw error;
    });

    const result = await composeExternalFirstFeed({
      market: "US",
      roleIds: ["ROLE:a"],
      maxOffersPerRole: 3,
      linkIndexOverride: { "ROLE:a": ["https://example.com/bad", "https://example.com/bad2"] },
      resolveOffer,
    });

    expect(result.feedItems).toHaveLength(1);
    expect(result.feedItems[0].offers).toEqual([]);
    expect(result.errors).toEqual([
      { roleId: "ROLE:a", url: "https://example.com/bad", code: "DOMAIN_NOT_ALLOWED" },
      { roleId: "ROLE:a", url: "https://example.com/bad2", code: "RESOLVE_FAILED" },
    ]);
  });
});

