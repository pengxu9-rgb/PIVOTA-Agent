'use strict';

// #2157 fixed ONE site that asked "is this the primary role?" with `roleRank > 1`, the
// end-to-end acne probe went 0/6 -> 6/6, and everyone (me included) called it done. It was
// not: the concern planner emits SPACED ranks — acne_clogged_pore_treatment 11,
// lightweight_moisturizer 20, daily_sunscreen 30 (recommendationSharedStack.js:425,442,458)
// — so every OTHER site still asking that way keeps calling the primary a support role.
//
// This pins the rule itself, in one place, plus the one site whose effect can actually be
// measured. See tests/recall_primary_role_budget.test.js for the budget site #2157 fixed.

process.env.AURORA_BFF_USE_MOCK = 'true';
const { __internal } = require('../src/auroraBff/routes');

const PRIMARY = {
  role_id: 'acne_clogged_pore_treatment',
  rank: 11,
  preferred_step: 'treatment',
  query_terms: ['salicylic acid treatment'],
  fit_keywords: ['clogged', 'pore'],
  product_type_hypotheses: ['serum'],
};
const TARGET_CONTEXT = {
  framework_id: 'recofw_identity',
  primary_role_id: 'acne_clogged_pore_treatment',
  framework_roles: [PRIMARY],
};

function seedRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    external_product_id: `ep_${i}`, id: `ep_${i}`, product_id: `ep_${i}`,
    title: `Salicylic Acid 2% Treatment Serum ${i} clogged pores`,
    brand: 'Brand', price: 20 + i, currency: 'USD',
    canonical_url: `https://x.test/p/${i}`, destination_url: `https://x.test/p/${i}`,
    image_url: `https://x.test/i/${i}.jpg`,
    category: 'treatment', category_path: 'skincare/treatment',
    seed_data: {
      description: 'Salicylic acid serum for clogged pores and blemishes.',
      derived: { recall: { category: 'treatment', vertical: 'skincare',
        retrieval_title: `Salicylic Acid 2% Treatment Serum ${i}`,
        retrieval_summary: 'salicylic acid clogged pores serum' } },
    },
    retrieval_title: `Salicylic Acid 2% Treatment Serum ${i}`,
    retrieval_summary: 'salicylic acid clogged pores serum',
    availability: 'in_stock', market: 'US',
  }));
}

// The pool the surfacing ranker actually receives. NOT the number of products returned —
// the caller's limit still governs that, which is exactly why this defect was invisible.
async function surfacingPool({ role, targetContext }) {
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'salicylic acid treatment',
    limit: 6,
    role,
    targetContext,
    preferredStep: role.preferred_step,
    queryFn: async () => ({ rows: seedRows(40) }),
  });
  const debug = out?.local_external_seed_candidate_debug || {};
  return {
    pool: Number(debug.rank_pool_row_count),
    dropped: Number(debug.dropped_before_surfacing_count),
    returned: (out?.products || []).length,
  };
}

describe('isPrimaryFrameworkRole — the rule five sites share', () => {
  const isPrimary = __internal.isPrimaryFrameworkRole;

  test('identity wins over rank, in both directions', () => {
    expect(isPrimary({ role_id: 'acne_clogged_pore_treatment', rank: 11 }, TARGET_CONTEXT)).toBe(true);
    // A rank of 1 does NOT make a role primary when the framework names another one.
    expect(isPrimary({ role_id: 'lightweight_moisturizer', rank: 1 }, TARGET_CONTEXT)).toBe(false);
  });

  test('case and whitespace on either side do not break the match', () => {
    // The prior-reco continuation lane carries a differently-cased primary id; a trim-only
    // compare would make EVERY role non-primary there and silently restore the defect.
    expect(isPrimary({ role_id: ' Acne_Clogged_Pore_Treatment ' }, TARGET_CONTEXT)).toBe(true);
    expect(isPrimary({ role_id: 'acne_clogged_pore_treatment' },
      { primary_role_id: '  ACNE_CLOGGED_PORE_TREATMENT  ' })).toBe(true);
  });

  test('without a primary_role_id it falls back to rank, keeping the old meaning', () => {
    expect(isPrimary({ role_id: 'x', rank: 1 }, { framework_roles: [] })).toBe(true);
    expect(isPrimary({ role_id: 'x', rank: 11 }, { framework_roles: [] })).toBe(false);
    expect(isPrimary({ role_id: 'x', rank: 20 }, null)).toBe(false);
  });

  test('a role nobody ranked reads as primary, not as support', () => {
    expect(isPrimary({ role_id: 'x' }, { framework_roles: [] })).toBe(true);
    expect(isPrimary({ role_id: 'x', rank: null }, null)).toBe(true);
    expect(isPrimary({ role_id: 'x', rank: 'not-a-number' }, null)).toBe(true);
    expect(isPrimary(null, null)).toBe(true);
  });

  test('it reads the alternate key spellings the call sites actually pass', () => {
    // isBeautyMainlinePrimaryRoleQuery passes query entries keyed roleId/role_rank/roleRank.
    // Asserted with a NON-matching id and no rank: if the `roleId` alias is dropped, the id
    // reads as '' and the rank fallback answers `true` for a role with no rank — so a
    // `toBe(true)` case here would pass with the alias gone. It has to be the false case.
    expect(isPrimary({ roleId: 'lightweight_moisturizer' }, TARGET_CONTEXT)).toBe(false);
    expect(isPrimary({ roleId: 'acne_clogged_pore_treatment' }, TARGET_CONTEXT)).toBe(true);
    expect(isPrimary({ role_id: 'x', role_rank: 11 }, null)).toBe(false);
    expect(isPrimary({ role_id: 'x', roleRank: 11 }, null)).toBe(false);
  });

  test('an explicit primaryRoleId overrides the targetContext', () => {
    expect(isPrimary({ role_id: 'lightweight_moisturizer' }, TARGET_CONTEXT,
      { primaryRoleId: 'lightweight_moisturizer' })).toBe(true);
  });
});

describe('support rank pool cap — the site the sweep actually fixes', () => {
  test('the spaced-rank primary keeps the full pool', async () => {
    // MEASURED on the pre-fix tree: pool 12, dropped 12. A rank-1 primary got 24/0.
    const { pool, dropped, returned } = await surfacingPool({ role: PRIMARY, targetContext: TARGET_CONTEXT });
    expect(pool).toBe(24);
    expect(dropped).toBe(0);
    // The defect never changed how many products came back, which is why it hid: it halved
    // the pool those came FROM. Asserted so nobody "fixes" this by changing the limit.
    expect(returned).toBe(6);
  });

  test('a genuine support role is still capped', async () => {
    // preferred_step stays 'treatment' so the SEEDED ROWS still match: change the step and the
    // pool is bound by how many rows survive matching (6), not by the cap, and the control
    // stops controlling for anything. Only role_id and rank differ from the primary case.
    const support = { ...PRIMARY, role_id: 'lightweight_moisturizer', rank: 20 };
    const { pool, dropped } = await surfacingPool({ role: support, targetContext: TARGET_CONTEXT });
    expect(pool).toBe(12);
    expect(dropped).toBe(12);
  });

  test('a support role at rank 2 is capped too — this is not a rank-11 special case', async () => {
    const support = { ...PRIMARY, role_id: 'daily_sunscreen_support', rank: 2 };
    const { pool } = await surfacingPool({ role: support, targetContext: TARGET_CONTEXT });
    expect(pool).toBe(12);
  });

  // THE CAP HAS TWO CALL SITES. `searchLocalExternalSeedProducts` reaches one;
  // `searchLocalExternalSeedProductsForQueryVariants` reaches the other whenever the planner
  // hands the lane more than one query, which it routinely does. Dropping `targetContext` at
  // this second site left every other test here green.
  async function variantsSurfacingPool({ role, targetContext }) {
    const out = await __internal.searchLocalExternalSeedProductsForQueryVariants({
      queries: ['salicylic acid treatment', 'bha exfoliant for clogged pores'],
      limit: 6,
      role,
      targetContext,
      preferredStep: role.preferred_step,
      queryFn: async () => ({ rows: seedRows(40) }),
    });
    const debug = out?.local_external_seed_candidate_debug || {};
    return Number(debug.rank_pool_row_count);
  }

  test('the second call site — multi-query variants — applies the same rule', async () => {
    expect(await variantsSurfacingPool({ role: PRIMARY, targetContext: TARGET_CONTEXT })).toBe(24);
    expect(await variantsSurfacingPool({
      role: { ...PRIMARY, role_id: 'lightweight_moisturizer', rank: 20 },
      targetContext: TARGET_CONTEXT,
    })).toBe(12);
  });

  test('with no primary_role_id the rank fallback still governs the cap', async () => {
    const noId = { framework_roles: [PRIMARY] };
    expect((await surfacingPool({ role: PRIMARY, targetContext: noId })).pool).toBe(12);
    expect((await surfacingPool({ role: { ...PRIMARY, rank: 1 }, targetContext: noId })).pool).toBe(24);
  });
});

describe('the refactored sites — a case change, not a no-op', () => {
  // These exist because mutating either site back to its pre-sweep INLINE body was green across
  // every test in this repo. The helper's lowercasing is tested above; that proves nothing about
  // whether a given call site calls the helper. A claimed behaviour change with no test is the
  // same defect as a false comment.
  //
  // The lane that makes this matter: beautyChatMainlineEntry.js sets primary_role_id from session
  // `context.primary_target_id` while role_id comes from `target.target_id`, and emits spaced ranks
  // ((i+1)*10). Pre-sweep the id compare failed on case, fell through to rank, saw 10/20/30 and
  // answered "not primary" for every role in the lane.
  test('isBeautyMainlinePrimaryRoleQuery matches a differently-cased primary id', () => {
    const isPrimaryQuery = __internal.isBeautyMainlinePrimaryRoleQuery;
    // The pre-sweep body was `roleId === primaryRoleId` — this case returned false.
    expect(isPrimaryQuery({ role_id: 'acne_clogged_pore_treatment', role_rank: 11 },
      'Acne_Clogged_Pore_Treatment')).toBe(true);
    expect(isPrimaryQuery({ role_id: ' ACNE_CLOGGED_PORE_TREATMENT ', role_rank: 11 },
      'acne_clogged_pore_treatment')).toBe(true);
    // A genuinely different role still answers false, so this is not "everything is primary now".
    expect(isPrimaryQuery({ role_id: 'lightweight_moisturizer', role_rank: 20 },
      'Acne_Clogged_Pore_Treatment')).toBe(false);
    // And the rank fallback survives for entries carrying no id.
    expect(isPrimaryQuery({ role_rank: 11 }, 'acne_clogged_pore_treatment')).toBe(false);
    expect(isPrimaryQuery({ role_rank: 1 }, 'acne_clogged_pore_treatment')).toBe(true);
    expect(isPrimaryQuery(null, 'acne_clogged_pore_treatment')).toBe(false);
  });

  // STILL UNPINNED, said out loud rather than left to look covered: the second refactored site is
  // the stable-alias authority branch inside runBeautyMainlineLocalHandoffSearch's closure. It is
  // not reachable the way the function above is, and reverting IT to its pre-sweep inline body is
  // still green everywhere. Same case-sensitivity change, same lane, no test. Either export the
  // predicate the way this one was, or drive the handoff.
  test.todo('the stable-alias authority branch is not pinned — reverting it stays green');
});
