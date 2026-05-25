const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildQuarantineAntiJoinSql,
  isSourceQuarantined,
  quarantineMatchesSource,
} = require('../src/services/sourceQuarantine');

function q(overrides = {}) {
  return {
    quarantine_id: 1,
    match_type: 'domain',
    match_value: 'example.com',
    state: 'active',
    reason: null,
    expires_at: null,
    created_by: 'test',
    created_at: null,
    revoked_at: null,
    revoked_by: null,
    metadata: null,
    ...overrides,
  };
}

function fakePool(rows) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      return { rows };
    },
  };
}

test('buildQuarantineAntiJoinSql includes all match types and expiry guard', () => {
  const sql = buildQuarantineAntiJoinSql({
    domainExpr: 'p.source_domain',
    merchantExpr: 'p.merchant_id',
    platformExpr: 'p.platform',
    sourceSystemExpr: 'p.source_system',
    sourceRefExpr: 'p.source_ref',
  });

  assert.match(sql, /catalog_source_quarantine q/);
  assert.match(sql, /q\.state = 'active'/);
  assert.match(sql, /q\.expires_at IS NULL OR q\.expires_at > now\(\)/);
  assert.match(sql, /q\.match_type = 'domain'/);
  assert.match(sql, /lower\(q\.match_value\) = lower\(p\.source_domain\)/);
  assert.match(sql, /q\.match_type = 'merchant_platform'/);
  assert.match(sql, /q\.match_type = 'source_system_ref'/);
});

test('domain quarantine match is case-insensitive', () => {
  assert.equal(
    quarantineMatchesSource(q({ match_value: 'JWX893-FZ.MyShopify.com' }), {
      domain: 'jwx893-fz.myshopify.com',
    }),
    true,
  );
});

test('merchant_platform quarantine match is exact', () => {
  const quarantine = q({
    match_type: 'merchant_platform',
    match_value: 'merch_efbc46b4619cfbdf:shopify',
  });

  assert.equal(
    quarantineMatchesSource(quarantine, {
      merchantId: 'merch_efbc46b4619cfbdf',
      platform: 'shopify',
    }),
    true,
  );
  assert.equal(
    quarantineMatchesSource(quarantine, {
      merchantId: 'MERCH_EFBC46B4619CFBDF',
      platform: 'shopify',
    }),
    false,
  );
});

test('source_system_ref quarantine match is exact', () => {
  assert.equal(
    quarantineMatchesSource(q({
      match_type: 'source_system_ref',
      match_value: 'shopify_products_sync:run_12345',
    }), {
      sourceSystem: 'shopify_products_sync',
      sourceRef: 'run_12345',
    }),
    true,
  );
});

test('revoked and expired quarantines do not match', () => {
  const now = new Date('2026-05-25T00:00:00.000Z');

  assert.equal(
    quarantineMatchesSource(q({ state: 'revoked' }), { domain: 'example.com' }, { now }),
    false,
  );
  assert.equal(
    quarantineMatchesSource(
      q({ expires_at: '2026-05-24T23:59:59.000Z' }),
      { domain: 'example.com' },
      { now },
    ),
    false,
  );
});

test('isSourceQuarantined loads active rows from dbPool', async () => {
  const dbPool = fakePool([q({ match_value: 'example.com' })]);

  assert.equal(
    await isSourceQuarantined({ domain: 'EXAMPLE.com' }, { dbPool }),
    true,
  );
  assert.equal(dbPool.calls.length, 1);
  assert.match(dbPool.calls[0].sql, /FROM catalog_source_quarantine/);
});
