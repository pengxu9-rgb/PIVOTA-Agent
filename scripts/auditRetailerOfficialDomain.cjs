'use strict';
/**
 * Issue #1784 investigation — pdp_identity_listing rows whose official_domain
 * (or strong/soft identity official_domain) points at a KNOWN RETAILER host
 * instead of the brand's own domain. Read-only audit: counts + samples so we
 * can pick the right repair per cohort before touching data.
 *
 * Run: railway run node ./scripts/auditRetailerOfficialDomain.cjs
 */

const { Client } = require('pg');
const { knownRetailerDomains } = require('./offerSellerIdentity.js');

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

const RETAILER_MATCH_SQL = `
  EXISTS (
    SELECT 1 FROM unnest($1::text[]) AS r(base)
    WHERE ${EFF_DOMAIN_SQL} = r.base
       OR ${EFF_DOMAIN_SQL} LIKE '%.' || r.base
  )
`;

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  const retailers = knownRetailerDomains();

  try {
    const summary = await client.query(
      `
      SELECT
        ${EFF_DOMAIN_SQL} AS eff_domain,
        l.brand_norm,
        l.matched_by_rule,
        l.source_kind,
        l.identity_status,
        count(*) AS n
      FROM pdp_identity_listing l
      WHERE ${RETAILER_MATCH_SQL}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY n DESC, 1, 2
      `,
      [retailers],
    );
    console.log('=== COHORT SUMMARY (eff_domain / brand / rule / source_kind / status / n) ===');
    for (const r of summary.rows) {
      console.log(
        `${r.eff_domain} | ${r.brand_norm} | ${r.matched_by_rule} | ${r.source_kind} | ${r.identity_status} | ${r.n}`,
      );
    }
    const total = summary.rows.reduce((s, r) => s + Number(r.n), 0);
    console.log(`TOTAL AFFECTED ROWS: ${total}`);

    const fieldBreakdown = await client.query(
      `
      SELECT
        (nullif(trim(l.official_domain), '') IS NOT NULL) AS has_col,
        (nullif(trim(l.strong_identity->>'official_domain'), '') IS NOT NULL) AS has_strong,
        (nullif(trim(l.soft_identity->>'official_domain'), '') IS NOT NULL) AS has_soft,
        count(*) AS n
      FROM pdp_identity_listing l
      WHERE ${RETAILER_MATCH_SQL}
      GROUP BY 1, 2, 3
      ORDER BY n DESC
      `,
      [retailers],
    );
    console.log('\n=== WHICH FIELDS CARRY THE RETAILER DOMAIN (col/strong/soft/n) ===');
    for (const r of fieldBreakdown.rows) {
      console.log(`col=${r.has_col} strong=${r.has_strong} soft=${r.has_soft} | ${r.n}`);
    }

    const samples = await client.query(
      `
      SELECT
        l.source_listing_ref,
        l.merchant_id,
        l.product_id,
        l.brand_norm,
        l.matched_by_rule,
        l.source_kind,
        l.identity_status,
        l.identity_confidence,
        l.official_domain,
        l.official_url,
        l.strong_identity->>'official_domain' AS strong_dom,
        l.soft_identity->>'official_domain' AS soft_dom,
        left(l.title_norm, 60) AS title_norm,
        l.updated_at
      FROM pdp_identity_listing l
      WHERE ${RETAILER_MATCH_SQL}
      ORDER BY l.brand_norm, l.updated_at DESC
      LIMIT 80
      `,
      [retailers],
    );
    console.log('\n=== SAMPLE ROWS ===');
    for (const r of samples.rows) {
      console.log(JSON.stringify(r));
    }

    // For the dominant brand cohorts: does the SAME brand have listings with a
    // legitimate (non-retailer) official_domain we could re-derive from?
    const brandAlt = await client.query(
      `
      WITH bad_brands AS (
        SELECT DISTINCT l.brand_norm
        FROM pdp_identity_listing l
        WHERE ${RETAILER_MATCH_SQL} AND l.brand_norm IS NOT NULL
      )
      SELECT
        l.brand_norm,
        ${EFF_DOMAIN_SQL} AS eff_domain,
        count(*) AS n
      FROM pdp_identity_listing l
      JOIN bad_brands b ON b.brand_norm = l.brand_norm
      WHERE ${EFF_DOMAIN_SQL} IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1, n DESC
      `,
      [retailers],
    );
    console.log('\n=== ALL DOMAINS SEEN PER AFFECTED BRAND (brand / domain / n) ===');
    for (const r of brandAlt.rows) {
      console.log(`${r.brand_norm} | ${r.eff_domain} | ${r.n}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
