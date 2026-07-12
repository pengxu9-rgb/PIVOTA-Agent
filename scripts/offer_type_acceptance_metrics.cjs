#!/usr/bin/env node
'use strict';
/* Fix Plan C — acceptance metrics (read-only). Excludes Plan E demo_retired_2026_07
 * rows from every headline count. Run: railway run node ./scripts/offer_type_acceptance_metrics.cjs */
const { Client } = require('pg');
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 300000 });
  await client.connect();
  const q = async (label, sql) => { const r = await client.query(sql); console.log(`\n### ${label}`); console.dir(r.rows, { depth: 6, maxArrayLength: 200 }); return r.rows; };
  const NS = `suppression_reason IS NULL`; // non-suppressed only

  await q('offer_type distribution — external_referral, non-suppressed',
    `SELECT offer_type, count(*)::int n FROM catalog_offers
     WHERE catalog_track='external_referral' AND ${NS} GROUP BY 1 ORDER BY n DESC`);

  await q('offer_type x is_first_party — external_referral, non-suppressed',
    `SELECT offer_type, is_first_party, count(*)::int n FROM catalog_offers
     WHERE catalog_track='external_referral' AND ${NS} GROUP BY 1,2 ORDER BY n DESC`);

  await q('ACCEPTANCE: retailer offers whose domain matches product official_domain (MUST be 0)',
    `WITH o AS (
       SELECT lower(coalesce(nullif(co.offer_payload->>'domain',''), co.source_domain)) dom,
              lower(coalesce(pil.official_domain, pil.strong_identity->>'official_domain', pil.soft_identity->>'official_domain')) offdom
       FROM catalog_offers co
       JOIN catalog_products p ON p.product_key=co.product_key
       LEFT JOIN pdp_identity_listing pil ON pil.merchant_id=p.merchant_id AND pil.product_id=p.source_product_id
       WHERE co.offer_type='retailer' AND co.${NS}
     )
     SELECT count(*) FILTER (WHERE offdom IS NOT NULL AND dom IS NOT NULL AND
        (dom=offdom OR dom LIKE '%.'||offdom OR offdom LIKE '%.'||dom))::int retailer_on_own_domain
     FROM o`);

  await q('retailer offers by evidence domain (non-suppressed) — top 30',
    `SELECT lower(coalesce(nullif(offer_payload->>'domain',''), source_domain)) dom, count(*)::int n
     FROM catalog_offers WHERE offer_type='retailer' AND ${NS}
     GROUP BY 1 ORDER BY n DESC LIMIT 30`);

  await q('GENUINE multi-retailer baseline (Plan D): content_keys with >=2 DISTINCT retailer domains',
    `WITH r AS (
        SELECT p.content_key,
               lower(coalesce(nullif(o.offer_payload->>'domain',''), o.source_domain)) dom
        FROM catalog_offers o JOIN catalog_products p ON p.product_key=o.product_key
        WHERE o.offer_type='retailer' AND o.${NS} AND p.content_key IS NOT NULL
     )
     SELECT count(*)::int content_keys_2plus_retailers FROM (
        SELECT content_key FROM r WHERE dom IS NOT NULL GROUP BY content_key HAVING count(DISTINCT dom)>=2
     ) z`);

  await q('Broader multi-source baseline: content_keys with >=2 DISTINCT real domains (any offer_type, non-suppressed)',
    `WITH d AS (
        SELECT p.content_key,
               lower(coalesce(nullif(o.offer_payload->>'domain',''), o.source_domain)) dom
        FROM catalog_offers o JOIN catalog_products p ON p.product_key=o.product_key
        WHERE o.${NS} AND p.content_key IS NOT NULL
     )
     SELECT count(*)::int content_keys_2plus_domains FROM (
        SELECT content_key FROM d WHERE dom IS NOT NULL GROUP BY content_key HAVING count(DISTINCT dom)>=2
     ) z`);

  await q('reclass audit-trail written (offer_payload.offer_type_reclass_v1 present)',
    `SELECT count(*) FILTER (WHERE offer_payload ? 'offer_type_reclass_v1')::int with_audit_trail,
            count(*)::int external_referral_total
     FROM catalog_offers WHERE catalog_track='external_referral'`);

  await q('sanity: internal_merchant offers untouched (offer_type/is_first_party unchanged)',
    `SELECT offer_type, is_first_party, count(*)::int n FROM catalog_offers
     WHERE catalog_track='internal_merchant' GROUP BY 1,2 ORDER BY n DESC`);

  await client.end();
}
main().catch((e) => { console.error('METRICS_ERROR', e.message); process.exit(1); });
