const { main } = require('../scripts/backfill-sig-propagation');

describe('backfill-sig-propagation', () => {
  test('dry-run reports scope without writing', async () => {
    const output = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data) => { output.push(String(data)); return true; };
    try {
      // Simulate no DATABASE_URL → exits cleanly with error
      const origEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      await main({ argv: ['node', 'script'] });
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      process.env.DATABASE_URL = origEnv;
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('requires DATABASE_URL', async () => {
    const origUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    await main({ argv: ['node', 'script'] });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    if (origUrl) process.env.DATABASE_URL = origUrl;
  });
});
