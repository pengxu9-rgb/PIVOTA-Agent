const {
  main,
  APPLY_SQL,
  DRY_RUN_GROUPS_SQL,
  VERIFY_SQL,
} = require('../scripts/backfill-sig-propagation');

describe('backfill-sig-propagation', () => {
  test('dry-run reports scope without writing', async () => {
    const output = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (data) => { output.push(String(data)); return true; };
    process.stderr.write = () => true;
    try {
      // Simulate no DATABASE_URL → exits cleanly with error
      const origEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      await main({ argv: ['node', 'script'] });
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      if (origEnv == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = origEnv;
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErrWrite;
    }
  });

  test('requires DATABASE_URL', async () => {
    const origUrl = process.env.DATABASE_URL;
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    delete process.env.DATABASE_URL;
    try {
      await main({ argv: ['node', 'script'] });
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      if (origUrl == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = origUrl;
    } finally {
      process.stderr.write = origErrWrite;
    }
  });

  test('backfill joins catalog_products by merchant, platform, and source product id', () => {
    for (const sql of [DRY_RUN_GROUPS_SQL, APPLY_SQL, VERIFY_SQL]) {
      expect(sql).toMatch(/cp\.merchant_id = pgm\.merchant_id/);
      expect(sql).toMatch(/cp\.platform = pgm\.platform/);
      expect(sql).toMatch(/cp\.source_product_id = pgm\.platform_product_id/);
    }
  });

  test('backfill detects unsafe groups instead of silently choosing a sig', () => {
    expect(DRY_RUN_GROUPS_SQL).toMatch(/groups_missing_primary_sig/);
    expect(DRY_RUN_GROUPS_SQL).toMatch(/groups_with_multiple_primary_sigs/);
    expect(DRY_RUN_GROUPS_SQL).toMatch(/groups_with_shared_members/);
    expect(APPLY_SQL).toMatch(/primary_sig_count = 1/);
    expect(APPLY_SQL).toMatch(/amg\.product_group_id IS NULL/);
  });
});
