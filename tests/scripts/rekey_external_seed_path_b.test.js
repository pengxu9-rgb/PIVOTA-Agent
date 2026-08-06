const script = require('../../scripts/rekey-external-seed-path-b.cjs');

const {
  COHORT_SQL,
  UPDATE_STATEMENTS,
  ADMITTING_STATUSES,
  RETIRED_TEST_RIG,
  SENTINEL,
  PATH_B_SOURCE_SYSTEM,
  CONFIRM_TOKEN,
  assertFrozenColumnsUnwritten,
  parseArgs,
} = script;

function argv(...rest) {
  return ['node', 'rekey-external-seed-path-b.cjs', ...rest];
}

describe('rekey-external-seed-path-b argument safety', () => {
  it('defaults to a read-only dry run', () => {
    const args = parseArgs(argv());
    expect(args.write).toBe(false);
    expect(args.rollbackBatch).toBeNull();
  });

  it('refuses --write without the confirm token', () => {
    expect(() => parseArgs(argv('--write'))).toThrow(/--confirm/);
    expect(() => parseArgs(argv('--write', '--confirm', 'wrong'))).toThrow(/--confirm/);
    expect(parseArgs(argv('--write', '--confirm', CONFIRM_TOKEN)).write).toBe(true);
  });

  it('rejects unknown and malformed arguments rather than ignoring them', () => {
    expect(() => parseArgs(argv('--yolo'))).toThrow(/unknown argument/);
    expect(() => parseArgs(argv('--max-sellers', '0'))).toThrow(/positive integer/);
    expect(() => parseArgs(argv('--max-sellers', 'all'))).toThrow(/positive integer/);
  });
});

describe('rekey-external-seed-path-b write safety', () => {
  it('never assigns a frozen column', () => {
    expect(() => assertFrozenColumnsUnwritten()).not.toThrow();
  });

  // ADR-009 D4.2: merchant_id only. A 2026-08-01 backfill that rewrote ext: keys
  // took 364 public PDPs to HTTP 500, so this is enforced, not documented.
  it('refuses to run if a statement is edited to write product_key or a signature', () => {
    for (const stmt of UPDATE_STATEMENTS) {
      const original = stmt.sql;
      for (const poison of ['product_key = $4', 'pivota_signature_id = $4']) {
        stmt.sql = original.replace('SET merchant_id = $4', `SET merchant_id = $4, ${poison}`);
        expect(() => assertFrozenColumnsUnwritten()).toThrow(/frozen column/);
      }
      stmt.sql = original;
    }
    expect(() => assertFrozenColumnsUnwritten()).not.toThrow();
  });

  it('every statement writes merchant_id and nothing else', () => {
    for (const stmt of UPDATE_STATEMENTS) {
      const setClauses = stmt.sql.match(/\bSET\b[\s\S]*?(?=\bFROM\b)/gi) || [];
      expect(setClauses).toHaveLength(1);
      expect(setClauses[0].replace(/\s+/g, ' ').trim()).toBe('SET merchant_id = $4');
    }
  });
});

describe('rekey-external-seed-path-b cohort scoping', () => {
  it('is scoped to Path B only, so Path C cannot be drained before its writer is fixed', () => {
    expect(COHORT_SQL).toContain('cp.source_system = $2');
    expect(PATH_B_SOURCE_SYSTEM).toBe('external_product_seeds_mirror_v1');
    expect(COHORT_SQL).not.toContain('catalog_enrichment_agent_v1');
  });

  it('excludes the retired test rig', () => {
    expect(COHORT_SQL).toContain('eps.seller_ref <> $3');
    expect(RETIRED_TEST_RIG).toBe('merch_efbc46b4619cfbdf');
  });

  it('only ever reads rows still on the sentinel, so re-runs skip completed sellers', () => {
    expect(COHORT_SQL).toContain('cp.merchant_id = $1');
    expect(SENTINEL).toBe('external_seed');
  });

  it('never batches on source_domain, which is NULL on 2,588 cohort rows', () => {
    expect(COHORT_SQL).not.toContain('source_domain');
    for (const stmt of UPDATE_STATEMENTS) {
      expect(stmt.sql).not.toContain('source_domain');
    }
  });
});

describe('rekey-external-seed-path-b sibling tables', () => {
  const byTable = Object.fromEntries(UPDATE_STATEMENTS.map((s) => [s.table, s.sql]));

  it('moves the product row and all three sibling tables', () => {
    expect(Object.keys(byTable).sort()).toEqual(
      ['catalog_offers', 'catalog_products', 'catalog_skus', 'pdp_identity_listing'],
    );
  });

  // pdp_identity_listing.product_id holds `ext_…` values from
  // catalog_products.source_product_id. Joining it on product_key matches zero
  // rows silently, which would leave 8,757 listings orphaned on the sentinel.
  it('joins pdp_identity_listing on source_product_id, not product_key', () => {
    expect(byTable.pdp_identity_listing).toContain('c.source_product_id = tgt.product_id');
    expect(byTable.pdp_identity_listing).not.toContain('c.product_key = tgt.product_id');
  });

  it('joins the product_key-keyed siblings on product_key', () => {
    expect(byTable.catalog_skus).toContain('c.product_key = tgt.product_key');
    expect(byTable.catalog_offers).toContain('c.product_key = tgt.product_key');
  });

  it('records every written row in the ledger in the same statement', () => {
    for (const [table, sql] of Object.entries(byTable)) {
      expect(sql).toContain('INSERT INTO external_seed_rekey_ledger');
      expect(sql).toContain(`'${table}'`);
      expect(sql).toContain('RETURNING');
    }
  });
});

describe('rekey-external-seed-path-b serving admission', () => {
  // A re-keyed row leaves the sentinel branch of activeCatalogProductSourceWhere
  // and falls to the merchant-status branch, so these must stay in step with
  // src/services/activeCatalogSourceSql.js.
  it('admits exactly the statuses the serving predicate admits', () => {
    const servingSql = require('../../src/services/activeCatalogSourceSql')
      .activeCatalogProductSourceWhere('cp', 'cm')
      .replace(/\s+/g, ' ');
    for (const status of ADMITTING_STATUSES) {
      expect(servingSql).toContain(`'${status}'`);
    }
    expect(ADMITTING_STATUSES).toEqual(['active', 'observed']);
  });
});
