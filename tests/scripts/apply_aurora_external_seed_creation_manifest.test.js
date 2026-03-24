const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

describe('apply_aurora_external_seed_creation_manifest', () => {
  test('dry-run without DATABASE_URL uses unverified path instead of throwing promise-shape errors', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-create-manifest-'));
    const inputPath = path.join(tmpRoot, 'manifest.json');
    const outPath = path.join(tmpRoot, 'out.json');
    fs.writeFileSync(
      inputPath,
      `${JSON.stringify(
        {
          generated_at: '2026-03-24T00:00:00.000Z',
          item_count: 1,
          items: [
            {
              ingredient_id: null,
              ingredient_name: null,
              target_brand: 'The Formularx',
              target_url: 'https://theformularx.com/products/barrier-relief-moisturizer',
              extract_status: 'usable',
              seed_row: {
                seed_id: 'eps_test_seed',
                external_product_id: 'ext_test_product',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://theformularx.com/products/barrier-relief-moisturizer',
                canonical_url: 'https://theformularx.com/products/barrier-relief-moisturizer',
                domain: 'theformularx.com',
                title: 'Barrier Relief Lightweight Ceramide  Moisturizer with Niacinamide',
                image_url: 'https://cdn.shopify.com/test.png',
                price_amount: 594,
                price_currency: 'USD',
                availability: 'in_stock',
                status: 'active',
                seed_data: {
                  title: 'Barrier Relief Lightweight Ceramide  Moisturizer with Niacinamide',
                  canonical_url: 'https://theformularx.com/products/barrier-relief-moisturizer',
                  destination_url: 'https://theformularx.com/products/barrier-relief-moisturizer',
                },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const stdout = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'apply_aurora_external_seed_creation_manifest.cjs'),
        '--input',
        inputPath,
        '--dry-run',
        '--out',
        outPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: '',
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const doc = JSON.parse(stdout);
    expect(doc.summary).toMatchObject({
      mode: 'dry_run',
      database_available: false,
      scanned: 1,
      would_insert_unverified: 1,
      invalid: 0,
    });
    expect(fs.existsSync(outPath)).toBe(true);
  });
});
