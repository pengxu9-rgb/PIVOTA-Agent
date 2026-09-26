// The HTTP fetcher is the only part of this module that touches the network, and
// the guard under test is that it does NOT dial when it has no internal key.
// A mocked axios is what makes "no call happened" assertable; every other test
// here supplies its own fetchLinks and never reaches axios at all.
jest.mock('axios', () => jest.fn(async () => ({ data: { links: [] } })));

const axios = require('axios');
const {
  MAX_SEED_LINK_CANDIDATES,
  collectUnattributedSeedCards,
  buildSeedLinkCandidates,
  stampExternalSeedAttribution,
  applyExternalSeedAttributionMetadata,
  createBackendSeedLinkFetcher,
  isExternalSeedAttributionStampEnabled,
} = require('../src/services/externalSeedAttributionStamp');

// The exact shape safety-kernel's result sanitizer preserves verbatim
// (safety-kernel/src/protocol/resultSanitizer.js:88, ATTRIBUTED_LINK_RE).
// Inlined rather than imported: the packages do not depend on each other, and a
// cross-package require would couple them. Pinned here so a backend change to
// the minted link shape fails in this repo instead of silently degrading — a
// redirect that misses this regex is scrubbed on its way through the MCP door,
// and the agent is handed an attribution link that no longer resolves.
const SAFETY_KERNEL_ATTRIBUTED_LINK_RE =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/r\?token=[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+$/;

function seedCard(overrides = {}) {
  return {
    id: 'ext_1',
    product_id: 'ext_1',
    external_product_id: 'ext_1',
    // Present as DATA only. The lane is detected from source/platform (ADR-009):
    // the seller identity is the thing a re-key migrates away from.
    merchant_id: 'external_seed',
    source: 'external_seed',
    platform: 'external',
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

  test("matches on platform 'external' when source is absent", () => {
    // Either lane field alone is enough; neither is the seller identity.
    const card = seedCard({ source: undefined });
    expect(collectUnattributedSeedCards([card])).toEqual([card]);
    const bySourceOnly = seedCard({ platform: undefined });
    expect(collectUnattributedSeedCards([bySourceOnly])).toEqual([bySourceOnly]);
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
    const internal = seedCard({ source: 'catalog', platform: 'shopify', merchant_id: 'murad' });
    expect(collectUnattributedSeedCards([internal])).toEqual([]);
    // The seller identity alone must NOT qualify a card: after the ADR-009
    // re-key the sentinel seller stops being a lane signal.
    const sellerOnly = seedCard({ source: 'catalog', platform: 'shopify' });
    expect(sellerOnly.merchant_id).toBe('external_seed');
    expect(collectUnattributedSeedCards([sellerOnly])).toEqual([]);
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

  test('kill switch: both truthy and falsy spellings are understood', () => {
    const card = seedCard();
    const collectWith = (value) =>
      collectUnattributedSeedCards([card], {
        env: value === undefined ? {} : { EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: value },
      });

    // ON. 'true' used to read as OFF, which meant an operator spelling the
    // switch the obvious way DISARMED the thing they were trying to arm.
    for (const on of [undefined, '', '1', 'true', 'TRUE', ' on ', 'yes', 'Yes']) {
      expect(collectWith(on)).toEqual([card]);
    }
    // OFF.
    for (const off of ['0', 'false', 'False', 'off', ' OFF ', 'no']) {
      expect(collectWith(off)).toEqual([]);
    }

    expect(isExternalSeedAttributionStampEnabled({})).toBe(true);
    expect(
      isExternalSeedAttributionStampEnabled({ EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: 'true' }),
    ).toBe(true);
    expect(
      isExternalSeedAttributionStampEnabled({ EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: 'off' }),
    ).toBe(false);
    expect(
      isExternalSeedAttributionStampEnabled({ EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: '0' }),
    ).toBe(false);
  });

  test('an unrecognized kill-switch value stays ON and warns exactly once', () => {
    // Isolated registry: the warn-once latch is module state.
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      const mod = require('../src/services/externalSeedAttributionStamp');
      const logger = { warn: jest.fn() };
      const env = { EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: 'maybe' };
      expect(mod.isExternalSeedAttributionStampEnabled(env, logger)).toBe(true);
      expect(mod.isExternalSeedAttributionStampEnabled(env, logger)).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('buildSeedLinkCandidates', () => {
  test('builds the full candidate shape from the card', () => {
    const candidates = buildSeedLinkCandidates([seedCard()]);
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
    const candidates = buildSeedLinkCandidates(cards);
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

describe('stamp origin guard', () => {
  test('a foreign-origin destination is refused but the redirect still lands', async () => {
    const card = seedCard();
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks: async () => [
        linkFor({ destination_url: 'https://evil.example/products/watch-ya-tone?pvt_click_id=clk_1' }),
      ],
    });
    // The mint may attribute a card; it must never MOVE one to another merchant.
    expect(counts).toEqual({ candidates: 1, stamped: 1 });
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
    expect(card.external_redirect_url).toBe('https://api.pivota.cc/r?token=abc.def');
    expect(card.tracking).toEqual({
      click_id: 'clk_1',
      param: 'pvt_click_id',
      join_mode: 'referral_only',
    });
  });

  test('a same-origin destination on a different path/port is judged by origin only', async () => {
    const sameHost = seedCard();
    await stampExternalSeedAttribution([sameHost], {
      fetchLinks: async () => [
        linkFor({ destination_url: 'https://fentybeauty.com/collections/serums?pvt_click_id=clk_1' }),
      ],
    });
    expect(sameHost.destination_url).toBe(
      'https://fentybeauty.com/collections/serums?pvt_click_id=clk_1',
    );

    const otherPort = seedCard();
    await stampExternalSeedAttribution([otherPort], {
      fetchLinks: async () => [
        linkFor({ destination_url: 'https://fentybeauty.com:8443/products/watch-ya-tone' }),
      ],
    });
    expect(otherPort.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
  });

  test('a non-http cart_url is refused, and so is a foreign-origin one', async () => {
    const scripted = seedCard();
    await stampExternalSeedAttribution([scripted], {
      fetchLinks: async () => [linkFor({ cart_url: 'javascript:alert(1)' })],
    });
    expect(scripted).not.toHaveProperty('cart_url');

    const foreign = seedCard();
    await stampExternalSeedAttribution([foreign], {
      fetchLinks: async () => [linkFor({ cart_url: 'https://evil.example/cart/1:1' })],
    });
    expect(foreign).not.toHaveProperty('cart_url');

    const ok = seedCard();
    await stampExternalSeedAttribution([ok], {
      fetchLinks: async () => [linkFor({ cart_url: 'https://fentybeauty.com/cart/1:1' })],
    });
    expect(ok.cart_url).toBe('https://fentybeauty.com/cart/1:1');
  });

  test('a non-http destination_url is refused like any other unusable url', async () => {
    const card = seedCard();
    await stampExternalSeedAttribution([card], {
      fetchLinks: async () => [linkFor({ destination_url: 'javascript:alert(1)' })],
    });
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
    expect(card.external_redirect_url).toBe('https://api.pivota.cc/r?token=abc.def');
  });

  test('two cards resolving to one link do not share a tracking object', async () => {
    const first = seedCard();
    const second = seedCard({
      external_seed_id: 'seed_2',
      external_product_id: 'ext_1',
      id: 'ext_1',
      product_id: 'ext_1',
    });
    const link = linkFor();
    const counts = await stampExternalSeedAttribution([first, second], {
      // Both cards resolve to this one entry: `first` on its seed id, `second`
      // on the external_product_id fallback.
      fetchLinks: async () => [link],
    });
    expect(counts).toEqual({ candidates: 2, stamped: 2 });
    expect(first.tracking).toEqual(second.tracking);
    expect(first.tracking).not.toBe(second.tracking);
    expect(first.tracking).not.toBe(link.tracking);
    first.tracking.click_id = 'mutated';
    expect(second.tracking.click_id).toBe('clk_1');
    expect(link.tracking.click_id).toBe('clk_1');
  });
});

describe('createBackendSeedLinkFetcher', () => {
  beforeEach(() => {
    axios.mockClear();
    axios.mockImplementation(async () => ({ data: { links: [linkFor()] } }));
  });

  test('sends the mint with the headers it was given', async () => {
    const card = seedCard();
    const fetchLinks = createBackendSeedLinkFetcher({
      apiBase: 'http://pivota.test/',
      buildHeaders: () => ({ 'X-API-Key': 'internal-key' }),
    });
    const counts = await stampExternalSeedAttribution([card], {
      fetchLinks,
      market: 'US',
      tool: 'find_products_multi',
    });
    expect(counts).toEqual({ candidates: 1, stamped: 1 });
    expect(axios).toHaveBeenCalledTimes(1);
    const sent = axios.mock.calls[0][0];
    expect(sent.url).toBe('http://pivota.test/agent/shop/v1/attribution/external-seed-links');
    expect(sent.headers['X-API-Key']).toBe('internal-key');
    expect(sent.timeout).toBe(800);
    expect(sent.data).toEqual(
      expect.objectContaining({ market: 'US', tool: 'find_products_multi' }),
    );
  });

  test('no internal key => no HTTP call at all, cards unchanged', async () => {
    // buildInvokeUpstreamAuthHeaders falls back to the CALLER's key when
    // PIVOTA_API_KEY is unset. A caller-scoped mint would bind one caller's
    // identity to links every other caller is then served from cache, so the
    // call site hands back null and the fetcher must refuse to dial.
    const card = seedCard();
    const fetchLinks = createBackendSeedLinkFetcher({
      apiBase: 'http://pivota.test',
      buildHeaders: () => null,
    });
    const counts = await stampExternalSeedAttribution([card], { fetchLinks });
    expect(axios).not.toHaveBeenCalled();
    expect(counts).toEqual({
      candidates: 1,
      stamped: 0,
      error: 'internal_key_unavailable',
    });
    expect(card).not.toHaveProperty('external_redirect_url');
    expect(card.destination_url).toBe('https://fentybeauty.com/products/watch-ya-tone');
  });

  test('honours EXTERNAL_SEED_ATTRIBUTION_TIMEOUT_MS', async () => {
    const fetchLinks = createBackendSeedLinkFetcher({
      apiBase: 'http://pivota.test',
      buildHeaders: () => ({ 'X-API-Key': 'internal-key' }),
      env: { EXTERNAL_SEED_ATTRIBUTION_TIMEOUT_MS: '120' },
    });
    await fetchLinks([], {});
    expect(axios.mock.calls[0][0].timeout).toBe(120);
  });
});

describe('applyExternalSeedAttributionMetadata', () => {
  test('writes the counts without disturbing other metadata keys', () => {
    const body = { products: [], metadata: { query_source: 'ingredient_direct' } };
    applyExternalSeedAttributionMetadata(body, { candidates: 3, stamped: 2 });
    expect(body.metadata).toEqual({
      query_source: 'ingredient_direct',
      external_seed_attribution: { candidates: 3, stamped: 2 },
    });
  });

  test('stays absent when nothing was a candidate', () => {
    const body = { products: [], metadata: {} };
    applyExternalSeedAttributionMetadata(body, { candidates: 0, stamped: 0 });
    applyExternalSeedAttributionMetadata(body, null);
    expect(body.metadata).not.toHaveProperty('external_seed_attribution');
  });
});

describe('the minted redirect survives the safety-kernel sanitizer', () => {
  test('the fixture redirect matches ATTRIBUTED_LINK_RE verbatim', async () => {
    // If this fails, every test above is asserting a link shape the MCP door
    // would SCRUB — the stamp would look correct here and degrade in prod.
    expect(linkFor().external_redirect_url).toMatch(SAFETY_KERNEL_ATTRIBUTED_LINK_RE);

    const card = seedCard();
    await stampExternalSeedAttribution([card], { fetchLinks: async () => [linkFor()] });
    expect(card.external_redirect_url).toMatch(SAFETY_KERNEL_ATTRIBUTED_LINK_RE);

    // CONTROL: the regex is strict, not a rubber stamp. Each of these is a
    // realistic near-miss the backend could return.
    for (const rejected of [
      'http://api.pivota.cc/r?token=abc.def',
      'https://api.pivota.cc/r?token=abcdef',
      'https://api.pivota.cc/redirect?token=abc.def',
      'https://api.pivota.cc/r?token=abc.def&utm_source=pivota',
    ]) {
      expect(rejected).not.toMatch(SAFETY_KERNEL_ATTRIBUTED_LINK_RE);
    }
  });
});
