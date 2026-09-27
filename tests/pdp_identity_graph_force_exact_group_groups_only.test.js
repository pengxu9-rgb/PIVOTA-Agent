'use strict';

// force_exact_group is a GROUPING override. The identity graph is the one place it acts: it moves the listing into the
// target sellable_item_group_id, which is what sibling offers and the PDP's offer set read. Since catalogTrustPolicy
// c1.v0.9 (2026-09-27) the trust policy no longer also reads it as identity approval, so these tests pin the half that
// must survive: the group moves, and nothing about the listing's identity does.

const { _internals: { applyIdentityOverrides } } = require('../src/services/pdpIdentityGraph');

const listing = (extra = {}) => ({
  source_listing_ref: 'merch_obs_0e4ea7ad6e6d9e43:ulta:a850e4af60cbb33b',
  sellable_item_group_id: 'sig_own',
  product_line_id: 'pl_own',
  review_family_id: 'rf_own',
  identity_status: 'review_required',
  review_required: true,
  live_read_enabled: false,
  review_reason_codes: ['conflicting_gtin'],
  identity_confidence: 0.54,
  ...extra,
});
const feg = (payload = {}, extra = {}) => ({
  source_listing_ref: 'merch_obs_0e4ea7ad6e6d9e43:ulta:a850e4af60cbb33b',
  action_type: 'force_exact_group',
  active: true,
  payload: { target_sellable_item_group_id: 'sig_canonical', ...payload },
  ...extra,
});

describe('force_exact_group groups, and only groups', () => {
  test('it moves the listing into the target group', () => {
    expect(applyIdentityOverrides(listing(), [feg()]).sellable_item_group_id).toBe('sig_canonical');
  });

  test('it leaves identity status, review flags, live read and confidence exactly as they were', () => {
    const before = listing();
    const after = applyIdentityOverrides(before, [feg()]);
    for (const k of ['identity_status', 'review_required', 'live_read_enabled', 'review_reason_codes', 'identity_confidence',
      'product_line_id', 'review_family_id']) {
      expect([k, after[k]]).toEqual([k, before[k]]);
    }
  });

  test('an approved listing stays approved and keeps its own live read', () => {
    const after = applyIdentityOverrides(listing({ identity_status: 'approved', review_required: false, live_read_enabled: true }), [feg()]);
    expect(after).toEqual(expect.objectContaining({ identity_status: 'approved', live_read_enabled: true, sellable_item_group_id: 'sig_canonical' }));
  });

  test('an override addressed to another listing, or without a target group, changes nothing', () => {
    expect(applyIdentityOverrides(listing(), [feg({}, { source_listing_ref: 'merch_x:other' })])).toEqual(listing());
    expect(applyIdentityOverrides(listing(), [feg({ target_sellable_item_group_id: '' })])).toEqual(listing());
  });

  test('the override is not mutated into the listing object in place', () => {
    const before = listing();
    applyIdentityOverrides(before, [feg()]);
    expect(before.sellable_item_group_id).toBe('sig_own');
  });
});
