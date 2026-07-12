'use strict';

// Behavior tests (NOT SQL-shape tests) for the transaction-capable serving predicate.
// The ADR-009 review lesson: SQL-shape assertions (.toContain(...)) let a COALESCE /
// 3-valued-logic bug pass 35 tests. So here we EXECUTE the generated predicate against a
// real (in-memory Postgres) fixture and assert the ROW SETS it returns — including the
// NULL psp_connected path explicitly.

const { newDb } = require('pg-mem');
const {
  transactionCapableMerchantWhere,
} = require('../src/services/merchantTransactionCapabilitySql');

// Fixture merchants covering every relevant (psp_connected x has-capability-row) cell.
const MERCHANTS = [
  { id: 'm_psp_true', psp: true, cap: false }, // psp-connected only
  { id: 'm_psp_true_and_cap', psp: true, cap: true }, // both
  { id: 'm_cap_only_pspfalse', psp: false, cap: true }, // protocol-capable only (psp=false)
  { id: 'm_cap_only_pspnull', psp: null, cap: true }, // protocol-capable only (psp=NULL)
  { id: 'm_neither_pspfalse', psp: false, cap: false }, // neither (psp=false)
  { id: 'm_neither_pspnull', psp: null, cap: false }, // neither (psp=NULL)
];

function seedDb() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE merchant_onboarding (
      merchant_id text PRIMARY KEY,
      status text,
      psp_connected boolean
    );
    CREATE TABLE pcs_merchant_capabilities (
      merchant_id text PRIMARY KEY,
      has_shopify_payments boolean
    );
  `);
  // Literal SQL (not bound params): pg-mem mistypes a NULL passed as a boolean parameter.
  for (const m of MERCHANTS) {
    const pspLiteral = m.psp === null ? 'NULL' : String(m.psp);
    db.public.none(
      `INSERT INTO merchant_onboarding (merchant_id, status, psp_connected)
       VALUES ('${m.id}', 'approved', ${pspLiteral})`,
    );
    if (m.cap) {
      db.public.none(
        `INSERT INTO pcs_merchant_capabilities (merchant_id, has_shopify_payments)
         VALUES ('${m.id}', true)`,
      );
    }
  }
  return db;
}

function servedIds(db, predicate) {
  const rows = db.public.many(
    `SELECT merchant_id FROM merchant_onboarding mo
     WHERE mo.status = 'approved' AND ${predicate}
     ORDER BY merchant_id`,
  );
  return rows.map((r) => r.merchant_id).sort();
}

describe('transactionCapableMerchantWhere — executed row sets', () => {
  test('flag OFF: only psp_connected=true merchants (false AND NULL excluded)', () => {
    const db = seedDb();
    const ids = servedIds(db, transactionCapableMerchantWhere('mo', { capabilityGate: false }));
    expect(ids).toEqual(['m_psp_true', 'm_psp_true_and_cap']);
  });

  test('flag OFF is row-set-identical to the legacy `mo.psp_connected = true` predicate', () => {
    // The hard requirement: byte-identical RESULTS with the flag off. Prove it by running
    // the exact legacy predicate against the same fixture and comparing row sets.
    const db = seedDb();
    const legacy = servedIds(db, 'mo.psp_connected = true');
    const helperOff = servedIds(db, transactionCapableMerchantWhere('mo', { capabilityGate: false }));
    expect(helperOff).toEqual(legacy);
  });

  test('flag OFF also matches the legacy COALESCE variant (site src/server.js:10670)', () => {
    const db = seedDb();
    const legacyCoalesce = servedIds(db, 'COALESCE(mo.psp_connected, false) = true');
    const helperOff = servedIds(db, transactionCapableMerchantWhere('mo', { capabilityGate: false }));
    expect(helperOff).toEqual(legacyCoalesce);
  });

  test('flag ON: protocol-capable merchants included; "neither" still excluded', () => {
    const db = seedDb();
    const ids = servedIds(db, transactionCapableMerchantWhere('mo', { capabilityGate: true }));
    expect(ids).toEqual([
      'm_cap_only_pspfalse',
      'm_cap_only_pspnull',
      'm_psp_true',
      'm_psp_true_and_cap',
    ]);
    // "neither" merchants (no PSP, no capability row) are NEVER served, flag on or off.
    expect(ids).not.toContain('m_neither_pspfalse');
    expect(ids).not.toContain('m_neither_pspnull');
  });

  test('NULL psp_connected is handled explicitly (3-valued logic)', () => {
    const db = seedDb();
    // Flag OFF: NULL psp is excluded (NULL is not true).
    const off = servedIds(db, transactionCapableMerchantWhere('mo', { capabilityGate: false }));
    expect(off).not.toContain('m_cap_only_pspnull');
    expect(off).not.toContain('m_neither_pspnull');
    // Flag ON: NULL psp is admitted ONLY via the capability row, never on its own.
    const on = servedIds(db, transactionCapableMerchantWhere('mo', { capabilityGate: true }));
    expect(on).toContain('m_cap_only_pspnull'); // has capability row
    expect(on).not.toContain('m_neither_pspnull'); // NULL psp + no capability row => excluded
  });

  test('env flag drives the gate when opts.capabilityGate is omitted', () => {
    const db = seedDb();
    const prev = process.env.AGENT_CHECKOUT_CAPABILITY_GATE;
    try {
      delete process.env.AGENT_CHECKOUT_CAPABILITY_GATE;
      expect(servedIds(db, transactionCapableMerchantWhere('mo'))).toEqual([
        'm_psp_true',
        'm_psp_true_and_cap',
      ]);
      process.env.AGENT_CHECKOUT_CAPABILITY_GATE = '1';
      expect(servedIds(db, transactionCapableMerchantWhere('mo'))).toContain('m_cap_only_pspfalse');
      // Any non-"1" value stays off (fail-closed).
      process.env.AGENT_CHECKOUT_CAPABILITY_GATE = 'true';
      expect(servedIds(db, transactionCapableMerchantWhere('mo'))).toEqual([
        'm_psp_true',
        'm_psp_true_and_cap',
      ]);
    } finally {
      if (prev === undefined) delete process.env.AGENT_CHECKOUT_CAPABILITY_GATE;
      else process.env.AGENT_CHECKOUT_CAPABILITY_GATE = prev;
    }
  });

  test('bare table-name qualifier (un-aliased merchant_onboarding query) executes', () => {
    // Site src/server.js:10670 uses `FROM merchant_onboarding` with no alias; the helper is
    // called with the bare table name as the qualifier. Prove that SQL runs.
    const db = seedDb();
    const rows = db.public.many(
      `SELECT merchant_id FROM merchant_onboarding
       WHERE ${transactionCapableMerchantWhere('merchant_onboarding', { capabilityGate: true })}
       ORDER BY merchant_id`,
    );
    const ids = rows.map((r) => r.merchant_id).sort();
    expect(ids).toContain('m_cap_only_pspfalse');
    expect(ids).not.toContain('m_neither_pspfalse');
  });

  test('unsafe alias cannot inject SQL (falls back to default)', () => {
    const frag = transactionCapableMerchantWhere('mo; DROP TABLE merchant_onboarding;--', {
      capabilityGate: true,
    });
    expect(frag).not.toContain('DROP TABLE');
    expect(frag).toContain('COALESCE(mo.psp_connected, false) = true');
  });
});
