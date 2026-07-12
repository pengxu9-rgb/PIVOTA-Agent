'use strict';
/**
 * Issue #1784 repair — pdp_identity_listing rows whose official_domain /
 * strong_identity.official_domain / soft_identity.official_domain is a KNOWN
 * RETAILER host (ulta.com, dermstore.com, …). Root cause: extractOfficialUrl
 * treated the seed's retailer PDP URL as "official"; fixed in
 * src/services/pdpIdentityGraph.js (this script requires the FIXED code).
 *
 * Per affected row:
 *   1. Rebuild the listing from its stored source_payload via
 *      buildIdentityListingFromProduct — with the fix, retailer URLs no longer
 *      mint official_url/official_domain, and matched_by_rule/confidence/review
 *      state re-derive honestly.
 *   2. Where the SAME brand has sibling listings whose official_domain is a
 *      non-retailer host that the brand plausibly owns (brandOwnsDomain) and
 *      that dominates the brand's non-retailer domains (>= MIN_SIBLINGS rows),
 *      set the official_domain COLUMN to that brand domain (provenance stamped
 *      in source_meta.official_domain_rederived). strong/soft identity stay
 *      URL-evidence-honest (no official_domain), official_url stays NULL.
 *   3. Preserve keys other tables reference (sellable_item_group_id,
 *      product_line_id, review_family_id) and preserve matched_by_rule /
 *      match_basis / identity_status for 'reviewed_multi_offer_merge' rows —
 *      the merge review grouped offers; that decision is not invalidated by
 *      correcting the official domain.
 *   4. Never touch source_payload or live_read_enabled.
 *
 * Dry-run by default. Run:
 *   railway run node ./scripts/repairRetailerOfficialDomain.cjs           # report only
 *   railway run node ./scripts/repairRetailerOfficialDomain.cjs --apply  # write
 */

const { Client } = require('pg');
const {
  knownRetailerDomains,
  isKnownRetailer,
  brandOwnsDomain,
} = require('../src/services/offerSellerIdentity');
const { buildIdentityListingFromProduct } = require('../src/services/pdpIdentityGraph');

const APPLY = process.argv.includes('--apply');
const MIN_SIBLINGS = 3;

const EFF_DOMAIN_SQL = `
  regexp_replace(
    lower(coalesce(
      nullif(trim(l.official_domain), ''),
      nullif(trim(l.strong_identity->>'official_domain'), ''),
      nullif(trim(l.soft_identity->>'official_domain'), '')
    )),
    '^www\\.', ''
  )
`;

const ANY_FIELD_RETAILER_SQL = (col) => `
  EXISTS (
    SELECT 1 FROM unnest($1::text[]) AS r(base)
    WHERE regexp_replace(lower(coalesce(nullif(trim(${col}), ''), '')), '^www\\.', '') = r.base
       OR regexp_replace(lower(coalesce(nullif(trim(${col}), ''), '')), '^www\\.', '') LIKE '%.' || r.base
  )
`;

function stripKeys(obj, keys) {
  const out = { ...(obj || {}) };
  for (const k of keys) delete out[k];
  return out;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  const retailers = knownRetailerDomains();

  try {
    const affected = await client.query(
      `
      SELECT l.*
      FROM pdp_identity_listing l
      WHERE ${ANY_FIELD_RETAILER_SQL('l.official_domain')}
         OR ${ANY_FIELD_RETAILER_SQL(`l.strong_identity->>'official_domain'`)}
         OR ${ANY_FIELD_RETAILER_SQL(`l.soft_identity->>'official_domain'`)}
      ORDER BY l.brand_norm, l.source_listing_ref
      `,
      [retailers],
    );
    console.log(`affected rows (any field retailer): ${affected.rows.length}`);

    // Brand -> dominant non-retailer official domain among sibling listings.
    const brands = [...new Set(affected.rows.map((r) => r.brand_norm).filter(Boolean))];
    const siblings = await client.query(
      `
      SELECT l.brand_norm, ${EFF_DOMAIN_SQL} AS eff_domain, count(*) AS n
      FROM pdp_identity_listing l
      WHERE l.brand_norm = ANY($2::text[])
        AND ${EFF_DOMAIN_SQL} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS r(base)
          WHERE ${EFF_DOMAIN_SQL} = r.base OR ${EFF_DOMAIN_SQL} LIKE '%.' || r.base
        )
      GROUP BY 1, 2
      ORDER BY 1, n DESC
      `,
      [retailers, brands],
    );
    const brandDomain = new Map();
    for (const row of siblings.rows) {
      if (brandDomain.has(row.brand_norm)) continue; // first = dominant (ORDER BY n DESC)
      const n = Number(row.n);
      if (n >= MIN_SIBLINGS && brandOwnsDomain(row.brand_norm, row.eff_domain)) {
        brandDomain.set(row.brand_norm, { domain: row.eff_domain, siblings: n });
      }
    }
    console.log('brand -> re-derived official domain:');
    for (const [b, v] of brandDomain) console.log(`  ${b} -> ${v.domain} (${v.siblings} siblings)`);
    for (const b of brands) {
      if (!brandDomain.has(b)) console.log(`  ${b} -> (none; official_domain will be NULL)`);
    }

    let updated = 0;
    let skipped = 0;
    for (const row of affected.rows) {
      const rebuilt = buildIdentityListingFromProduct({
        merchantId: row.merchant_id,
        productId: row.product_id,
        product: row.source_payload,
        sourceKind: row.source_kind,
        sourceMeta: row.source_meta,
      });
      if (!rebuilt) {
        console.log(`SKIP (rebuild returned null): ${row.source_listing_ref}`);
        skipped += 1;
        continue;
      }
      if (rebuilt.official_domain && isKnownRetailer(rebuilt.official_domain)) {
        console.log(
          `SKIP (rebuilt official_domain still retailer — is the pdpIdentityGraph fix in this working tree?): ${row.source_listing_ref}`,
        );
        skipped += 1;
        continue;
      }

      const rederived = row.brand_norm ? brandDomain.get(row.brand_norm) : null;
      const officialDomain = rebuilt.official_domain || (rederived ? rederived.domain : null);
      const officialUrl = rebuilt.official_url || null;
      // strong/soft identity must stay retailer-free even if rebuild kept other keys.
      const strong = stripKeys(rebuilt.strong_identity, []);
      const soft = stripKeys(rebuilt.soft_identity, []);
      for (const obj of [strong, soft]) {
        if (obj.official_domain && isKnownRetailer(obj.official_domain)) {
          delete obj.official_domain;
          delete obj.official_url;
          delete obj.official_handle;
        }
      }

      const preserveReviewedMerge = row.matched_by_rule === 'reviewed_multi_offer_merge';
      const matchedByRule = preserveReviewedMerge ? row.matched_by_rule : rebuilt.matched_by_rule;
      const matchBasis = preserveReviewedMerge ? row.match_basis : rebuilt.match_basis;
      const identityStatus = preserveReviewedMerge ? row.identity_status : rebuilt.identity_status;
      const reviewRequired = preserveReviewedMerge ? row.review_required : rebuilt.review_required;
      const reviewReasonCodes = preserveReviewedMerge
        ? row.review_reason_codes
        : rebuilt.review_reason_codes;

      console.log(
        `${APPLY ? 'FIX' : 'DRY'}: ${row.source_listing_ref} | ${row.brand_norm} | ` +
          `official_domain ${row.official_domain} -> ${officialDomain} | ` +
          `rule ${row.matched_by_rule} -> ${matchedByRule} | ` +
          `status ${row.identity_status} -> ${identityStatus} | ` +
          `conf ${row.identity_confidence} -> ${rebuilt.identity_confidence}`,
      );

      if (!APPLY) continue;
      await client.query(
        `
        UPDATE pdp_identity_listing SET
          strong_identity = $2::jsonb,
          soft_identity = $3::jsonb,
          official_url = $4,
          official_domain = $5,
          matched_by_rule = $6,
          match_basis = $7::jsonb,
          identity_status = $8,
          identity_confidence = $9,
          review_required = $10,
          review_reason_codes = $11::jsonb,
          updated_at = now()
        WHERE source_listing_ref = $1
        `,
        [
          row.source_listing_ref,
          JSON.stringify(strong),
          JSON.stringify(soft),
          officialUrl,
          officialDomain,
          matchedByRule,
          JSON.stringify(matchBasis || []),
          identityStatus,
          rebuilt.identity_confidence,
          reviewRequired === true,
          JSON.stringify(reviewReasonCodes || []),
        ],
      );
      updated += 1;
    }

    console.log(`\ndone. mode=${APPLY ? 'APPLY' : 'DRY-RUN'} updated=${updated} skipped=${skipped} of ${affected.rows.length}`);

    if (APPLY) {
      const residual = await client.query(
        `
        SELECT count(*) AS n
        FROM pdp_identity_listing l
        WHERE ${ANY_FIELD_RETAILER_SQL('l.official_domain')}
           OR ${ANY_FIELD_RETAILER_SQL(`l.strong_identity->>'official_domain'`)}
           OR ${ANY_FIELD_RETAILER_SQL(`l.soft_identity->>'official_domain'`)}
        `,
        [retailers],
      );
      console.log(`residual rows with retailer official_domain: ${residual.rows[0].n}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('repair failed:', err);
  process.exit(1);
});
