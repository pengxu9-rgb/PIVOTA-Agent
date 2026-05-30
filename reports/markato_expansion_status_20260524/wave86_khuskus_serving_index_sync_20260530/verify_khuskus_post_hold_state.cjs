#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../../../src/db');

const TARGET_IDS = [
  'ext_4dace0e8a2fe70b378b91c2c',
  'ext_290f05b3b8bfbfdb4e079d09',
  'ext_f27f918bac908cf6ba236b83',
  'ext_f86a3606bf6dc20fc810f99d',
  'ext_6ae70ce8a0cf2d0f8615d4dc',
];

async function main() {
  const res = await query(
    `
      SELECT
        cp.source_product_id AS external_product_id,
        ips.serving_eligible,
        ips.blocker_code,
        ips.blocker_detail,
        crt.serving_decision,
        crt.serving_reason_codes
      FROM catalog_products cp
      LEFT JOIN index_pipeline_state ips
        ON ips.content_key = cp.content_key
      LEFT JOIN catalog_row_trust crt
        ON crt.subject_type = 'product'
       AND crt.subject_key = cp.product_key
      WHERE cp.source_product_id = ANY($1::text[])
      ORDER BY cp.source_product_id
    `,
    [TARGET_IDS],
  );

  const out = {
    generated_at: new Date().toISOString(),
    target_count: TARGET_IDS.length,
    row_count: res.rows.length,
    held_count: res.rows.filter(
      (row) =>
        row.serving_eligible === false &&
        row.blocker_code === 'content_evidence_hold' &&
        row.serving_decision === 'blocked',
    ).length,
    rows: res.rows,
  };
  const outFile = path.join(__dirname, 'khuskus_post_hold_serving_state.json');
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
