const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

describe('apply_aurora_external_seed_creation_manifest', () => {
  test('merges preferred aliases into existing seed data without replacing product truth', () => {
    const { mergeSeedAliasData } = require('../../scripts/apply_aurora_external_seed_creation_manifest.cjs');
    const result = mergeSeedAliasData(
      {
        brand: 'Round Lab',
        title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
        search_aliases: ['Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++'],
        snapshot: {
          title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
          search_aliases: ['Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++'],
        },
      },
      {
        search_aliases: [
          'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
          'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
        ],
        authority_source: {
          matched_preferred_titles: ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
        },
        snapshot: {
          search_aliases: ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
          authority_source: {
            matched_preferred_titles: ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
          },
        },
      },
    );

    expect(result.changed).toBe(true);
    expect(result.nextSeedData.title).toBe('Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++');
    expect(result.nextSeedData.search_aliases).toEqual([
      'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    ]);
    expect(result.nextSeedData.snapshot.search_aliases).toEqual([
      'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    ]);
    expect(result.nextSeedData.authority_source.matched_preferred_titles).toEqual([
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    ]);
  });

  test('dry-run without database returns would_insert_unverified rows', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-seed-create-'));
    const inputPath = path.join(tempDir, 'manifest.json');
    const manifest = {
      generated_at: '2026-04-12T00:00:00.000Z',
      items: [
        {
          ingredient_id: null,
          ingredient_name: null,
          target_brand: 'The Inkey List',
          target_url: 'https://www.theinkeylist.com/products/niacinamide-serum',
          extract_status: 'brand_catalog_extract',
          seed_row: {
            seed_id: 'seed_test_the_inkey_list_niacinamide',
            external_product_id: 'ext_test_the_inkey_list_niacinamide',
            market: 'US',
            tool: 'creator_agents',
            destination_url: 'https://www.theinkeylist.com/products/niacinamide-serum',
            canonical_url: 'https://www.theinkeylist.com/products/niacinamide-serum',
            domain: 'www.theinkeylist.com',
            title: 'Niacinamide Serum',
            image_url: 'https://cdn.example.com/niacinamide.jpg',
            price_amount: 12,
            price_currency: 'USD',
            availability: 'in_stock',
            status: 'active',
            attached_product_key: null,
            requires_seed_correction: false,
            seed_data: {
              brand: 'The Inkey List',
              title: 'Niacinamide Serum',
              snapshot: {
                brand: 'The Inkey List',
                title: 'Niacinamide Serum',
              },
            },
          },
        },
      ],
    };
    fs.writeFileSync(inputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const raw = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'apply_aurora_external_seed_creation_manifest.cjs'),
        '--input',
        inputPath,
        '--dry-run',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: '',
        },
      },
    );
    const output = JSON.parse(raw);

    expect(output.summary).toEqual(
      expect.objectContaining({
        mode: 'dry_run',
        database_available: false,
        scanned: 1,
        would_insert_unverified: 1,
      }),
    );
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toEqual(
      expect.objectContaining({
        seed_id: 'seed_test_the_inkey_list_niacinamide',
        external_product_id: 'ext_test_the_inkey_list_niacinamide',
        status: 'would_insert_unverified',
      }),
    );
  });
});
