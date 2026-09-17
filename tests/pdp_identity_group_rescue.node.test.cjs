/**
 * A PDP must not report zero offers for a product the catalog holds two sellers for.
 *
 * WHY THIS FILE EXISTS. The signature PDP lane resolves its group through `pdp_identity_listing`
 * only — by `source_listing_ref`, then by that row's `sellable_item_group_id`. Nothing in it is
 * keyed on the `content_key` the catalog actually converged the listings on. When that table has
 * no approved live row, the members come back empty, `catalogIdentity.sellable_item_group_id` has
 * already defaulted to the request's OWN signature, and the blocked arm reports
 * `offers_count: 0`, `product_group_id: <its own sig>`.
 *
 * Measured in prod 2026-09-17 on the Pyunkang Yul two-retailer canary: `get_offers` returned both
 * sellers ($14.50 eyurs, $19.99 ohlolly) while `get_product` on either listing said zero offers.
 * The whole blocked branch — `multi_offer_blocked` / `identity_group_members_missing` — had no
 * test anywhere in the repo, which is how a serving answer this wrong stayed put.
 *
 * `resolveMissingIdentityGroupMembers` is the seam. `resolveGroup` is the ONLY way it reaches a
 * database, so every rule below is a decision under test rather than a query that happened to
 * return nothing.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');

const { resolveMissingIdentityGroupMembers } = app._debug;

const EYURS = { merchant_id: 'merch_obs_8c4e7afb1bf09b9a', product_id: 'retailer:1aed0be4' };
const OHLOLLY = { merchant_id: 'merch_obs_c43a84f5b02f2dba', product_id: 'retailer:6ea79af5' };

function catalogGroup(overrides = {}) {
  return {
    status: 'ok',
    source: 'canonical_catalog',
    canonical_entity_id: 'pg_5dc9474321d1d597668670aebfd7543a',
    sellable_item_group_id: 'sig_b97a3180c7c8868edd3bd2417f8def27',
    content_key: 'ck_5dc9474321d1d597668670aebfd7543a',
    members: [EYURS, OHLOLLY],
    offer_count: 4,
    ...overrides,
  };
}

function resolverReturning(group, calls = []) {
  return async (args) => {
    calls.push(args);
    return group;
  };
}

const BASE = Object.freeze({
  enabled: true,
  groupMembers: [],
  productId: 'retailer:6ea79af5',
  merchantId: 'merch_obs_c43a84f5b02f2dba',
});

test('a listing whose identity lane found no members is rescued from the catalog group', async () => {
  const calls = [];
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: resolverReturning(catalogGroup(), calls),
  });

  assert.deepEqual(calls, [{ productId: 'retailer:6ea79af5', merchantId: 'merch_obs_c43a84f5b02f2dba' }]);
  assert.equal(rescued.group_id, 'pg_5dc9474321d1d597668670aebfd7543a', 'the SHARED id, not the request sig');
  assert.deepEqual(rescued.members, [EYURS, OHLOLLY]);
  assert.equal(rescued.content_key, 'ck_5dc9474321d1d597668670aebfd7543a');
  assert.equal(rescued.offer_count, 4);
});

test('the group id falls back to the elected canonical signature, then the product group', async () => {
  const noEntityId = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: resolverReturning(catalogGroup({ canonical_entity_id: '' })),
  });
  assert.equal(noEntityId.group_id, 'sig_b97a3180c7c8868edd3bd2417f8def27');

  const onlyProductGroup = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: resolverReturning(
      catalogGroup({ canonical_entity_id: null, sellable_item_group_id: null, product_group_id: 'pg_fallback' }),
    ),
  });
  assert.equal(onlyProductGroup.group_id, 'pg_fallback');
});

test('a group with no id at all is not a rescue', async () => {
  // Reporting members under no shared id would tell the caller nothing it did not already hold.
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: resolverReturning(
      catalogGroup({ canonical_entity_id: '  ', sellable_item_group_id: null, product_group_id: '' }),
    ),
  });
  assert.equal(rescued, null);
});

test('a group of ONE is refused, and the query still only ran once', async () => {
  // One member is the listing itself. That is the case the blocked/self decision already covers,
  // and rescuing it would change every solo seed listing's answer on the strength of a query that
  // found nothing new.
  const calls = [];
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY] }), calls),
  });

  assert.equal(rescued, null);
  assert.equal(calls.length, 1);
});

test('members already in hand are never re-resolved', async () => {
  let called = false;
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    groupMembers: [EYURS, OHLOLLY],
    resolveGroup: async () => {
      called = true;
      return catalogGroup();
    },
  });

  assert.equal(rescued, null);
  assert.equal(called, false, 'the identity lane already answered; this must cost nothing');
});

test('a lane this rescue does not apply to costs no query', async () => {
  // `enabled` carries both gates from the call site: a signature request AND a seed-routed ref.
  let called = false;
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    enabled: false,
    resolveGroup: async () => {
      called = true;
      return catalogGroup();
    },
  });

  assert.equal(rescued, null);
  assert.equal(called, false);
});

test('a missing product id cannot be looked up', async () => {
  let called = false;
  for (const productId of [undefined, '', '   ']) {
    const rescued = await resolveMissingIdentityGroupMembers({
      ...BASE,
      productId,
      resolveGroup: async () => {
        called = true;
        return catalogGroup();
      },
    });
    assert.equal(rescued, null);
  }
  assert.equal(called, false);
});

test('a resolver that fails leaves the identity-listing answer standing', async () => {
  // The call site catches and returns null; a rescue that throws must not take the PDP with it.
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: async () => null,
  });
  assert.equal(rescued, null);
});

test('a malformed group is refused rather than half-read', async () => {
  for (const group of [undefined, null, {}, { members: null }, { members: 'two' }, { members: [EYURS] }]) {
    const rescued = await resolveMissingIdentityGroupMembers({
      ...BASE,
      resolveGroup: resolverReturning(group),
    });
    assert.equal(rescued, null, JSON.stringify(group));
  }
});

test('a non-numeric offer_count is reported as unknown, never as zero', async () => {
  // `offer_count: 0` from this path would be indistinguishable from the blocked answer this whole
  // change exists to remove.
  const rescued = await resolveMissingIdentityGroupMembers({
    ...BASE,
    resolveGroup: resolverReturning(catalogGroup({ offer_count: undefined })),
  });
  assert.equal(rescued.offer_count, null);
  assert.deepEqual(rescued.members.length, 2);
});

test('the merchant id is passed through, and blank becomes null', async () => {
  const calls = [];
  await resolveMissingIdentityGroupMembers({
    ...BASE,
    merchantId: '   ',
    resolveGroup: resolverReturning(catalogGroup(), calls),
  });
  assert.equal(calls[0].merchantId, null);
});
