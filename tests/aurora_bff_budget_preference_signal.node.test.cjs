const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getProfileForIdentity,
  recordBudgetPreferenceEventForIdentity,
  upsertProfileForIdentity,
} = require('../src/auroraBff/memoryStore');

const budgetSignalTestsEnabled = String(process.env.AURORA_BFF_RETENTION_DAYS || '').trim() === '0';
const budgetSignalSkipReason = 'set AURORA_BFF_RETENTION_DAYS=0 to run budget preference signal tests in ephemeral mode';

function budgetSignalTest(name, fn) {
  if (budgetSignalTestsEnabled) return test(name, fn);
  return test(name, { skip: budgetSignalSkipReason }, fn);
}

function uniqueUid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

budgetSignalTest('budget preference backfills after 5 clicks in 14d when threshold is met', async () => {
  const auroraUid = uniqueUid('budget_fill');

  const events = [
    { tier: 'low', price: 12 },
    { tier: 'low', price: 16 },
    { tier: 'low', price: 14 },
    { tier: 'low', price: 18 },
    { tier: 'mid', price: 42 },
  ];

  for (const evt of events) {
    // eslint-disable-next-line no-await-in-loop
    const out = await recordBudgetPreferenceEventForIdentity(
      { auroraUid, userId: null },
      {
        tier: evt.tier,
        price: evt.price,
        currency: 'USD',
        sourceEvent: 'aurora_ingredient_plan_product_tap',
      },
    );
    assert.equal(out.ok, true);
  }

  const profile = await getProfileForIdentity({ auroraUid, userId: null });
  assert.equal(profile && profile.budgetTier, 'low');
});

budgetSignalTest('budget preference does not backfill when total clicks are below threshold', async () => {
  const auroraUid = uniqueUid('budget_no_fill');
  const events = [
    { tier: 'high', price: 78 },
    { tier: 'high', price: 82 },
    { tier: 'high', price: 80 },
    { tier: 'high', price: 90 },
  ];

  for (const evt of events) {
    // eslint-disable-next-line no-await-in-loop
    const out = await recordBudgetPreferenceEventForIdentity(
      { auroraUid, userId: null },
      {
        tier: evt.tier,
        price: evt.price,
        currency: 'USD',
        sourceEvent: 'ui_pdp_opened',
      },
    );
    assert.equal(out.ok, true);
  }

  const profile = await getProfileForIdentity({ auroraUid, userId: null });
  assert.equal(Boolean(profile && profile.budgetTier), false);
});

budgetSignalTest('budget preference never overwrites an explicit profile budget', async () => {
  const auroraUid = uniqueUid('budget_keep_explicit');
  await upsertProfileForIdentity({ auroraUid, userId: null }, { budgetTier: 'mid' });

  const events = [
    { tier: 'high', price: 95 },
    { tier: 'high', price: 92 },
    { tier: 'high', price: 88 },
    { tier: 'high', price: 110 },
    { tier: 'high', price: 99 },
    { tier: 'high', price: 105 },
  ];

  for (const evt of events) {
    // eslint-disable-next-line no-await-in-loop
    const out = await recordBudgetPreferenceEventForIdentity(
      { auroraUid, userId: null },
      {
        tier: evt.tier,
        price: evt.price,
        currency: 'USD',
        sourceEvent: 'aurora_photo_modules_product_tap',
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.backfill && out.backfill.reason, 'budget_already_set');
  }

  const profile = await getProfileForIdentity({ auroraUid, userId: null });
  assert.equal(profile && profile.budgetTier, 'mid');
});
