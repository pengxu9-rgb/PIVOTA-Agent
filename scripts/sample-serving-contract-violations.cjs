#!/usr/bin/env node
'use strict';

const { closeReadOnlyPool, queryReadOnly } = require('./lib/read-only-db.cjs');
const { parseCommonArgs, printRows, usage } = require('./lib/pdp-sampling-cli.cjs');

const SCRIPT = 'sample-serving-contract-violations.cjs';
const DESCRIPTION = 'Samples index_pipeline_state.serving_eligible rows that fail a live PDP gate.';

const QUERY = `
WITH gated AS (
  SELECT
    cp.pivota_signature_id,
    ips.content_key,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN NOT (
        COALESCE(pil.identity_status, '') = 'approved'
        AND COALESCE(pil.live_read_enabled, false) IS TRUE
        AND COALESCE(pil.review_required, false) IS NOT TRUE
      ) THEN 'identity' END,
      CASE WHEN NOT EXISTS (
        SELECT 1
        FROM catalog_offers co
        WHERE co.product_key = cp.product_key
          AND co.list_price > 0
      ) THEN 'offer' END,
      CASE WHEN COALESCE(LENGTH(NULLIF(BTRIM(COALESCE(apv.description, cp.description)), '')), 0) < 50 THEN 'content' END,
      CASE WHEN NULLIF(BTRIM(COALESCE(apv.image_url, cp.image_url, cp.product_payload->>'image_url')), '') IS NULL THEN 'image' END
    ], NULL) AS gate_failures,
    COALESCE(pil.identity_status, 'missing') AS identity_state,
    EXISTS (
      SELECT 1
      FROM catalog_offers co
      WHERE co.product_key = cp.product_key
        AND co.list_price > 0
    ) AS has_positive_offer,
    NULLIF(BTRIM(COALESCE(apv.image_url, cp.image_url, cp.product_payload->>'image_url')), '') IS NOT NULL AS has_image,
    COALESCE(LENGTH(NULLIF(BTRIM(COALESCE(apv.description, cp.description)), '')), 0) >= 50 AS has_description,
    ips.last_consolidated_at AS last_serving_eligible_set_at
  FROM index_pipeline_state ips
  JOIN catalog_products cp ON cp.content_key = ips.content_key
  LEFT JOIN agent_pdp_view apv ON apv.content_key = ips.content_key
  LEFT JOIN pdp_identity_listing pil
    ON pil.merchant_id = cp.merchant_id
   AND pil.product_id = cp.source_product_id
  WHERE ips.serving_eligible IS TRUE
    AND cp.source_system = 'external_product_seeds_mirror_v1'
)
SELECT
  pivota_signature_id,
  content_key,
  gate_failures,
  identity_state,
  has_positive_offer,
  has_image,
  has_description,
  last_serving_eligible_set_at
FROM gated
WHERE cardinality(gate_failures) > 0
ORDER BY last_serving_eligible_set_at DESC NULLS LAST, content_key
LIMIT $1
`.trim();

async function main() {
  const args = parseCommonArgs();
  if (args.help) {
    process.stdout.write(`${usage(SCRIPT, DESCRIPTION)}\n`);
    return;
  }
  const result = await queryReadOnly(QUERY, [args.limit]);
  printRows(result.rows || [], args);
}

main()
  .catch((err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeReadOnlyPool().catch(() => {}));
