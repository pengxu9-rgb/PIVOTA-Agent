const {
  MAX_SEED_LINK_CANDIDATES,
  collectUnattributedSeedCards,
  buildSeedLinkCandidates,
  stampExternalSeedAttribution,
  isExternalSeedAttributionStampEnabled,
} = require('../src/services/externalSeedAttributionStamp');

function seedCard(overrides = {}) {
  return {
    id: 'ext_1',
    product_id: 'ext_1',
    external_product_id: 'ext_1',
    merchant_id: 'external_seed',
    source: 'external_seed',
    title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
    destination_url: 'https://fentybeauty.com/products/watch-ya-tone',
    canonical_url: 'https://fentybeauty.com/products/watch-ya-tone',
    external_seed_id: 'seed_1',
    market: 'US',
    ...overrides,
  };
}

function linkFor(overrides = {}) {
  return {
    external_seed_id: 'seed_1',
    external_product_id: 'ext_1',
    external_redirect_url: 'https://api.pivota.cc/r?token=abc.def',
    destination_url:
      'https://fentybeauty.com/products/watch-ya-tone?utm_source=pivota&pvt_click_id=clk_1',
    cart_url: null,
    tracking: { click_id: 'clk_1', param: 'pvt_click_id', join_mode: 'referral_only' },
    ...overrides,
  };
}

describe('collectUnattributedSeedCards', () => {
  test('collects an external seed card that has a destination and a seed id but no redirect', () => {
    const card = seedCard();
    expect(collectUnattributedSeedCards([card])).toEqual([card]);
  });

  test('matches on merchant_id even when source is absent', () => {
    const card = seedCard({ source: undefined });
    expect(collectUnattributedSeedCards([card])).toEqual([card]);
  });

  test('skips a card that already carries an external_redirect_url', () => {
    const stamped = seedCard({
      external_redirect_url: 'https://api.pivota.cc/r?token=already.minted',
    });
    expect(collectUnattributedSeedCards([stamped])).toEqual([]);
  });

  test('skips a card whose external_redirect_url merely equals its destination_url', () => {
    // An existing value is never second-guessed, even when it is not a /r?token= link.
    const odd = seedCard({
      external_redirect_url: 'https://fentybeauty.com/products/watch-ya-tone',
    });
    expect(collectUnattributedSeedCards([odd])).toEqual([]);
  });

  test('skips non external-seed cards', () => {
    const internal = seedCard({ source: 'catalog', merchant_id: 'murad' });
    expect(collectUnattributedSeedCards([internal])).toEqual([]);
  });

  test('skips cards with a missing, blank, or non-http destination_url', () => {
    expect(collectUnattributedSeedCards([seedCard({ destination_url: undefined })])).toEqual([]);
    expect(collectUnattributedSeedCards([seedCard({ destination_url: '   ' })])).toEqual([]);
    expect(
      collectUnattributedSeedCards([seedCard({ destination_url: 'javascript:alert(1)' })]),
    ).toEqual([]);
    expect(collectUnattributedSeedCards([seedCard({ destination_url: 'not a url' })])).toEqual([]);
  });

  test('skips cards with no external_seed_id', () => {
    expect(collectUnattributedSeedCards([seedCard({ external_seed_id: undefined })])).toEqual([]);
    expect(collectUnattributedSeedCards([seedCard({ external_seed_id: '' })])).toEqual([]);
  });

  test('tolerates a non-array products container', () => {
    expect(collectUnattributedSeedCards(null)).toEqual([]);
    expect(collectUnattributedSeedCards({ products: [] })).toEqual([]);
    expect(collectUnattributedSeedCards([null, undefined, 'x'])).toEqual([]);
  });

  test('kill switch: any value other than 1 disables collection entirely', () => {
    const card = seedCard();
    expect(collectUnattributedSeedCards([card], { env: {} })).toEqual([card]);
    expect(
      collectUnattributedSeedCards([card], { env: { EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: '1' } }),
    ).toEqual([card]);
    expect(
      collectUnattributedSeedCards([card], { env: { EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: '0' } }),
    ).toEqual([]);
    expect(
      collectUnattributedSeedCards([card], {
        env: { EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: 'false' },
      }),
    ).toEqual([]);
    expect(isExternalSeedAttributionStampEnabled({})).toBe(true);
    expect(isExternalSeedAttributionStampEnabled({ EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: '0' })).toBe(
      false,
    );
  });
});

describe('buildSeedLinkCandidates', () => {
  test('builds the full candidate shape from the card', () => {
    const candidates = buildSeedLinkCandidates([seedCard()], {
      market: 'US',
      tool: 'find_products_multi',
    });
    expect(candidates).toEqual([
      {
        external_seed_id: 'seed_1',
        external_product_id: 'ext_1',
        destination_url: 'https://fentybeauty.com/products/watch-ya-tone',
        canonical_url: 'https://fentybeauty.com/products/watch-ya-tone',
        market: 'US',
        tool: null,
        utm_template: null,
        domain: null,
        attached_product_key: null,
        attached_variant_id: null,
        seller_ref: null,
        seed_kind: null,
        variant_id: null,
      },
    ]);
  });

  test('falls back through external_product_id -> product_id -> id', () => {
    expect(
      buildSeedLinkCandidates([seedCard({ external_product_id: undefined })])[0].external_product_id,
    ).toBe('ext_1');
    expect(
      buildSeedLinkCandidates([
        seedCard({ external_product_id: undefined, product_id: undefined, id: 'only_id' }),
      ])[0].external_product_id,
    ).toBe('only_id');
  });

  test('passes optional seed fields through when present on the card', () => {
    const candidate = buildSeedLinkCandidates([
      seedCard({
        utm_template: '?utm_source=pivota',
        domain: 'fentybeauty.com',
        attached_product_key: 'shopify:123',
        attached_variant_id: 'v_9',
        seller_ref: 'seller_x',
        seed_kind: 'brand_crawl',
        variant_id: 'v_9',
        tool: '*',
      }),
    ])[0];
    expect(candidate).toEqual(
      expect.objectContaining({
        utm_template: '?utm_source=pivota',
        domain: 'fentybeauty.com',
        attached_product_key: 'shopify:123',
        attached_variant_id: 'v_9',
        seller_ref: 'seller_x',
        seed_kind: 'brand_crawl',
        variant_id: 'v_9',
        tool: '*',
      }),
    );
  });

  test('sends at most 50 candidates, taking the first 50', () => {
    const cards = Array.from({ length: 73 }, (_, i) =>
      seedCard({ external_seed_id: `seed_${i}`, external_product_id: `ext_${i}` }),
    );
    const candidates = buildSeedLinkCandidates(cards, {});
    expect(MAX_SEED_LINK_CANDIDATES).toBe(50);
    expect(candidates).toHaveLength(50);
    expect(candidates[0].external_seed_id).toBe('seed_0');
    expect(candidates[49].external_seed_id).toBe('seed_49');
  });
});

describe('stampExternalSeedAttribution', () => {
  test('joins on external_seed_id and stamps the card in place', async () => {
    const card = seedCard();
    const products = [card];
    const fetchLinks = jest.fn(async () => [linkFor()]);

    const counts = await stampExternalSeedAttribution(products, { fetchLinks });

    expect(counts).toEqual({ candidates: 1, stamped: 1 });
    expect(fetchLinks).toHaveBeenCalledTimes(1);
    // Same object identity: the response body is never rebuilt.
    expect(products[0]).toBe(card);
    expect(card.external_redirect_url).toBe('https://api.pivota.cc/r?token=abc.def');
    expect(card.destination_url).toBe(
      'https://fentybeauty.com/products/watch-ya-tone?utm_source=pivota&pvt_click_id=clk_1',
    );
    expect(card.tracking).toEqual({
      click_id: 'clk_1',
      param: 'pvt_click_id',
      join_mode: 'referral_only',
    });
    // canonical_url is never touched.
    expect(card.canonical_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
  });

  test('falls back to external_product_id when the link carries no seed id', async () => {
    const card = seedCard();
    const fetchLinks = jest.fn(async () => [linkFor({ external_seed_id: null })]);
    const counts = await stampExternalSeedAttribution([card], { fetchLinks });
    expect(counts).toEqual({ candidates: 1, stamped: 1 });
    expect(card.external_redirect_url).toBe('https://api.pivota.cc/r?token=abc.def');
  });

  test('a null destination_url keeps the card raw destination', async () => {
    const card = seedCard();
    const fetchLinks = jest.fn(async () => [linkFor({ destination_url: null })]);
    const counts = await stampExternalSeedAttribution([card], { fetchLinks });
    expect(counts).toEqual({ candidates: 1, stamped: 1 });
    expect(card.external_redirect_url).toBe('https://api.pivota.cc/r?token=abc.def');
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
  });

  test('a non-null cart_url is stamped, a null one is not', async () => {
    const withCart = seedCard();
    await stampExternalSeedAttribution([withCart], {
      fetchLinks: async () => [linkFor({ cart_url: 'https://fentybeauty.com/cart/1:1' })],
    });
    expect(withCart.cart_url).toBe('https://fentybeauty.com/cart/1:1');

    const withoutCart = seedCard();
    await stampExternalSeedAttribution([withoutCart], { fetchLinks: async () => [linkFor()] });
    expect(withoutCart).not.toHaveProperty('cart_url');
  });

  test('a card the backend could not mint is left untouched', async () => {
    const minted = seedCard();
    const notMinted = seedCard({
      external_seed_id: 'seed_2',
      external_product_id: 'ext_2',
      id: 'ext_2',
      product_id: 'ext_2',
      destination_url: 'https://not-allowlisted.example/p/2',
    });
    const counts = await stampExternalSeedAttribution([minted, notMinted], {
      fetchLinks: async () => [linkFor()],
    });
    expect(counts).toEqual({ candidates: 2, stamped: 1 });
    expect(minted.external_redirect_url).toBe('https://api.pivota.cc/r?token=abc.def');
    expect(notMinted).not.toHaveProperty('external_redirect_url');
    expect(notMinted.destination_url).toBe('https://not-allowlisted.example/p/2');
  });

  test('mismatched ids stamp nothing', async () => {
    const card = seedCard();
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks: async () => [
        linkFor({ external_seed_id: 'seed_other', external_product_id: 'ext_other' }),
      ],
    });
    expect(counts).toEqual({ candidates: 1, stamped: 0 });
    expect(card).not.toHaveProperty('external_redirect_url');
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
  });

  test('fail-soft: a throwing fetchLinks stamps nothing and never rejects', async () => {
    const card = seedCard();
    const logger = { warn: jest.fn() };
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks: async () => {
        throw new Error('timeout of 800ms exceeded');
      },
      logger,
    });
    expect(counts).toEqual({
      candidates: 1,
      stamped: 0,
      error: 'timeout of 800ms exceeded',
    });
    expect(card).not.toHaveProperty('external_redirect_url');
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('fail-soft: a non-array links payload stamps nothing', async () => {
    const card = seedCard();
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks: async () => ({ links: [linkFor()] }),
    });
    expect(counts).toEqual({ candidates: 1, stamped: 0, error: 'invalid_links_payload' });
    expect(card).not.toHaveProperty('external_redirect_url');

    const nullCard = seedCard();
    expect(
      await stampExternalSeedAttribution([nullCard], { fetchLinks: async () => null }),
    ).toEqual({ candidates: 1, stamped: 0, error: 'invalid_links_payload' });
    expect(nullCard).not.toHaveProperty('external_redirect_url');
  });

  test('a link without a usable external_redirect_url stamps nothing on that card', async () => {
    const card = seedCard();
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks: async () => [linkFor({ external_redirect_url: null })],
    });
    expect(counts).toEqual({ candidates: 1, stamped: 0 });
    expect(card).not.toHaveProperty('external_redirect_url');
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
  });

  test('does not call the backend when there is nothing to stamp', async () => {
    const fetchLinks = jest.fn(async () => [linkFor()]);
    const counts = await stampExternalSeedAttribution(
      [seedCard({ external_redirect_url: 'https://api.pivota.cc/r?token=x.y' })],
      { fetchLinks },
    );
    expect(fetchLinks).not.toHaveBeenCalled();
    expect(counts).toEqual({ candidates: 0, stamped: 0 });
  });

  test('kill switch disables the stamp even when cards qualify', async () => {
    const card = seedCard();
    const fetchLinks = jest.fn(async () => [linkFor()]);
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks,
      env: { EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: '0' },
    });
    expect(fetchLinks).not.toHaveBeenCalled();
    expect(counts).toEqual({ candidates: 0, stamped: 0 });
    expect(card).not.toHaveProperty('external_redirect_url');
  });

  test('a 51st card is never stamped from a link the backend was never asked for', async () => {
    const cards = Array.from({ length: 51 }, (_, i) =>
      seedCard({ external_seed_id: `seed_${i}`, external_product_id: `ext_${i}`, id: `ext_${i}`, product_id: `ext_${i}` }),
    );
    let sent = null;
    const counts = await stampExternalSeedAttribution(cards, {
      fetchLinks: async (candidates) => {
        sent = candidates;
        return [linkFor({ external_seed_id: 'seed_50', external_product_id: 'ext_50' })];
      },
    });
    expect(sent).toHaveLength(50);
    expect(counts).toEqual({ candidates: 50, stamped: 0 });
    expect(cards[50]).not.toHaveProperty('external_redirect_url');
  });
});
