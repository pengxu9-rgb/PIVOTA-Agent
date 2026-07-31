#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY audit: does the cross-merchant merge tool's anchor agree with the
 * canonical election?
 *
 * scripts/map-and-merge-pdp-entity-resolution.js rewrites
 * pdp_identity_listing.sellable_item_group_id — the key checkoutHandoffResolver,
 * acpFeedSource, discoveryFeed, RecommendationEngine, productEntityIndexFeed and
 * catalogEntityResolution all read. If its anchor is not the row that holds the
 * public URL (content_canonical_election), a merge moves the entity onto a page
 * we do not advertise.
 *
 * THE CONTROL SET IS THE POINT. Cross-merchant content_keys already resolving to
 * ONE sellable_item_group_id are correct today, so the tool must be a NO-OP on
 * them. Measured 2026-07-31 BEFORE the election-aware anchor: 43 of 83 would
 * have been rewritten, several onto rows that are trust-'shadow' or 'blocked'.
 * After: 0.
 *
 * Writes nothing. Exits non-zero if the control set disagrees OR is empty — an
 * empty control set is a gate that asserts nothing, which is how the first cut
 * of this script "passed" (node-postgres returns count() as a STRING, so
 * `sig_groups === 1` was never true).
 *
 *   PGURL=postgres://... node scripts/audit-merge-anchor-vs-election.cjs
 */

const { Client } = require('pg');
const { pickPrimaryMember } = require('./map-and-merge-pdp-entity-resolution.js');

const SQL = `
WITH x AS (
  SELECT cp.content_key FROM catalog_products cp
  WHERE cp.suppressed_at IS NULL AND cp.content_key IS NOT NULL
  GROUP BY cp.content_key
  HAVING count(*)>1 AND count(DISTINCT coalesce(nullif(cp.source_domain,''),'?'))>1),
grp AS (
  SELECT cp.content_key, count(DISTINCT pil.sellable_item_group_id) AS sig_groups
  FROM x JOIN catalog_products cp ON cp.content_key=x.content_key AND cp.suppressed_at IS NULL
  LEFT JOIN pdp_identity_listing pil ON pil.product_id=cp.source_product_id
  GROUP BY cp.content_key)
SELECT cp.content_key, cp.product_key, cp.pivota_signature_id,
       cp.pivota_signature_minted_at, cp.pdp_lifecycle_stage, cp.source_domain,
       COALESCE(pgm.is_primary,false) AS is_primary,
       pil.sellable_item_group_id,
       cce.canonical_sig_id AS elected_canonical_sig_id,
       grp.sig_groups, crt.serving_decision
FROM grp
JOIN catalog_products cp ON cp.content_key=grp.content_key AND cp.suppressed_at IS NULL
LEFT JOIN pdp_identity_listing pil ON pil.product_id=cp.source_product_id
LEFT JOIN product_group_members pgm
  ON pgm.merchant_id=cp.merchant_id AND pgm.platform=cp.platform
 AND pgm.platform_product_id=cp.source_product_id
LEFT JOIN content_canonical_election cce ON cce.content_key=cp.content_key
LEFT JOIN catalog_row_trust crt ON crt.subject_type='product' AND crt.subject_key=cp.product_key`;

(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 60000, query_timeout: 240000, statement_timeout: 240000 });
  await c.connect();
  const { rows } = await c.query(SQL);
  const byCk = new Map();
  for (const r of rows) {
    if (!byCk.has(r.content_key)) byCk.set(r.content_key, []);
    byCk.get(r.content_key).push(r);
  }
  const audit = (pred, label) => {
    let agree = 0, dis = 0, none = 0; const bad = [];
    for (const [ck, rws] of byCk) {
      if (!pred(rws[0])) continue;
      const elected = rws.map(r => r.elected_canonical_sig_id).find(Boolean);
      if (!elected) { none++; continue; }
      const w = pickPrimaryMember(rws);
      if (w && w.pivota_signature_id === elected) agree++;
      else { dis++; bad.push([ck, w]); }
    }
    console.log(`### ${label}`);
    console.log(`   anchor == elected canonical : ${agree}`);
    console.log(`   DISAGREE                    : ${dis}`);
    console.log(`   no election (fallback path) : ${none}`);
    for (const [ck, w] of bad.slice(0, 6))
      console.log(`     ${ck.slice(0,24)} -> ${w && w.source_domain} trust=${w && w.serving_decision}`);
    return dis;
  };
  const d1 = audit(r => Number(r.sig_groups) > 1, 'FRAGMENTED 20 — merge targets');
  console.log('');
  const d2 = audit(r => Number(r.sig_groups) === 1, 'CONTROL 83 — must be a no-op');
  const ctrlSize = [...byCk.values()].filter(v => Number(v[0].sig_groups) === 1).length;
  console.log(`\n### GATE: control size = ${ctrlSize} (must be > 0), ` +
              `control disagreements = ${d2} (must be 0), fragmented = ${d1}`);
  if (ctrlSize === 0) console.log('   FAIL: control set is EMPTY — the gate asserted nothing');
  await c.end();
  process.exit(ctrlSize > 0 && d2 === 0 ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(2); });
