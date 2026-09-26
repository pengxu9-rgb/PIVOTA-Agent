'use strict';

// scripts/repairRetailerOfficialDomain.cjs: the #1785 repair of listings whose official_domain is a retailer
// host. Prod dry run (2026-09-26): 428 rows, 210 approved -> review_required, 7 review_required -> approved.
// These tests drive the REAL rebuild (buildIdentityListingFromProduct) and pin the safety rules added before
// anyone runs --apply: active overrides are honoured, promotions are held unless allowed, the serving-impact
// report counts only demotions that change serving, and the trust refresh follows every write.

const {
  parseArgs, planRow, servingImpact, summarize, run,
} = require('../scripts/repairRetailerOfficialDomain.cjs');
const { buildIdentityListingFromProduct } = require('../src/services/pdpIdentityGraph');

const ULTA = 'https://www.ulta.com/p/niacinamide-pimprod2007111';
function product(extra = {}) {
  return { product_id: 'p1', title: 'Niacinamide 10% + Zinc 1% Serum', brand: 'The Ordinary', canonical_url: ULTA, ...extra };
}
function rebuild(p) {
  return buildIdentityListingFromProduct({ merchantId: 'external_seed', productId: p.product_id, product: p, sourceKind: 'external_seed' });
}
// A stored row as the poisoned pipeline wrote it: approved by official_url_route on the Ulta page.
function storedRow(extra = {}) {
  return {
    source_listing_ref: 'external_seed:p1', merchant_id: 'external_seed', product_id: 'p1', source_kind: 'external_seed',
    brand_norm: 'the ordinary', official_domain: 'ulta.com', matched_by_rule: 'official_url_route',
    match_basis: [`official_url:${ULTA}`], identity_status: 'approved', identity_confidence: 0.74,
    review_required: false, review_reason_codes: [], source_payload: product(), ...extra,
  };
}

describe('planRow (the real rebuild)', () => {
  test('a listing approved only by the retailer URL is demoted, and the brand domain is re-derived', () => {
    const plan = planRow({ row: storedRow(), rebuilt: rebuild(product()),
      brandDomain: new Map([['the ordinary', { domain: 'theordinary.com', siblings: 67 }]]) });
    expect(plan.kind).toBe('update');
    expect(plan.transition).toEqual({ from: 'approved', to: 'review_required' });
    expect(plan.fields.matched_by_rule).toBe('singleton_source_ref');
    expect(plan.fields.identity_confidence).toBe(0.54);
    expect(plan.fields.official_domain).toBe('theordinary.com');
    expect(plan.fields.official_url).toBeNull();
    expect(plan.rederived_siblings).toBe(67);
  });

  test('without a dominant brand domain, official_domain becomes NULL (no guessing)', () => {
    expect(planRow({ row: storedRow(), rebuilt: rebuild(product()) }).fields.official_domain).toBeNull();
  });

  test('a review_required -> approved promotion is HELD unless explicitly allowed', () => {
    const row = storedRow({ identity_status: 'review_required', review_required: true,
      review_reason_codes: ['conflicting_gtin'], source_payload: product({ gtin: '00769915190311' }) });
    const rebuilt = rebuild(row.source_payload);
    expect(rebuilt.identity_status).toBe('approved'); // fixture check: the rebuild would promote
    const held = planRow({ row, rebuilt });
    expect(held.kind).toBe('hold');
    const allowed = planRow({ row, rebuilt, allowPromotions: true });
    expect(allowed.kind).toBe('update');
    expect(allowed.promotion).toBe(true);
    expect(allowed.fields.identity_status).toBe('approved');
  });

  test('an active force_review_required override wins over the rebuild', () => {
    const row = storedRow({ identity_status: 'review_required', review_required: true,
      source_payload: product({ gtin: '00769915190311' }) });
    const override = { source_listing_ref: 'external_seed:p1', action_type: 'force_review_required', payload: { reason_codes: ['manual_hold'] } };
    const plan = planRow({ row, rebuilt: rebuild(row.source_payload), overrides: [override], allowPromotions: true });
    expect(plan.kind).toBe('update');
    expect(plan.promotion).toBe(false);
    expect(plan.fields.identity_status).toBe('review_required');
    expect(plan.fields.review_required).toBe(true);
    expect(plan.fields.review_reason_codes).toContain('manual_hold');
    expect(plan.overrides).toEqual(['force_review_required']);
  });

  test('an override addressed through payload.source_listing_ref applies too; another row\'s does not', () => {
    const row = storedRow({ source_payload: product({ gtin: '00769915190311' }) });
    const rebuilt = rebuild(row.source_payload);
    const viaPayload = { action_type: 'force_review_required', payload: { source_listing_ref: 'external_seed:p1' } };
    const other = { source_listing_ref: 'external_seed:other', action_type: 'force_review_required', payload: {} };
    expect(planRow({ row, rebuilt, overrides: [viaPayload] }).fields.identity_status).toBe('review_required');
    expect(planRow({ row, rebuilt, overrides: [other] }).fields.identity_status).toBe('approved');
  });

  test('a reviewed_multi_offer_merge row keeps its reviewed decision and its confidence', () => {
    const row = storedRow({ matched_by_rule: 'reviewed_multi_offer_merge', match_basis: ['reviewed'], identity_confidence: 0.9 });
    const plan = planRow({ row, rebuilt: rebuild(product()) });
    expect(plan.fields.matched_by_rule).toBe('reviewed_multi_offer_merge');
    expect(plan.fields.identity_status).toBe('approved');
    expect(plan.fields.identity_confidence).toBe(0.9);
    expect(plan.fields.official_domain).toBeNull(); // the domain is still corrected
  });

  test('no retailer domain survives in strong/soft identity', () => {
    const plan = planRow({ row: storedRow(), rebuilt: rebuild(product()) });
    expect(JSON.stringify(plan.fields.strong_identity)).not.toContain('ulta');
    expect(JSON.stringify(plan.fields.soft_identity)).not.toContain('ulta');
  });
});

describe('servingImpact / summarize', () => {
  test('only trust-public or live-read rows count as serving changes', () => {
    expect(servingImpact([{ live_read_enabled: false, serving_decision: 'shadow', merchant_id: 'external_seed' }]).serving_changes).toBe(false);
    expect(servingImpact([{ live_read_enabled: true, serving_decision: 'shadow' }]).serving_changes).toBe(true);
    expect(servingImpact([{ live_read_enabled: false, serving_decision: 'public' }]).serving_changes).toBe(true);
    expect(servingImpact([]).serving_changes).toBe(false); // no catalog row, not live: nothing served
  });

  test('the observed-seller exemption is merch_obs_ unless the seed is explicitly cross', () => {
    expect(servingImpact([{ merchant_id: 'merch_obs_tula', seed_kind: 'self' }]).observed_seller_exempt).toBe(true);
    expect(servingImpact([{ merchant_id: 'merch_obs_tula', seed_kind: null }]).observed_seller_exempt).toBe(true);
    expect(servingImpact([{ merchant_id: 'merch_obs_tula', seed_kind: 'cross' }]).observed_seller_exempt).toBe(false);
    expect(servingImpact([{ merchant_id: 'external_seed', seed_kind: 'self' }]).observed_seller_exempt).toBe(false);
  });

  test('the report breaks demotions down by brand x live_read x exemption and lists promotions', () => {
    const d1 = planRow({ row: storedRow({ source_listing_ref: 'external_seed:p1' }), rebuilt: rebuild(product()) });
    const d2 = { ...d1, ref: 'external_seed:p2' };
    const promo = planRow({ row: storedRow({ identity_status: 'review_required', review_reason_codes: ['conflicting_gtin'],
      source_payload: product({ gtin: '00769915190311' }) }), rebuilt: rebuild(product({ gtin: '00769915190311' })) });
    const serving = new Map([
      ['external_seed:p1', [{ live_read_enabled: true, serving_decision: 'public', merchant_id: 'external_seed', product_key: 'k1' }]],
      ['external_seed:p2', [{ live_read_enabled: false, serving_decision: 'shadow', merchant_id: 'external_seed', product_key: 'k2' }]],
    ]);
    const r = summarize([d1, d2, promo], serving);
    expect(r.demotions).toBe(2);
    expect(r.demotions_changing_serving).toBe(1);
    expect(r.demotion_table).toEqual(expect.arrayContaining([
      expect.objectContaining({ brand: 'the ordinary', live_read: true, demoted: 1, serving_changes: 1, trust_public: 1 }),
      expect.objectContaining({ brand: 'the ordinary', live_read: false, demoted: 1, serving_changes: 0 }),
    ]));
    expect(r.promotions).toEqual([expect.objectContaining({ kind: 'hold', previous_review_reason_codes: ['conflicting_gtin'] })]);
  });
});

describe('run (fake client: routes by SQL, records writes)', () => {
  function fakeClient(rows, { serving = [], overrides = [] } = {}) {
    const writes = [];
    return {
      writes,
      query: async (sql, params) => {
        if (/FROM pdp_identity_override/.test(sql)) return { rows: overrides };
        if (/UPDATE pdp_identity_listing/.test(sql)) { writes.push(params); return { rowCount: 1 }; }
        if (/GROUP BY 1, 2/.test(sql)) return { rows: [] };
        if (/crt\.serving_decision/.test(sql)) return { rows: serving };
        if (/count\(\*\) AS n/.test(sql)) return { rows: [{ n: '0' }] };
        if (/SELECT l\.\*/.test(sql)) return { rows };
        throw new Error('unrouted SQL: ' + sql.slice(0, 80));
      },
    };
  }
  const demote = storedRow();
  const promote = storedRow({ source_listing_ref: 'external_seed:p9', product_id: 'p9', identity_status: 'review_required',
    review_required: true, source_payload: product({ product_id: 'p9', gtin: '00769915190311' }) });

  test('parseArgs: trust refresh is on with --apply unless --no-trust-refresh', () => {
    expect(parseArgs([])).toEqual({ apply: false, allowPromotions: false, trustRefresh: false });
    expect(parseArgs(['--apply'])).toEqual({ apply: true, allowPromotions: false, trustRefresh: true });
    expect(parseArgs(['--apply', '--no-trust-refresh']).trustRefresh).toBe(false);
    expect(parseArgs(['--apply', '--allow-promotions']).allowPromotions).toBe(true);
  });

  test('a dry run writes nothing and refreshes nothing', async () => {
    const client = fakeClient([demote, promote]);
    const refreshTrust = jest.fn();
    const out = await run({ client, apply: false, log: () => {}, refreshTrust });
    expect(client.writes).toHaveLength(0);
    expect(refreshTrust).not.toHaveBeenCalled();
    expect(out.held).toBe(1);
  });

  test('--apply writes the demotion only, holds the promotion, and refreshes trust for exactly what it wrote', async () => {
    const client = fakeClient([demote, promote]);
    const refreshTrust = jest.fn(async (_c, refs) => refs.length);
    const out = await run({ client, apply: true, trustRefresh: true, log: () => {}, refreshTrust });
    expect(client.writes.map((w) => w[0])).toEqual(['external_seed:p1']);
    expect(client.writes[0][7]).toBe('review_required');
    expect(refreshTrust).toHaveBeenCalledWith(client, ['external_seed:p1']);
    expect(out).toEqual(expect.objectContaining({ updated: 1, held: 1, touched: ['external_seed:p1'] }));
  });

  test('--no-trust-refresh leaves trust to the cron', async () => {
    const refreshTrust = jest.fn();
    await run({ client: fakeClient([demote]), apply: true, trustRefresh: false, log: () => {}, refreshTrust });
    expect(refreshTrust).not.toHaveBeenCalled();
  });

  test('a missing serving table degrades the report, never the run', async () => {
    const client = fakeClient([demote]);
    const base = client.query;
    client.query = async (sql, params) => { if (/crt\.serving_decision/.test(sql)) throw new Error('relation "catalog_row_trust" does not exist'); return base(sql, params); };
    const lines = [];
    const out = await run({ client, apply: false, log: (l) => lines.push(l) });
    expect(lines.some((l) => /serving impact unavailable/.test(l))).toBe(true);
    expect(out.report.demotions).toBe(1);
  });
});
