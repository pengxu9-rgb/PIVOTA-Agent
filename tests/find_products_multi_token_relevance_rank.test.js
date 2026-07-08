'use strict';

// Phase 2 WS2 token-relevance rank (find_products_multi). Locks in: a product
// whose TITLE literally carries the query vocabulary ("Vita Niacinamide Dark
// Spot Serum") must not lose to zero-token category-bucket filler, and the tier
// rule must never demote an ingredient-proven product whose actives live in
// INCI text rather than its title (the Aruen pilot). See
// docs/find_products_multi_phase2_scope.md.

const SERVER_PATH = require.resolve('../src/server.js');

// Prod failure mode A (2026-07-08 baseline, "niacinamide serum for dark spots"):
// literal-title external seed ranked #18 below a blusher.
const LITERAL_TITLE_SEED = {
  source: 'external_seed',
  title: 'Vita Niacinamide Dark Spot Serum',
  brand: 'Round Lab',
  category: 'serum',
  product_type: 'serum',
  // Deliberately NO ingredient data: the title is all it has.
  image_url: 'http://example.test/roundlab.jpg',
  price: 22,
  in_stock: true,
};

// A canonical treat-bucket row with zero query tokens in its display surface but
// the active in its DESCRIPTION (this is what used to win on category+active).
const BUCKET_FILLER = {
  source: 'canonical_chain',
  search_recall_source: 'canonical_chain',
  title: 'Waterful Calming Ampoule',
  brand: 'SomeBrand',
  merchant_name: 'SomeBrand',
  category: 'serum',
  product_type: 'serum',
  category_path: ['beauty', 'skincare', 'treat', 'serum'],
  description: 'a calming ampoule with niacinamide for daily use',
  image_url: 'http://example.test/filler.jpg',
  price: 20,
  in_stock: true,
};

const BLUSHER = {
  source: 'canonical_chain',
  title: 'Moist Ampoule Blusher',
  brand: 'House of HUR',
  merchant_name: 'House of HUR',
  category: 'blusher',
  product_type: 'blusher',
  category_path: ['beauty', 'makeup', 'face', 'blush'],
  description: 'a moist ampoule blusher',
  image_url: 'http://example.test/blusher.jpg',
  price: 18,
  in_stock: true,
};

// Aruen pilot regression literals (from find_products_multi_active_aware_rank):
// actives live in INCI text, NOT the title — tier must stay 1 via active match.
const PILOT = {
  source: 'canonical_chain',
  search_recall_source: 'canonical_chain',
  title: 'Tofu Collagen Dual-Firming Jelly Cream',
  brand: 'Aruen',
  merchant_name: 'Aruen',
  category: 'cream',
  product_type: 'cream',
  category_path: ['beauty', 'skincare', 'moisturize', 'cream'],
  description: 'firming jelly cream',
  raw_ingredient_text_clean:
    'water, glycine soja (soybean) seed extract, adenosine, niacinamide, sodium hyaluronate, hydrolyzed collagen',
  image_url: 'http://example.test/pilot.jpg',
  price: 30,
  in_stock: true,
};

const QUERY = 'niacinamide serum for dark spots';

function loadServer(flags = {}) {
  const FLAG_KEYS = [
    'PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED',
    'PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED',
    'PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED',
  ];
  let mod;
  jest.isolateModules(() => {
    const prev = {};
    for (const key of FLAG_KEYS) {
      prev[key] = process.env[key];
      if (flags[key] === undefined) delete process.env[key];
      else process.env[key] = flags[key];
    }
    try {
      mod = require(SERVER_PATH);
    } finally {
      for (const key of FLAG_KEYS) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
  return mod._debug;
}

function scoreArgs(product, queryText) {
  return {
    product,
    queryText,
    intent: { families: [], normalized: queryText, brandBrowse: null, safety: [] },
    normalizedQuery: queryText,
    queryTokens: queryText.split(' '),
    searchQualityContract: null,
  };
}

describe('scoreBeautyQueryTokenRelevance — token matching mechanics', () => {
  const { scoreBeautyQueryTokenRelevance: rel } = loadServer({
    PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
  });
  const args = (product, q) => ({ product, queryTokens: q.split(' ') });

  test('literal-title product matches all significant tokens with phrase + all bonuses', () => {
    const r = rel(args(LITERAL_TITLE_SEED, QUERY));
    // "for" is a stop token; niacinamide/serum/dark/spots all present (spots->spot fold).
    expect(r.matched.sort()).toEqual(['dark', 'niacinamide', 'serum', 'spots']);
    expect(r.all_tokens).toBe(true);
    expect(r.phrase).toBe(true); // "dark spot(s)" bigram
    expect(r.bonus).toBe(4 * 26 + 48 + 36);
  });

  test('stop tokens and short tokens contribute nothing', () => {
    const r = rel(args({ title: 'For The' }, 'for the serum'));
    expect(r.count).toBe(0);
    expect(r.bonus).toBe(0);
  });

  test('zero-token bucket row earns nothing from its display surface', () => {
    expect(rel(args(BUCKET_FILLER, QUERY)).count).toBe(0);
    expect(rel(args(BLUSHER, QUERY)).count).toBe(0);
  });

  test('per-token bonus caps at 4 tokens', () => {
    const r = rel(
      args(
        { title: 'alpha bravo charlie delta echo foxtrot' },
        'alpha bravo charlie delta echo foxtrot',
      ),
    );
    expect(r.count).toBe(6);
    expect(r.bonus).toBe(4 * 26 + 48 + 36);
  });

  test('single-token match earns per-token only (no all-tokens bonus for 1-token queries)', () => {
    const r = rel(args({ title: 'Niacinamide Booster' }, 'niacinamide'));
    expect(r.bonus).toBe(26);
    expect(r.all_tokens).toBe(false);
  });
});

describe('title/brand as active-concept surfaces (includeTitleBrand)', () => {
  const dbg = loadServer({
    PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
    PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED: 'true',
  });

  test('literal title earns the niacinamide concept without INCI data', () => {
    const m = dbg.countBeautyActiveConceptMatches(QUERY, LITERAL_TITLE_SEED, {
      includeTitleBrand: true,
    });
    expect(m.keys).toContain('niacinamide');
  });

  test('registry invariant: a benefit word in the title alone earns nothing', () => {
    const benefitTitleOnly = { title: 'Firming Cream', brand: 'NoData' };
    const m = dbg.countBeautyActiveConceptMatches('korean firming cream', benefitTitleOnly, {
      includeTitleBrand: true,
    });
    expect(m.count).toBe(0);
  });

  test('scorer credits the title-earned active in active_match', () => {
    const r = dbg.scoreBeautyExternalSeedProduct(scoreArgs(LITERAL_TITLE_SEED, QUERY));
    expect(r.active_match).toBeTruthy();
    expect(r.active_match.keys).toContain('niacinamide');
  });
});

describe('scorer + tier — the baseline failure mode', () => {
  test('flag ON: literal-title seed outscores zero-token bucket filler and the blusher', () => {
    const { scoreBeautyExternalSeedProduct: score } = loadServer({
      PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
      PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED: 'true',
    });
    const literal = score(scoreArgs(LITERAL_TITLE_SEED, QUERY));
    const filler = score(scoreArgs(BUCKET_FILLER, QUERY));
    const blusher = score(scoreArgs(BLUSHER, QUERY));

    expect(literal.token_tier).toBe(1);
    expect(filler.token_tier).toBe(1); // niacinamide in description => active match keeps tier 1
    expect(blusher.token_tier).toBe(0); // no tokens, no actives => bucket filler
    expect(literal.score).toBeGreaterThan(filler.score);
    expect(literal.score).toBeGreaterThan(blusher.score);
    expect(literal.token_relevance.all_tokens).toBe(true);
  });

  test('tier rule never demotes the INCI-proven pilot (actives not in title)', () => {
    const { scoreBeautyExternalSeedProduct: score } = loadServer({
      PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
      PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED: 'true',
    });
    const soy = score(scoreArgs(PILOT, 'soy firming cream'));
    expect(soy.token_tier).toBe(1); // via active match, not title tokens
    expect(soy.active_match.keys.sort()).toEqual(['firming', 'soy']);

    const adenosine = score(scoreArgs(PILOT, 'adenosine firming cream'));
    expect(adenosine.token_tier).toBe(1);

    // Title-token query still matches on the title surface directly.
    const jelly = score(scoreArgs(PILOT, 'jelly cream'));
    expect(jelly.token_tier).toBe(1);
    expect(jelly.token_relevance.matched.sort()).toEqual(['cream', 'jelly']);
  });

  test('tier rule holds even with the Phase-1 active rank flag OFF (activeMatch still computed)', () => {
    const { scoreBeautyExternalSeedProduct: score } = loadServer({
      PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
    });
    const soy = score(scoreArgs(PILOT, 'soy firming cream'));
    expect(soy.token_tier).toBe(1); // INCI actives protect the tier without the rank bonus
    expect(soy.active_match).toBeUndefined(); // but no Phase-1 bonus is credited
  });

  test('flag OFF (default): no token fields, scores match the historical path', () => {
    const flagOff = loadServer({});
    const flagFalse = loadServer({ PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'false' });
    for (const product of [LITERAL_TITLE_SEED, BUCKET_FILLER, BLUSHER, PILOT]) {
      const a = flagOff.scoreBeautyExternalSeedProduct(scoreArgs(product, QUERY));
      const b = flagFalse.scoreBeautyExternalSeedProduct(scoreArgs(product, QUERY));
      expect(a.token_relevance).toBeUndefined();
      expect(a.token_tier).toBeUndefined();
      expect(a.score).toBe(b.score);
    }
  });
});
