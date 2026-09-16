const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Migration 060 drops two indexes that no reader can use (measured on prod 2026-09-16: both
// idx_scan = 0 over 25 days, while siblings on the same table took 24.8M and 15.3M scans).
//
// The reason this needs a real-PostgreSQL test rather than a read of the SQL: src/db/migrate.js
// runs every migration at gateway BOOT, inside a transaction, BEFORE app.listen — so a migration
// that throws stops the revision from starting. DROP INDEX needs ACCESS EXCLUSIVE on
// external_product_seeds, which is hot. The exception handler that keeps a lock wait from wedging
// a rollout is the whole safety story, and it is only real if it is executed.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = path.join(__dirname, '..', '..', 'src', 'db', 'migrations',
  '060_drop_unused_external_seed_brand_search_indexes.sql');

suite('migration 060: dropping the unused brand-search indexes', () => {
  let schema;
  let db;
  const migrationSql = () => fs.readFileSync(MIGRATION, 'utf8');

  const createTableAndIndexes = async (client) => {
    await client.query(`
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, market text, tool text, domain text,
        seed_data jsonb, updated_at timestamptz, created_at timestamptz, status text,
        attached_product_key text);
    `);
    // The two indexes as prod carries them, partial predicate included — the predicate is what
    // makes them unusable by the reader that was supposed to use them.
    await client.query(`CREATE INDEX idx_external_product_seeds_brand_search_fastpath
      ON external_product_seeds (market, tool, lower(coalesce(seed_data->>'brand', '')), updated_at DESC, created_at DESC)
      WHERE status = 'active' AND attached_product_key IS NULL`);
    await client.query(`CREATE INDEX idx_external_product_seeds_brand_search_norm_recency
      ON external_product_seeds (market, tool,
        lower(regexp_replace(coalesce(seed_data->>'brand', ''), '[^a-z0-9]+', '', 'g')),
        updated_at DESC NULLS LAST, created_at DESC NULLS LAST)
      WHERE status = 'active' AND attached_product_key IS NULL`);
  };

  // Scoped to THIS test's schema. pg_indexes spans the whole database, so an unscoped read also
  // counts another worker's schema (and any left behind by a crashed run) — the query passes alone
  // and fails the moment the suite runs beside anything else.
  const brandSearchIndexes = async (client) => {
    const res = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'external_product_seeds'
          AND indexname LIKE '%brand_search%'
        ORDER BY 1`,
      [schema],
    );
    return res.rows.map((row) => row.indexname);
  };

  beforeEach(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `mig060_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await createTableAndIndexes(db);
  }, 60000);

  afterEach(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  test('it drops both indexes, and running it again is a no-op', async () => {
    expect(await brandSearchIndexes(db)).toEqual([
      'idx_external_product_seeds_brand_search_fastpath',
      'idx_external_product_seeds_brand_search_norm_recency',
    ]);

    await db.query('BEGIN');
    await db.query(migrationSql());
    await db.query('COMMIT');
    expect(await brandSearchIndexes(db)).toEqual([]);

    // The runner never repeats a migration, but an operator re-running it by hand must be safe.
    await db.query('BEGIN');
    await db.query(migrationSql());
    await db.query('COMMIT');
    expect(await brandSearchIndexes(db)).toEqual([]);
  }, 60000);

  test('a held lock does NOT throw, because throwing here stops the gateway booting', async () => {
    // Another session holds ACCESS SHARE on the table, which DROP INDEX's ACCESS EXCLUSIVE cannot
    // acquire. Without the handler this raises and, at boot, aborts startup — trading a 16 kB
    // unused index for a failed rollout.
    const blocker = new Client({ connectionString: url });
    await blocker.connect();
    await blocker.query(`SET search_path TO ${schema}`);
    await blocker.query('BEGIN');
    await blocker.query('SELECT count(*) FROM external_product_seeds');

    let threw = null;
    const startedAt = Date.now();
    try {
      await db.query('BEGIN');
      await db.query(migrationSql());
      await db.query('COMMIT');
    } catch (err) {
      threw = err.message;
      await db.query('ROLLBACK').catch(() => {});
    }
    const elapsedMs = Date.now() - startedAt;

    await blocker.query('ROLLBACK');
    await blocker.end();

    expect(threw).toBeNull();
    // It gave up rather than waiting indefinitely: the lock_timeout is doing the work, not luck.
    expect(elapsedMs).toBeGreaterThanOrEqual(2500);
    expect(elapsedMs).toBeLessThan(20000);
    // And the documented consequence is real — the index survives and the migration is still
    // recorded as applied, so the operator verification step in the file header matters.
    expect(await brandSearchIndexes(db)).toEqual([
      'idx_external_product_seeds_brand_search_fastpath',
      'idx_external_product_seeds_brand_search_norm_recency',
    ]);
  }, 60000);

  test('the partial predicate is what made these indexes unusable, not their expression', async () => {
    // The trap this cleanup removes: they look like brand-search coverage. They are partial on
    // `attached_product_key IS NULL`, and the brand fastpath requires IS NOT NULL, so no
    // expression fix could ever have made them serve it. Asserted against the running code so it
    // cannot drift into being wrong.
    const fastpathSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'findProductsExternalSeedBrandFastpath.js'), 'utf8');
    expect(fastpathSource).toContain("AND attached_product_key IS NOT NULL");
    const res = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'external_product_seeds'
          AND indexname LIKE '%brand_search%'`,
      [schema]);
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) {
      expect(row.indexdef).toContain('attached_product_key IS NULL');
    }
  }, 60000);
});
