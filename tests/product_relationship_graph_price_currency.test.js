// A relationship-graph price keeps its currency, read from the record that supplied the amount.
//
// 2026-09-27 prod census: all 4,964 serving edges with candidate_snapshot.price had no currency
// key, and none of the 7,667 price_evidence rows had one. The seed SELECTs read
// eps.price_currency; normalizeProductCandidateSnapshot dropped it, and the builder divided the two
// bare amounts into a price_ratio whatever their currencies were.
const {
  normalizeCurrencyCode,
  recordCurrency,
  readPriceWithCurrency,
  comparablePriceRatio,
} = require('../src/auroraBff/relationshipPriceCurrency');
const {
  normalizeProductCandidateSnapshot,
  normalizeExternalProductSeedRow,
  normalizeProductsCacheRow,
  normalizeApprovedLiveExternalSeedRow,
  normalizeCatalogProductRow,
  __internal: { scoreCandidateForAnchor, compareScoredCandidates },
} = require('../src/auroraBff/productRelationshipGraphSources');
const {
  buildEdgeForCandidate,
  buildNicheSpecialistEdge,
  CURATED_NEED_NODES,
} = require('../src/auroraBff/productRelationshipGraphBuilder');
const {
  coerceRelationshipEdge,
  validateRelationshipEdge,
  __internal: { getPriceRatio },
} = require('../src/auroraBff/productRelationshipGraph');

const NOW = '2026-09-27T00:00:00.000Z';
const toNumber = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return toNumber(value.amount ?? value.value ?? value.price);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

describe('currency codes', () => {
  test('ISO-4217 alpha only, case-folded', () => {
    expect(normalizeCurrencyCode('usd')).toBe('USD');
    expect(normalizeCurrencyCode(' JPY ')).toBe('JPY');
    for (const junk of ['$', 'US$', '840', 'USDX', 'US', '', '¥', null, undefined, 840]) {
      expect(normalizeCurrencyCode(junk)).toBeNull();
    }
  });

  test('a record that names two different currencies names none', () => {
    expect(recordCurrency({ price_currency: 'USD' })).toBe('USD');
    expect(recordCurrency({ currency: 'eur' })).toBe('EUR');
    expect(recordCurrency({ price_currency: 'USD', currency: 'usd' })).toBe('USD');
    expect(recordCurrency({ price_currency: 'USD', currency: 'JPY' })).toBeNull();
    expect(recordCurrency({ price_currency: 'USD', currency: '$' })).toBeNull();
    expect(recordCurrency({ currency_code: 'SGD', currencyCode: 'AUD' })).toBeNull();
    expect(recordCurrency({ price_currency: '', currency: null, priceCurrency: 'GBP' })).toBe('GBP');
    expect(recordCurrency({})).toBeNull();
    expect(recordCurrency(null)).toBeNull();
  });
});

describe('readPriceWithCurrency: the amount and its currency come from one record', () => {
  test('first non-null field wins, as `??` does, and its holder names the currency', () => {
    const row = { price: null, price_amount: 1200, price_currency: 'JPY' };
    const other = { price: 9, currency: 'USD' };
    expect(readPriceWithCurrency([[row, 'price'], [row, 'price_amount'], [other, 'price']], toNumber))
      .toEqual({ amount: 1200, currency: 'JPY' });
  });

  test('an amount never borrows a currency from a later field\'s holder', () => {
    const row = { price_amount: 20 };
    const product = { price: 20, currency: 'USD' };
    expect(readPriceWithCurrency([[row, 'price_amount'], [product, 'price']], toNumber))
      .toEqual({ amount: 20, currency: null });
  });

  test('an empty string stops the chain as `??` does (amount null, currency null)', () => {
    const row = { price: '', price_currency: 'USD' };
    const later = { price: 5, currency: 'USD' };
    expect(readPriceWithCurrency([[row, 'price'], [later, 'price']], toNumber)).toEqual({ amount: null, currency: null });
  });

  test('no amount, no currency', () => {
    expect(readPriceWithCurrency([[{ price_currency: 'USD' }, 'price']], toNumber)).toEqual({ amount: null, currency: null });
    expect(readPriceWithCurrency([[{ price: 'n/a', price_currency: 'USD' }, 'price']], toNumber)).toEqual({ amount: null, currency: null });
  });

  test('spread layers are read from the layer the spread takes the key from', () => {
    const seed = { price: 10, currency: 'USD' };
    const data = { price: 1500 };
    const snap = { title: 'x', currency: 'EUR' };
    // { ...seed, ...data, ...snap }.price is data's 1500; data names no currency.
    expect(readPriceWithCurrency([[[seed, data, snap], 'price']], toNumber)).toEqual({ amount: 1500, currency: null });
    // A later layer's own null shadows an earlier amount, exactly as the spread does.
    expect(readPriceWithCurrency([[[seed, { price: null }], 'price']], toNumber)).toEqual({ amount: null, currency: null });
    expect(readPriceWithCurrency([[[seed, { title: 'y' }], 'price']], toNumber)).toEqual({ amount: 10, currency: 'USD' });
  });

  test('an object price names its own currency; one that names none takes its holder\'s', () => {
    expect(readPriceWithCurrency([[{ price: { amount: 25, currency_code: 'EUR' }, currency: 'USD' }, 'price']], toNumber))
      .toEqual({ amount: 25, currency: 'EUR' });
    expect(readPriceWithCurrency([[{ price: { amount: 25 }, currency: 'USD' }, 'price']], toNumber))
      .toEqual({ amount: 25, currency: 'USD' });
    expect(readPriceWithCurrency([[{ price: { amount: { value: 7, currency: 'GBP' }, currency: 'USD' } }, 'price']], toNumber))
      .toEqual({ amount: 7, currency: 'GBP' });
    // An empty currency key names nothing, so the holder's currency still applies.
    expect(readPriceWithCurrency([[{ price: { amount: 25, currency: '' }, currency: 'USD' }, 'price']], toNumber))
      .toEqual({ amount: 25, currency: 'USD' });
    // An object price that names two currencies is ambiguous; it does not fall back to its holder.
    expect(readPriceWithCurrency([[{ price: { amount: 25, currency: 'USD', currency_code: 'JPY' }, currency: 'USD' }, 'price']], toNumber))
      .toEqual({ amount: 25, currency: null });
  });

  test('a non-object holder is skipped', () => {
    expect(readPriceWithCurrency([[null, 'price'], ['x', 'price'], [{ price: 3, currency: 'AUD' }, 'price']], toNumber))
      .toEqual({ amount: 3, currency: 'AUD' });
    expect(readPriceWithCurrency(undefined, toNumber)).toEqual({ amount: null, currency: null });
  });
});

describe('comparablePriceRatio', () => {
  test('same known currency -> candidate / anchor', () => {
    expect(comparablePriceRatio({ amount: 40, currency: 'USD' }, { amount: 10, currency: 'USD' })).toBe(0.25);
  });

  test('refused across currencies, with either currency unknown, or without a positive anchor', () => {
    expect(comparablePriceRatio({ amount: 40, currency: 'USD' }, { amount: 1000, currency: 'JPY' })).toBeNull();
    expect(comparablePriceRatio({ amount: 40, currency: null }, { amount: 10, currency: null })).toBeNull();
    expect(comparablePriceRatio({ amount: 40, currency: 'USD' }, { amount: 10, currency: null })).toBeNull();
    expect(comparablePriceRatio({ amount: 40, currency: null }, { amount: 10, currency: 'USD' })).toBeNull();
    expect(comparablePriceRatio({ amount: 0, currency: 'USD' }, { amount: 10, currency: 'USD' })).toBeNull();
    expect(comparablePriceRatio({ amount: null, currency: 'USD' }, { amount: 10, currency: 'USD' })).toBeNull();
    expect(comparablePriceRatio({ amount: 40, currency: 'USD' }, { amount: null, currency: 'USD' })).toBeNull();
    expect(comparablePriceRatio(null, undefined)).toBeNull();
  });

  test('a free candidate against a priced anchor is a ratio of 0', () => {
    expect(comparablePriceRatio({ amount: 40, currency: 'USD' }, { amount: 0, currency: 'USD' })).toBe(0);
  });
});

describe('sources: the snapshot keeps price_currency beside price', () => {
  test('an external_product_seeds row keeps eps.price_currency', () => {
    const out = normalizeExternalProductSeedRow({
      id: 'eps_1', external_product_id: 'ext_1', title: 'Night Cream', market: 'US',
      price_amount: '4400', price_currency: 'jpy', seed_data: { brand: 'Twany', category: 'cream' },
    });
    expect(out.price).toBe(4400);
    expect(out.price_currency).toBe('JPY');
  });

  test('no currency is defaulted in: not from the market, not from "$"', () => {
    const out = normalizeExternalProductSeedRow({
      id: 'eps_2', external_product_id: 'ext_2', title: 'Night Cream', market: 'US', price_amount: 44,
      seed_data: { brand: 'X', category: 'cream' },
    });
    expect(out.price).toBe(44);
    expect(out.price_currency).toBeNull();
    const dollar = normalizeProductsCacheRow({ product_ref: 'p1', product_data: { title: 'Serum', brand: 'X', price: '$12.00', currency: '$' } });
    expect(dollar.price).toBe(12);
    expect(dollar.price_currency).toBeNull();
  });

  test('price_currency is always present (null when unknown), even with no price', () => {
    const out = normalizeProductCandidateSnapshot({ product_ref: 'product:a', brand: 'X', name: 'Serum' });
    expect(out).toHaveProperty('price', null);
    expect(out).toHaveProperty('price_currency', null);
  });

  test('a products_cache payload carries its own currency, flat or in a price object', () => {
    expect(normalizeProductsCacheRow({ product_ref: 'p1', product_data: { title: 'Serum', brand: 'X', price: 18, currency: 'usd' } }))
      .toMatchObject({ price: 18, price_currency: 'USD' });
    expect(normalizeProductsCacheRow({ product_ref: 'p2', product_data: { title: 'Serum', brand: 'X', price: { amount: 21, currency_code: 'EUR' } } }))
      .toMatchObject({ price: 21, price_currency: 'EUR' });
  });

  test('a row-level amount never takes a nested payload\'s currency', () => {
    const out = normalizeProductCandidateSnapshot({
      product_ref: 'product:a', name: 'Serum', brand: 'X', price_amount: 20, product_data: { currency: 'USD' },
    });
    expect(out.price).toBe(20);
    expect(out.price_currency).toBeNull();
  });

  test('merged seed_data / product_data / snapshot layers: the amount\'s own layer names the currency', () => {
    const borrowed = normalizeProductCandidateSnapshot({
      product_ref: 'product:a', name: 'Serum', brand: 'X',
      seed_data: { currency: 'USD' },
      product_data: { price: 1500 },
    });
    expect(borrowed.price).toBe(1500);
    expect(borrowed.price_currency).toBeNull();

    const own = normalizeProductCandidateSnapshot({
      product_ref: 'product:a', name: 'Serum', brand: 'X',
      seed_data: { price: 10, currency: 'USD' },
      product_data: { price: 1500, currency: 'JPY' },
    });
    expect(own).toMatchObject({ price: 1500, price_currency: 'JPY' });

    const snapshotWins = normalizeProductCandidateSnapshot({
      product_ref: 'product:a', name: 'Serum', brand: 'X',
      product_data: { price: 1500, currency: 'JPY', snapshot: { price: 11, price_currency: 'SGD' } },
    });
    expect(snapshotWins).toMatchObject({ price: 11, price_currency: 'SGD' });
  });

  test('a first variant\'s price takes the variant\'s currency, not the product\'s', () => {
    const out = normalizeProductCandidateSnapshot({
      product_ref: 'product:a', name: 'Serum', brand: 'X',
      product_data: { currency: 'USD', variants: [{ price: '30.00' }] },
    });
    expect(out).toMatchObject({ price: 30, price_currency: null });
    const own = normalizeProductCandidateSnapshot({
      product_ref: 'product:a', name: 'Serum', brand: 'X',
      product_data: { variants: [{ price: '30.00', price_currency: 'CAD' }] },
    });
    expect(own).toMatchObject({ price: 30, price_currency: 'CAD' });
  });

  test('approved-live seed anchors keep the seed\'s currency over the catalog payload\'s', () => {
    const out = normalizeApprovedLiveExternalSeedRow({
      id: 'eps_3', external_product_id: 'ext_3', title: 'Cream', price_amount: 52, price_currency: 'AUD',
      catalog_title: 'Cream', catalog_brand: 'Sukin', catalog_product_key: 'ck_1',
      product_payload: { price: 34, currency: 'USD' },
    });
    expect(out).toMatchObject({ price: 52, price_currency: 'AUD' });
  });

  test('a catalog row reads price and currency from its payload together', () => {
    const out = normalizeCatalogProductRow({
      product_key: 'ck_1', title: 'Cream', brand: 'X', product_payload: { price: 34, currency: 'USD' },
    });
    expect(out).toMatchObject({ price: 34, price_currency: 'USD' });
  });

  test('re-normalizing a normalized snapshot is stable', () => {
    const once = normalizeExternalProductSeedRow({
      id: 'eps_4', external_product_id: 'ext_4', title: 'Cream', price_amount: 12, price_currency: 'GBP', seed_data: { brand: 'X' },
    });
    const twice = normalizeProductCandidateSnapshot(once);
    expect(twice).toMatchObject({ price: 12, price_currency: 'GBP' });
  });
});

describe('sources scoring and ranking compare prices only within one currency', () => {
  const anchor = (price, currency) => normalizeProductCandidateSnapshot(
    { product_ref: 'product:anchor', brand: 'A', name: 'Barrier Cream', category: 'moisturizer', price, price_currency: currency },
    { sourceType: 'catalog_products' },
  );
  const candidate = (ref, price, currency) => normalizeProductCandidateSnapshot(
    { product_ref: ref, brand: 'B', name: 'Barrier Cream', category: 'moisturizer', price, price_currency: currency },
    { sourceType: 'catalog_products' },
  );

  test('price_advantage needs one known currency', () => {
    expect(scoreCandidateForAnchor(anchor(40, 'USD'), candidate('product:c', 10, 'USD')).price_advantage).toBe(0.75);
    expect(scoreCandidateForAnchor(anchor(40, 'USD'), candidate('product:c', 1000, 'JPY')).price_advantage).toBe(0);
    expect(scoreCandidateForAnchor(anchor(4000, 'JPY'), candidate('product:c', 10, 'USD')).price_advantage).toBe(0);
    expect(scoreCandidateForAnchor(anchor(40, null), candidate('product:c', 10, null)).price_advantage).toBe(0);
  });

  test('availability_confidence still credits a known amount whatever its currency', () => {
    const priced = scoreCandidateForAnchor(anchor(40, 'USD'), candidate('product:c', 1000, 'JPY'));
    const unpriced = scoreCandidateForAnchor(anchor(40, 'USD'), candidate('product:c', null, null));
    expect(priced.availability_confidence).toBeGreaterThan(unpriced.availability_confidence);
  });

  test('the cheaper-first tiebreak applies only within one known currency', () => {
    const tie = { similarity_score: 0.8, category_use_case_match: 0.7, evidence_grade: 'B' };
    const cheapZ = { ...tie, product_ref: 'product:z', price: 5, price_currency: 'USD' };
    const dearA = { ...tie, product_ref: 'product:a', price: 50, price_currency: 'USD' };
    expect(compareScoredCandidates(cheapZ, dearA)).toBeLessThan(0);
    expect(compareScoredCandidates(dearA, cheapZ)).toBeGreaterThan(0);

    const yenZ = { ...tie, product_ref: 'product:z', price: 5, price_currency: 'JPY' };
    expect(compareScoredCandidates(yenZ, dearA)).toBeGreaterThan(0); // falls through to ref order
    expect(compareScoredCandidates(dearA, yenZ)).toBeLessThan(0);

    const bareZ = { ...tie, product_ref: 'product:z', price: 5, price_currency: null };
    const bareA = { ...tie, product_ref: 'product:a', price: 50, price_currency: null };
    expect(compareScoredCandidates(bareZ, bareA)).toBeGreaterThan(0);

    const freeZ = { ...tie, product_ref: 'product:z', price: 0, price_currency: 'USD' };
    expect(compareScoredCandidates(freeZ, dearA)).toBeLessThan(0);
    expect(compareScoredCandidates(dearA, freeZ)).toBeGreaterThan(0);
  });
});

describe('builder: price_evidence carries each side\'s currency and refuses a cross-currency ratio', () => {
  // A pair that is a dupe when the prices compare (see product_relationship_graph_quality.test.js).
  const anchorBase = {
    product_ref: 'product:anchor_serum', brand: 'Luxe', name: 'Luxe Peptide Barrier Serum',
    category: 'serum', category_taxonomy: ['serum'], tags: ['peptide', 'barrier', 'serum'],
    ingredient_text: 'water, glycerin, palmitoyl tripeptide-1, ceramide np, niacinamide, squalane',
    price: 90,
  };
  const candidateBase = {
    product_ref: 'product:value_serum', brand: 'Value', name: 'Value Peptide Barrier Serum',
    category: 'serum', category_taxonomy: ['serum'], tags: ['peptide', 'barrier', 'serum'],
    ingredient_text: 'water, glycerin, palmitoyl tripeptide-1, ceramide np, niacinamide, squalane',
    price: 30,
    similarity_score: 0.9, category_use_case_match: 0.9, ingredient_functional_similarity: 0.9,
    source_refs: [{ type: 'external_product_seed', authoritative: true }],
    price_observed_at: NOW,
  };
  const build = (anchorCurrency, candidateCurrency, extra = {}) => buildEdgeForCandidate({
    anchor: { ...anchorBase, price_currency: anchorCurrency },
    candidate: { ...candidateBase, price_currency: candidateCurrency, ...extra },
    nowIso: NOW,
  });

  test('one known currency: a dupe with a ratio, both currencies recorded', () => {
    const { edge, errors } = build('USD', 'USD');
    expect(errors).toEqual([]);
    expect(edge.relation_type).toBe('dupe');
    expect(edge.price_evidence).toEqual({
      anchor_price_amount: 90,
      anchor_price_currency: 'USD',
      candidate_price_amount: 30,
      candidate_price_currency: 'USD',
      price_ratio: 30 / 90,
      observed_at: NOW,
    });
    expect(edge.score_breakdown.price_advantage).toBeCloseTo(1 - 30 / 90, 4);
    expect(edge.display_label).toBe('budget_alternative');
  });

  test('two currencies: no ratio, no dupe, no price advantage, and validation does not rebuild one', () => {
    const { edge, errors } = build('USD', 'JPY', { price: 3000 });
    expect(errors).toEqual([]);
    expect(edge.relation_type).toBe('competitive_alternative');
    expect(edge.price_evidence).toMatchObject({
      anchor_price_amount: 90,
      anchor_price_currency: 'USD',
      candidate_price_amount: 3000,
      candidate_price_currency: 'JPY',
      price_ratio: null,
    });
    expect(edge.score_breakdown.price_advantage).toBe(0);
    expect(edge.display_label).toBe('alternative');
    expect(getPriceRatio(edge)).toBeNull();
  });

  test('a cheaper amount in a DIFFERENT currency never becomes a "lower-priced" dupe', () => {
    // 30 < 90 numerically, but 30 GBP vs 90 AUD is not known to be cheaper.
    const { edge } = build('AUD', 'GBP');
    expect(edge.relation_type).toBe('competitive_alternative');
    expect(edge.price_evidence.price_ratio).toBeNull();
  });

  test('one side unknown: no ratio, and the unknown side stays null (never the other side\'s)', () => {
    const { edge } = build('USD', null);
    expect(edge.relation_type).toBe('competitive_alternative');
    expect(edge.price_evidence).toMatchObject({
      anchor_price_currency: 'USD',
      candidate_price_amount: 30,
      candidate_price_currency: null,
      price_ratio: null,
    });
    expect(getPriceRatio(edge)).toBeNull();
    const reverse = build(null, 'USD').edge;
    expect(reverse.price_evidence).toMatchObject({ anchor_price_currency: null, candidate_price_currency: 'USD', price_ratio: null });
  });

  test('both unknown: no ratio (two bare amounts are not known to share a currency)', () => {
    const { edge } = build(null, null);
    expect(edge.relation_type).toBe('competitive_alternative');
    expect(edge.price_evidence).toMatchObject({ anchor_price_currency: null, candidate_price_currency: null, price_ratio: null });
  });

  test('a candidate amount read from the candidate row takes the row\'s currency, not the nested product\'s', () => {
    const { edge } = buildEdgeForCandidate({
      anchor: { ...anchorBase, price_currency: 'USD' },
      candidate: {
        ...candidateBase,
        product: { ...candidateBase, price: undefined, price_currency: 'JPY' },
        price: 30,
        price_currency: 'USD',
      },
      nowIso: NOW,
    });
    expect(edge.price_evidence).toMatchObject({ candidate_price_amount: 30, candidate_price_currency: 'USD', price_ratio: 30 / 90 });
  });

  test('the nested product\'s own price outranks the candidate row\'s, and keeps its own currency', () => {
    const { edge } = buildEdgeForCandidate({
      anchor: { ...anchorBase, price_currency: 'USD' },
      candidate: {
        ...candidateBase,
        product: { ...candidateBase, price: 30, price_currency: 'USD' },
        price: 3000,
        price_currency: 'JPY',
      },
      nowIso: NOW,
    });
    expect(edge.price_evidence).toMatchObject({ candidate_price_amount: 30, candidate_price_currency: 'USD', price_ratio: 30 / 90 });
  });

  test('price_amount on the snapshot carries its record\'s currency like price does', () => {
    const { edge } = buildEdgeForCandidate({
      anchor: { ...anchorBase, price: undefined, price_amount: 90, price_currency: 'USD' },
      candidate: { ...candidateBase, price: undefined, price_amount: 30, price_currency: 'USD' },
      nowIso: NOW,
    });
    expect(edge.relation_type).toBe('dupe');
    expect(edge.price_evidence).toMatchObject({ anchor_price_amount: 90, candidate_price_amount: 30, price_ratio: 30 / 90 });
  });

  test('niche_specialist evidence records the candidate\'s currency', () => {
    const need = CURATED_NEED_NODES.find((item) => /budget-peptide-serum/.test(item.need_id));
    const { edge, errors } = buildNicheSpecialistEdge({
      need,
      candidate: { ...candidateBase, name: 'Value Peptide Serum', price: 18, price_currency: 'usd' },
      nowIso: NOW,
    });
    expect(errors).toEqual([]);
    expect(edge.price_evidence).toEqual({ candidate_price_amount: 18, candidate_price_currency: 'USD', observed_at: NOW });
    const bare = buildNicheSpecialistEdge({ need, candidate: { ...candidateBase, name: 'Value Peptide Serum', price: 18 }, nowIso: NOW }).edge;
    expect(bare.price_evidence).toEqual({ candidate_price_amount: 18, candidate_price_currency: null, observed_at: NOW });
  });
});

describe('validation: a ratio across currencies compares nothing', () => {
  const base = {
    anchor_ref: 'product:a', candidate_product_ref: 'product:b', relation_type: 'dupe',
    category_taxonomy: ['serum'], use_case: 'serum', review_status: 'pending',
    source_refs: [{ type: 'catalog_products', authoritative: true }],
    score_total: 0.9, score_breakdown: { category_use_case_match: 0.8, score_total: 0.9 },
    why_candidate: { summary: 'Similar serum.' },
  };
  const validate = (edge) => validateRelationshipEdge(edge, { nowMs: Date.parse(NOW) });

  test('legacy evidence (no currency keys) still rebuilds its ratio from the amounts', () => {
    const edge = { ...base, price_evidence: { anchor_price_amount: 40, candidate_price_amount: 10, observed_at: NOW } };
    expect(getPriceRatio(edge)).toBe(0.25);
    expect(validate(edge).errors).not.toContain('dupe_price_ratio_missing');
    expect(coerceRelationshipEdge(edge).display_label).toBe('budget_alternative');
  });

  test('legacy evidence whose snapshots name two currencies has no ratio, explicit or rebuilt', () => {
    const snapshots = { anchor_snapshot: { price: 40, price_currency: 'USD' }, candidate_snapshot: { price: 1000, currency: 'JPY' } };
    const rebuilt = { ...base, ...snapshots, price_evidence: { anchor_price_amount: 40, candidate_price_amount: 1000 } };
    const explicit = { ...base, ...snapshots, price_evidence: { anchor_price_amount: 40, candidate_price_amount: 10, price_ratio: 0.25 } };
    expect(getPriceRatio(rebuilt)).toBeNull();
    expect(getPriceRatio(explicit)).toBeNull();
    expect(validate(explicit).errors).toContain('dupe_price_ratio_missing');
    expect(coerceRelationshipEdge({ ...explicit, relation_type: 'competitive_alternative' }).display_label).toBe('alternative');
  });

  test('legacy evidence with one-sided or bare snapshot currencies keeps its ratio', () => {
    const oneSided = { ...base, anchor_snapshot: { price: 40, price_currency: 'USD' }, candidate_snapshot: { price: 10 }, price_evidence: { anchor_price_amount: 40, candidate_price_amount: 10 } };
    expect(getPriceRatio(oneSided)).toBe(0.25);
    const same = { ...base, anchor_snapshot: { price: 40, price_currency: 'USD' }, candidate_snapshot: { price: 10, price_currency: 'usd' }, price_evidence: { price_ratio: 0.25 } };
    expect(getPriceRatio(same)).toBe(0.25);
  });

  test('currency-aware evidence with a null ratio is a refused ratio: never rebuilt', () => {
    for (const key of ['anchor_price_currency', 'candidate_price_currency', 'anchorPriceCurrency', 'candidatePriceCurrency']) {
      const edge = { ...base, price_evidence: { anchor_price_amount: 40, candidate_price_amount: 10, price_ratio: null, [key]: null } };
      expect(getPriceRatio(edge)).toBeNull();
      expect(validate(edge).errors).toContain('dupe_price_ratio_missing');
    }
  });

  test('currency-aware evidence naming two currencies refuses even an explicit ratio', () => {
    const edge = {
      ...base,
      price_evidence: { anchor_price_amount: 40, anchor_price_currency: 'USD', candidate_price_amount: 10, candidate_price_currency: 'JPY', price_ratio: 0.25 },
    };
    expect(getPriceRatio(edge)).toBeNull();
    const camel = { ...base, price_evidence: { anchorPriceCurrency: 'USD', candidatePriceCurrency: 'JPY', priceRatio: 0.25 } };
    expect(getPriceRatio(camel)).toBeNull();
  });

  test('currency-aware evidence in one currency keeps its explicit ratio', () => {
    const edge = {
      ...base,
      price_evidence: { anchor_price_amount: 40, anchor_price_currency: 'USD', candidate_price_amount: 10, candidate_price_currency: 'USD', price_ratio: 0.25 },
    };
    expect(getPriceRatio(edge)).toBe(0.25);
    expect(validate(edge).errors).not.toContain('dupe_price_ratio_missing');
  });

  test('the evidence currency outranks a snapshot currency only by agreeing with it or filling a gap', () => {
    // Evidence names USD for the anchor, the candidate snapshot names JPY: two currencies.
    const edge = {
      ...base,
      candidate_snapshot: { price: 1000, price_currency: 'JPY' },
      price_evidence: { anchor_price_currency: 'USD', candidate_price_currency: null, price_ratio: 0.25 },
    };
    expect(getPriceRatio(edge)).toBeNull();
  });
});
