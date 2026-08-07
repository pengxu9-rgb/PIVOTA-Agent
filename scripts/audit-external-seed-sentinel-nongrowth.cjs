#!/usr/bin/env node
'use strict';
/**
 * ADR-009 — sentinel non-growth audit (the data-side ratchet).
 *
 * The `merchant_id='external_seed'` bucket is a retiring legacy population: it
 * may only ever SHRINK. Growth means a writer somewhere is still minting the
 * sentinel — the exact failure that let the bucket refill ~1,693 rows between
 * the 2026-07-07 and 2026-07-27 censuses while everyone believed Path B was
 * fixed. This audit makes that class of regression page within a day instead
 * of surfacing in a quarterly census.
 *
 * Watermarks live in tests/fixtures/external_seed_sentinel_watermarks.json,
 * per lane, each with a mode:
 *   enforce — count above the watermark FAILS the run;
 *   report  — printed only (a lane whose writer is not yet fixed; flipping it
 *             to enforce is part of landing that writer's fix).
 * When a lane shrinks, lower its watermark in the same PR that reports the
 * shrink — the audit tells you when it is lowerable. Never raise a watermark
 * without an ADR-009 conversation.
 *
 * Read-only; safe against prod. Exits non-zero on any enforce-lane breach.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const WATERMARKS_PATH = path.join(__dirname, '../tests/fixtures/external_seed_sentinel_watermarks.json');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const watermarks = JSON.parse(fs.readFileSync(WATERMARKS_PATH, 'utf8'));

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const lanes = await client.query(`
      SELECT coalesce(source_system, '(null)') AS lane, count(*)::int AS n
      FROM catalog_products WHERE merchant_id = 'external_seed' GROUP BY 1
    `);
    const seeds = await client.query(
      'SELECT count(*)::int AS n FROM external_product_seeds WHERE seller_ref IS NULL',
    );

    const current = { seeds_missing_seller_ref: seeds.rows[0].n };
    for (const row of lanes.rows) current[`catalog_products:${row.lane}`] = row.n;

    const breaches = [];
    const lowerable = [];
    const report = [];
    for (const [lane, spec] of Object.entries(watermarks)) {
      const count = current[lane] || 0;
      const line = { lane, count, watermark: spec.watermark, mode: spec.mode };
      report.push(line);
      if (count > spec.watermark) {
        if (spec.mode === 'enforce') breaches.push(line);
        // report-mode growth is loud in the output but does not fail the run
      } else if (count < spec.watermark) {
        lowerable.push(line);
      }
    }
    // A lane appearing in prod that has no watermark at all is itself a breach:
    // a NEW writer minting the sentinel must never be silently absorbed.
    for (const [lane, count] of Object.entries(current)) {
      if (!(lane in watermarks) && count > 0 && lane.startsWith('catalog_products:')) {
        breaches.push({ lane, count, watermark: 0, mode: 'unregistered_lane' });
      }
    }

    console.log(JSON.stringify({ event: 'sentinel_nongrowth_audit', report, breaches, lowerable }, null, 2));
    if (lowerable.length) {
      console.log('watermarks are lowerable — ratchet them down in tests/fixtures/external_seed_sentinel_watermarks.json');
    }
    if (breaches.length) {
      console.error(`SENTINEL BUCKET GREW: ${breaches.map((b) => `${b.lane} ${b.count}>${b.watermark}`).join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
