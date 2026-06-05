const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileToOwnServingRow, isPdpIdentityReconcileEnabled } = require('../src/services/pdpIdentityReconcile');

const DRIFTED = { serving_eligible: false, content_key: 'ck_drifted', blocker_code: 'no_seed' };
const OWN_SERVABLE = {
  serving_eligible: true,
  content_key: 'ck_own',
  product_key: 'pk_own',
  pivota_signature_id: 'sig_own',
};

const baseArgs = {
  servingEligibility: DRIFTED,
  merchantId: 'external_seed',
  productId: 'ext_db970',
  fetchOwnRowEligibility: async () => OWN_SERVABLE,
};

test('flag helper reads AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED', () => {
  const prev = process.env.AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED;
  process.env.AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED = 'true';
  assert.equal(isPdpIdentityReconcileEnabled(), true);
  process.env.AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED = 'false';
  assert.equal(isPdpIdentityReconcileEnabled(), false);
  delete process.env.AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED;
  assert.equal(isPdpIdentityReconcileEnabled(), false);
  if (prev !== undefined) process.env.AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED = prev;
});

test('reconciles a genuine drift: own row servable + different content_key', async () => {
  const res = await reconcileToOwnServingRow(baseArgs);
  assert.ok(res);
  assert.equal(res.eligibility.serving_eligible, true);
  assert.equal(res.eligibility.eligibility_override_reason, 'identity_reconciled_to_own_row');
  assert.equal(res.from_content_key, 'ck_drifted');
  assert.equal(res.to_content_key, 'ck_own');
  assert.deepEqual(res.refPatch, {
    merchant_id: 'external_seed',
    product_id: 'ext_db970',
    content_key: 'ck_own',
    contentKey: 'ck_own',
    product_key: 'pk_own',
    pivota_signature_id: 'sig_own',
  });
});

test('no reconcile when the resolved group is already servable', async () => {
  const res = await reconcileToOwnServingRow({
    ...baseArgs,
    servingEligibility: { serving_eligible: true, content_key: 'ck_drifted' },
  });
  assert.equal(res, null);
});

test('no reconcile when there is no resolved eligibility (missing-eligibility owns it)', async () => {
  const res = await reconcileToOwnServingRow({ ...baseArgs, servingEligibility: null });
  assert.equal(res, null);
});

test('no reconcile when own row is also not servable (genuine not-servable)', async () => {
  const res = await reconcileToOwnServingRow({
    ...baseArgs,
    fetchOwnRowEligibility: async () => ({ serving_eligible: false, content_key: 'ck_own' }),
  });
  assert.equal(res, null);
});

test('no reconcile when own content_key equals the resolved one (no drift)', async () => {
  const res = await reconcileToOwnServingRow({
    ...baseArgs,
    fetchOwnRowEligibility: async () => ({ ...OWN_SERVABLE, content_key: 'ck_drifted' }),
  });
  assert.equal(res, null);
});

test('fail-closed: fetchOwnRowEligibility throwing yields null (stays blocked)', async () => {
  const res = await reconcileToOwnServingRow({
    ...baseArgs,
    fetchOwnRowEligibility: async () => {
      throw new Error('db down');
    },
  });
  assert.equal(res, null);
});

test('does not override an already-granted eligibility override', async () => {
  const res = await reconcileToOwnServingRow({
    ...baseArgs,
    servingEligibility: { ...DRIFTED, eligibility_override_reason: 'published_missing_quality_snapshot' },
  });
  assert.equal(res, null);
});
