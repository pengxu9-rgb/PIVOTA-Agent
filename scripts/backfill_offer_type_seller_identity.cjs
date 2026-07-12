#!/usr/bin/env node
'use strict';
/**
 * Fix Plan C / T2 — backfill catalog_offers.offer_type + is_first_party from the
 * seller-identity rule (src/services/offerSellerIdentity.js).
 *
 *   node ./scripts/backfill_offer_type_seller_identity.cjs            # DRY-RUN (default): report only
 *   node ./scripts/backfill_offer_type_seller_identity.cjs --apply    # apply in set-based batches
 *
 * Scope: catalog_track='external_referral' only (the redirect/observed world). The
 * 6.7K internal_merchant first-party rows are OUT of scope and never touched.
 *
 * Policy (conservative, honest):
 *  - DEFINITE verdict (brand_direct | retailer) that differs from stored -> write it.
 *  - Downgrade a lane-guessed label to NULL ONLY when the row has real domain
 *    evidence that resolves to "unknown" AND the stored value was NOT independently
 *    confirmable. With zero domain evidence we KEEP the stored value (never destroy).
 *  - Audit trail written to offer_payload.offer_type_reclass_v1 = {old,new,rule,at}.
 *  - Suppressed (Plan E demo_retired) rows ARE relabelled for honesty but are tallied
 *    separately and excluded from the headline acceptance counts.
 *
 * Never prints secrets. Round-trip-bound proxy -> set-based UPDATE via unnest, batch 500.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { deriveOfferSellerIdentity } = require('../src/services/offerSellerIdentity');

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
const OUT_DIR = process.env.REPORT_DIR || '/tmp';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

function classifyRow(row) {
  const verdict = deriveOfferSellerIdentity({
    domain: row.domain,
    canonicalUrl: row.canonical_url,
    officialDomain: row.official_domain,
    brand: row.brand,
  });
  const oldType = row.old_offer_type == null ? null : String(row.old_offer_type);
  const oldFp = row.old_is_first_party === true;
  const hasDomainEvidence = !!verdict.evidence_domain;
  let newType;
  let newFp;
  let action;
  if (verdict.offer_type != null) {
    // Definite verdict.
    newType = verdict.offer_type;
    newFp = verdict.is_first_party;
    action = newType === oldType && newFp === oldFp ? 'noop_confirmed' : 'reclassify';
  } else if (!hasDomainEvidence) {
    // No evidence at all -> never destroy a stored value.
    newType = oldType;
    newFp = oldFp;
    action = 'kept_no_domain';
  } else {
    // Real domain, but it resolves to none of official/brand/retailer.
    //  - A stored 'retailer' here was a LANE GUESS (creator_agents -> retailer);
    //    with no positive seller evidence the honest value is NULL -> downgrade.
    //  - A stored 'brand_direct' is a POSITIVE first-party assertion (self-seed /
    //    brand crawl) that we may simply be unable to re-derive (e.g. i18n brand
    //    names like "セルフュージョンC" on cellfusionc.jp). Never destroy it.
    if (oldType === 'retailer') {
      newType = null;
      newFp = false;
      action = 'downgrade_unknown';
    } else {
      newType = oldType; // null stays null (noop); brand_direct is preserved
      newFp = oldFp;
      action = oldType == null ? 'noop_confirmed' : 'kept_brand_direct_unre_derivable';
    }
  }
  return { verdict, oldType, oldFp, newType, newFp, action };
}

function transitionKey(oldType, newType) {
  const o = oldType == null ? 'null' : oldType;
  const n = newType == null ? 'null' : newType;
  return `${o} -> ${n}`;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 25000,
    query_timeout: 300000,
  });
  await client.connect();

  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} scope=catalog_track=external_referral`);
  const res = await client.query(`
    SELECT
      o.offer_id,
      o.offer_type AS old_offer_type,
      o.is_first_party AS old_is_first_party,
      o.suppression_reason,
      lower(coalesce(nullif(o.offer_payload->>'domain',''), o.source_domain)) AS domain,
      coalesce(o.offer_payload->>'canonical_url', o.offer_payload->>'url', o.offer_payload->>'destination_url') AS canonical_url,
      coalesce(pil.official_domain, pil.strong_identity->>'official_domain', pil.soft_identity->>'official_domain') AS official_domain,
      coalesce(nullif(p.brand,''), p.product_payload->>'brand') AS brand
    FROM catalog_offers o
    JOIN catalog_products p ON p.product_key = o.product_key
    LEFT JOIN pdp_identity_listing pil
      ON pil.merchant_id = p.merchant_id AND pil.product_id = p.source_product_id
    WHERE o.catalog_track = 'external_referral'
  `);
  const rows = res.rows;
  console.log(`[backfill] fetched ${rows.length} external_referral offers`);

  const summary = {
    total: rows.length,
    by_action: {},
    by_rule: {},
    transitions: {},
    suppressed: { total: 0, reclassify: 0, downgrade: 0 },
    active: { total: 0, reclassify: 0, downgrade: 0, noop: 0, kept_no_domain: 0 },
  };
  const changes = []; // rows to write
  const csvLines = ['offer_id,suppressed,old_offer_type,new_offer_type,old_fp,new_fp,rule,action,evidence_domain,official_domain,brand'];

  for (const row of rows) {
    const c = classifyRow(row);
    const suppressed = row.suppression_reason != null;
    summary.by_action[c.action] = (summary.by_action[c.action] || 0) + 1;
    summary.by_rule[c.verdict.rule] = (summary.by_rule[c.verdict.rule] || 0) + 1;
    const isChange = c.action === 'reclassify' || c.action === 'downgrade_unknown';
    if (isChange) {
      summary.transitions[transitionKey(c.oldType, c.newType)] =
        (summary.transitions[transitionKey(c.oldType, c.newType)] || 0) + 1;
    }
    if (suppressed) {
      summary.suppressed.total += 1;
      if (c.action === 'reclassify') summary.suppressed.reclassify += 1;
      if (c.action === 'downgrade_unknown') summary.suppressed.downgrade += 1;
    } else {
      summary.active.total += 1;
      if (c.action === 'reclassify') summary.active.reclassify += 1;
      else if (c.action === 'downgrade_unknown') summary.active.downgrade += 1;
      else if (c.action === 'kept_no_domain') summary.active.kept_no_domain += 1;
      else summary.active.noop += 1;
    }
    if (isChange) {
      changes.push({
        offer_id: row.offer_id,
        old: c.oldType,
        new: c.newType,
        old_fp: c.oldFp,
        new_fp: c.newFp,
        rule: c.verdict.rule,
      });
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      csvLines.push([
        row.offer_id, suppressed, c.oldType, c.newType, c.oldFp, c.newFp,
        c.verdict.rule, c.action, c.verdict.evidence_domain, row.official_domain, row.brand,
      ].map(esc).join(','));
    }
  }

  const reportBase = path.join(OUT_DIR, `offer_type_reclass_${STAMP}`);
  fs.writeFileSync(`${reportBase}.summary.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(`${reportBase}.changes.csv`, csvLines.join('\n'));
  console.log('\n### SUMMARY');
  console.dir(summary, { depth: 6 });
  console.log(`\n[backfill] total proposed changes: ${changes.length}`);
  console.log(`[backfill] report: ${reportBase}.summary.json`);
  console.log(`[backfill] csv:    ${reportBase}.changes.csv`);

  if (!APPLY) {
    console.log('\n[backfill] DRY-RUN — no writes. Re-run with --apply to persist.');
    await client.end();
    return;
  }

  console.log(`\n[backfill] APPLYING ${changes.length} changes in batches of ${BATCH} ...`);
  const at = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < changes.length; i += BATCH) {
    const batch = changes.slice(i, i + BATCH);
    const ids = batch.map((c) => c.offer_id);
    const newTypes = batch.map((c) => c.new); // may contain nulls
    const newFps = batch.map((c) => c.new_fp);
    const reclass = batch.map((c) =>
      JSON.stringify({ old: c.old, new: c.new, rule: c.rule, at, backfill: 'offer_type_reclass_v1' }),
    );
    // Set-based UPDATE via unnest. offer_type is text (nullable); is_first_party bool.
    const r = await client.query(
      `
      UPDATE catalog_offers AS o
      SET offer_type = u.new_type,
          is_first_party = u.new_fp,
          offer_payload = jsonb_set(
            coalesce(o.offer_payload, '{}'::jsonb),
            '{offer_type_reclass_v1}',
            u.reclass::jsonb,
            true
          ),
          updated_at = now()
      FROM (
        SELECT * FROM unnest($1::text[], $2::text[], $3::bool[], $4::text[])
          AS t(offer_id, new_type, new_fp, reclass)
      ) AS u
      WHERE o.offer_id = u.offer_id
      `,
      [ids, newTypes, newFps, reclass],
    );
    written += r.rowCount || 0;
    console.log(`[backfill] batch ${Math.floor(i / BATCH) + 1}: wrote ${r.rowCount} (cum ${written})`);
  }
  console.log(`\n[backfill] APPLY complete. rows written: ${written}`);
  await client.end();
}

main().catch((e) => { console.error('BACKFILL_ERROR', e.message); process.exit(1); });
