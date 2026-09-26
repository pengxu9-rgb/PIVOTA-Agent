/**
 * A PDP must not report zero offers for a product the catalog holds two sellers for — and must not
 * invent sellers on the way to fixing that.
 *
 * WHY THIS FILE EXISTS. The signature PDP lane resolves its group through `pdp_identity_listing`
 * only — by `source_listing_ref`, then by that row's `sellable_item_group_id`. Nothing in it is
 * keyed on the `content_key` the catalog actually converged the listings on. With no approved live
 * identity row, members come back empty, `catalogIdentity.sellable_item_group_id` has already
 * defaulted to the request's OWN signature, and the blocked arm answers `offers_count: 0`.
 * Measured in prod 2026-09-17: `get_offers` returned both sellers of the Pyunkang Yul canary while
 * `get_product` on either listing said zero. That whole branch had no test in the repo.
 *
 * WHAT THE RESCUE MAY CLAIM, and why each rule exists (all prod measurements, 2026-09-17):
 *   - PUBLISHED ONLY: of 348 catalog rows sharing a content_key with another row, 85 are
 *     `published`; 172 are `candidate`, 56 `draft`, 32 `validated`. This lane is not behind the
 *     identity lane's approval gate, so an unfiltered rescue puts a withheld listing on a live PDP.
 *   - TWO DISTINCT SELLERS: 30 content_keys hold 2+ listings from ONE merchant, because
 *     `content_key` carries no merchant component. Counting rows would serve one store twice and
 *     label the PDP `multi_merchant_canonical`.
 *   - THE SIGNATURE, not the source id: a `sig_` takes one equality on a unique index (measured
 *     1.06ms, index scans only); any other shape takes a three-way OR whose `source_product_id`
 *     leg has no leading-column index, the plan this resolver's header records pinning the
 *     instance once already.
 * After both filters, 16 content_keys in prod have two or more published sellers.
 *
 * `resolveGroup` is the ONLY way this function reaches a database, so every rule below is a
 * decision under test rather than a query that happened to return nothing.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');

const { resolveMissingIdentityGroupMembers, resetIdentityGroupRescueCache } = app._debug;

const SIG = 'sig_9905aa12d3d261e632b1363bcd911984';

function member(overrides = {}) {
  return {
    merchant_id: 'merch_obs_c43a84f5b02f2dba',
    product_id: 'retailer:6ea79af5',
    pdp_lifecycle_stage: 'published',
    sync_status: 'live',
    ...overrides,
  };
}

const OHLOLLY = member();
const EYURS = member({ merchant_id: 'merch_obs_8c4e7afb1bf09b9a', product_id: 'retailer:1aed0be4' });

function catalogGroup(overrides = {}) {
  return {
    status: 'ok',
    source: 'canonical_catalog',
    sellable_item_group_id: 'sig_b97a3180c7c8868edd3bd2417f8def27',
    canonical_entity_id: 'pg_5dc9474321d1d597668670aebfd7543a',
    content_key: 'ck_5dc9474321d1d597668670aebfd7543a',
    members: [EYURS, OHLOLLY],
    ...overrides,
  };
}

function resolverReturning(group, calls = []) {
  return async (args) => {
    calls.push(args);
    return group;
  };
}

function baseArgs(overrides = {}) {
  // A distinct cache key per case: the cache is module state, and sharing a key between tests
  // would let one case answer another.
  return {
    enabled: true,
    groupMembers: [],
    signatureId: SIG,
    cacheKey: `case-${Math.random()}`,
    ...overrides,
  };
}

test.beforeEach(() => resetIdentityGroupRescueCache());

test('a listing whose identity lane found no members is rescued from the catalog group', async () => {
  const calls = [];
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup(), calls),
  });

  assert.deepEqual(calls, [{ productId: SIG }], 'the signature, and nothing else, is looked up');
  assert.equal(rescued.group_id, 'sig_b97a3180c7c8868edd3bd2417f8def27');
  assert.deepEqual(rescued.members, [EYURS, OHLOLLY]);
});

test('the group id is the elected signature, matching every other lane that reads this resolver', async () => {
  // Preferring the `pg_` id here would make one product report two different group ids depending
  // on which lane answered, and flip back the moment the identity lane starts answering.
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup()),
  });
  assert.equal(rescued.group_id, 'sig_b97a3180c7c8868edd3bd2417f8def27');
  assert.notEqual(rescued.group_id, 'pg_5dc9474321d1d597668670aebfd7543a');

  const noSig = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup({ sellable_item_group_id: '' })),
  });
  assert.equal(noSig.group_id, 'pg_5dc9474321d1d597668670aebfd7543a', 'then the catalog group');
});

test('two listings from the SAME merchant are one seller, not a rescue', async () => {
  // 30 content_keys in prod hold 2+ listings from one merchant. Serving those as two sellers would
  // show one store twice and label the PDP multi-merchant.
  const twin = member({ product_id: 'retailer:duplicate-row' });
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY, twin] })),
  });
  assert.equal(rescued, null);
});

test('merchant ids differing only by case or spacing are one seller', async () => {
  const shouty = member({ merchant_id: '  MERCH_OBS_C43A84F5B02F2DBA ', product_id: 'retailer:other-row' });
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY, shouty] })),
  });
  assert.equal(rescued, null);
});

test('a sibling that is not published is never served as a seller', async () => {
  for (const stage of ['candidate', 'draft', 'validated', '', undefined]) {
    const withheld = member({ merchant_id: 'merch_obs_withheld', pdp_lifecycle_stage: stage });
    const rescued = await resolveMissingIdentityGroupMembers({
      ...baseArgs(),
      resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY, withheld] })),
    });
    assert.equal(rescued, null, `stage ${String(stage)} must not be served`);
  }
});

test('a withheld sibling is dropped while the published ones are still served', async () => {
  const withheld = member({ merchant_id: 'merch_obs_withheld', pdp_lifecycle_stage: 'draft' });
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup({ members: [EYURS, withheld, OHLOLLY] })),
  });

  assert.deepEqual(
    rescued.members.map((m) => m.merchant_id),
    [EYURS.merchant_id, OHLOLLY.merchant_id],
    'the draft row is not handed to the offers arm either',
  );
});

test('a group of one published seller keeps the existing answer', async () => {
  // One member is the listing itself. That is the case the blocked/self decision already covers.
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY] })),
  });
  assert.equal(rescued, null);
});

test('a group with no usable id is not a rescue', async () => {
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs(),
    resolveGroup: resolverReturning(
      catalogGroup({ sellable_item_group_id: '  ', canonical_entity_id: null, product_group_id: '' }),
    ),
  });
  assert.equal(rescued, null);
});

test('members already in hand are never re-resolved', async () => {
  let called = false;
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ groupMembers: [EYURS, OHLOLLY] }),
    resolveGroup: async () => {
      called = true;
      return catalogGroup();
    },
  });
  assert.equal(rescued, null);
  assert.equal(called, false, 'the identity lane already answered; this must cost nothing');
});

test('a lane this rescue does not apply to costs no query', async () => {
  let called = false;
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ enabled: false }),
    resolveGroup: async () => {
      called = true;
      return catalogGroup();
    },
  });
  assert.equal(rescued, null);
  assert.equal(called, false);
});

test('anything but a signature is refused before it reaches the database', async () => {
  // The source-id shape is the unindexed OR plan this lane must never run.
  let called = false;
  for (const signatureId of [undefined, '', '   ', 'ext:retailer:6ea79af5', 'ck_5dc9474321d1d597668670aebfd7543a', 'prod::m::external_seed::x']) {
    const rescued = await resolveMissingIdentityGroupMembers({
      ...baseArgs({ signatureId }),
      resolveGroup: async () => {
        called = true;
        return catalogGroup();
      },
    });
    assert.equal(rescued, null, String(signatureId));
  }
  assert.equal(called, false, 'no non-signature shape may be sent to the resolver');
});

test('a resolver that answers nothing, or answers rubbish, is refused', async () => {
  for (const group of [undefined, null, {}, { members: null }, { members: 'two' }, { members: [OHLOLLY] }]) {
    const rescued = await resolveMissingIdentityGroupMembers({
      ...baseArgs(),
      resolveGroup: resolverReturning(group),
    });
    assert.equal(rescued, null, JSON.stringify(group));
  }
});

test('the answer is cached, and so is a NO', async () => {
  // This fires on the majority of seed-routed signature PDPs and all but ~16 products answer "no
  // group"; an uncached no would be a query per page view.
  const hitCalls = [];
  const key = 'cache-hit-case';
  const first = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: key }),
    resolveGroup: resolverReturning(catalogGroup(), hitCalls),
  });
  const second = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: key }),
    resolveGroup: resolverReturning(catalogGroup(), hitCalls),
  });
  assert.equal(hitCalls.length, 1, 'the second view must not re-query');
  assert.deepEqual(second, first);

  const missCalls = [];
  const negativeKey = 'cache-negative-case';
  await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: negativeKey }),
    resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY] }), missCalls),
  });
  const secondNo = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: negativeKey }),
    resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY] }), missCalls),
  });
  assert.equal(missCalls.length, 1, 'a NO is remembered too');
  assert.equal(secondNo, null);
});

test('the cache expires, so an approved identity listing is not shadowed for long', async () => {
  const calls = [];
  const key = 'cache-ttl-case';
  let clock = 1_000_000;
  const args = () => ({ ...baseArgs({ cacheKey: key }), now: () => clock });

  await resolveMissingIdentityGroupMembers({ ...args(), resolveGroup: resolverReturning(catalogGroup(), calls) });
  clock += 59_000;
  await resolveMissingIdentityGroupMembers({ ...args(), resolveGroup: resolverReturning(catalogGroup(), calls) });
  assert.equal(calls.length, 1, 'still fresh at 59s');

  clock += 2_000;
  await resolveMissingIdentityGroupMembers({ ...args(), resolveGroup: resolverReturning(catalogGroup(), calls) });
  assert.equal(calls.length, 2, 're-resolved after the TTL');
});

test('the cache is bounded', async () => {
  // 500 entries, evicting the oldest insertion. Unbounded, this would grow with the catalog.
  for (let i = 0; i < 600; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await resolveMissingIdentityGroupMembers({
      ...baseArgs({ cacheKey: `bound-${i}` }),
      resolveGroup: resolverReturning(catalogGroup()),
    });
  }
  const evicted = [];
  await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: 'bound-0' }),
    resolveGroup: resolverReturning(catalogGroup(), evicted),
  });
  assert.equal(evicted.length, 1, 'the oldest key was evicted rather than kept forever');

  // THE CONTROL. Without it a cache that retains NOTHING passes this test: every write evicts,
  // bound-0 still misses, and a cache of size 1 reads as the intended one.
  const retained = [];
  await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: 'bound-599' }),
    resolveGroup: resolverReturning(catalogGroup(), retained),
  });
  assert.equal(retained.length, 0, 'a recent key is still a hit');
});

test('an identity listing that elected a DIFFERENT group is not second-guessed', async () => {
  // `catalogIdentity.sellable_item_group_id` defaults to the request's own signature when no
  // approved live listing answered; that echo is the gap this rescue fills. A different id means
  // an approved listing really did elect a group, and a group with no other members is that
  // lane's answer. Caught by tests/external_seed_product_detail_fetch.test.js, which pins that a
  // sig PDP with an approved identity listing issues NO canonical-group query at all.
  let called = false;
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ identityGroupId: 'sig_someother_product_line', identityGroupApproved: true }),
    resolveGroup: async () => {
      called = true;
      return catalogGroup();
    },
  });

  assert.equal(rescued, null);
  assert.equal(called, false, 'and it costs no query');
});

test('the identity group id echoing the request is exactly the gap to fill', async () => {
  const calls = [];
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ identityGroupId: SIG, identityGroupApproved: true }),
    resolveGroup: resolverReturning(catalogGroup(), calls),
  });

  assert.equal(rescued.group_id, 'sig_b97a3180c7c8868edd3bd2417f8def27');
  assert.equal(calls.length, 1);
});

test('a listing the catalog is not serving is not a seller, whatever its stage says', async () => {
  // Every other serving lane in this repo pairs the lifecycle stage with sync_status='live'. A
  // retired listing is published and dead: its own PDP 404s, so offering it a price here would
  // give two different answers for one row.
  for (const sync of ['retired', 'archived', 'pending', '', undefined]) {
    const dead = member({ merchant_id: 'merch_obs_retired', sync_status: sync });
    const rescued = await resolveMissingIdentityGroupMembers({
      ...baseArgs(),
      resolveGroup: resolverReturning(catalogGroup({ members: [OHLOLLY, dead] })),
    });
    assert.equal(rescued, null, `sync_status ${String(sync)} must not be served`);
  }
});

test('an identity opinion the identity lane itself refuses to serve is not an opinion', async () => {
  // Prod 2026-09-17: 7,513 pdp_identity_listing rows are `approved` with live_read_enabled=false
  // and 670 are review_required. One of the two catalogIdentity producers reads that table through
  // a LEFT JOIN with NO status filter, so those ids reach this gate. Treating them as an opinion
  // would leave the original defect in place for exactly those rows.
  const calls = [];
  const rescued = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ identityGroupId: 'sig_someother_product_line', identityGroupApproved: false }),
    resolveGroup: resolverReturning(catalogGroup(), calls),
  });

  assert.equal(rescued.group_id, 'sig_b97a3180c7c8868edd3bd2417f8def27');
  assert.equal(calls.length, 1, 'the rescue still runs');
});

test('concurrent views of one product issue ONE query', async () => {
  // A cold cache after a deploy is exactly when every in-flight request for the same product would
  // otherwise resolve separately — the stampede the cache exists to prevent.
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slowResolver = async (args) => {
    calls.push(args);
    await gate;
    return catalogGroup();
  };

  const key = 'stampede-case';
  const inFlight = [1, 2, 3, 4, 5].map(() =>
    resolveMissingIdentityGroupMembers({ ...baseArgs({ cacheKey: key }), resolveGroup: slowResolver }),
  );
  release();
  const results = await Promise.all(inFlight);

  assert.equal(calls.length, 1, 'five concurrent views, one query');
  for (const result of results) {
    assert.equal(result.group_id, 'sig_b97a3180c7c8868edd3bd2417f8def27');
  }
});

test('two views never share one mutable members array', async () => {
  // The cached entry outlives the request. One future `groupMembers.sort()` downstream would
  // otherwise corrupt every later view of that product for the rest of the TTL.
  const key = 'aliasing-case';
  const first = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: key }),
    resolveGroup: resolverReturning(catalogGroup()),
  });
  first.members.length = 0;
  first.members.push({ merchant_id: 'mutated' });

  const second = await resolveMissingIdentityGroupMembers({
    ...baseArgs({ cacheKey: key }),
    resolveGroup: resolverReturning(catalogGroup()),
  });

  assert.equal(second.members.length, 2, 'the second view is untouched by the first');
  assert.deepEqual(
    second.members.map((m) => m.merchant_id),
    [EYURS.merchant_id, OHLOLLY.merchant_id],
  );
});
