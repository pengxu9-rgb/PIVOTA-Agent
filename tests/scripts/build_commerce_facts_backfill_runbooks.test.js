const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRunbooks,
  slugify,
} = require('../../scripts/build-commerce-facts-backfill-runbooks.cjs');

describe('build-commerce-facts-backfill-runbooks', () => {
  test('slugify normalizes brand names for file naming', () => {
    expect(slugify('LANEIGE US')).toBe('laneige-us');
    expect(slugify('Beauty of Joseon')).toBe('beauty-of-joseon');
  });

  test('builds operator-ready runbooks from backlog entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-facts-runbooks-'));
    const results = buildRunbooks(
      {
        entries: [
          {
            brand: 'Anua',
            market: 'US',
            item_count: 2,
            gate_pass_count: 2,
            would_insert_unverified: 2,
            matched_preferred_titles: ['Heartleaf 80% Moisture Soothing Ampoule'],
            targets_file: '/tmp/anua_targets.txt',
            targets: [
              {
                external_product_id: 'ext_anua_1',
                title: 'Heartleaf 80% Moisture Soothing Ampoule',
                price_currency: 'USD',
                availability: 'in_stock',
              },
            ],
            recommended_commands: {
              dry_run_by_external_ids: 'dry-run-cmd',
              apply_by_external_ids: 'apply-cmd',
            },
          },
        ],
      },
      tmpDir,
    );

    expect(results).toHaveLength(1);
    expect(fs.existsSync(results[0].file)).toBe(true);
    expect(path.basename(results[0].file)).toBe(
      'anua_us_commerce_facts_seed_backfill_runbook_20260501.json',
    );

    const runbook = JSON.parse(fs.readFileSync(results[0].file, 'utf8'));
    expect(runbook.target_scope.brand).toBe('Anua');
    expect(runbook.phase_1_seed_backfill_dry_run.command).toBe('dry-run-cmd');
    expect(runbook.phase_2_seed_backfill_apply.command).toBe('apply-cmd');
    expect(runbook.phase_4_live_postcheck.pages[0].page).toBe(
      'https://agent.pivota.cc/products/ext_anua_1',
    );
  });
});
