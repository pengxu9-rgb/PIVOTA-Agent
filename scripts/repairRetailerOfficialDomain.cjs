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
 *      state re-derive honestly. A listing approved ONLY by `official_url_route`
 *      on a retailer page (its sellable group was a hash of the retailer URL)
 *      becomes review_required: that approval was never earned, and a full
 *      identity re-derive would demote it the same way.
 *   2. Apply the ACTIVE pdp_identity_override rows exactly as the real backfill
 *      does (applyIdentityOverrides), so a manual force_review_required /
 *      approve_live_read decision is never undone by the rebuild.
 *   3. HOLD every row whose status would go review_required -> approved: it is left
 *      untouched unless --allow-promotions is passed. A promotion is the one change
 *      this repair can make that grants serving eligibility, so it needs a human look
 *      at the row (its review_reason_codes are printed).
 *   4. Where the SAME brand has sibling listings whose official_domain is a
 *      non-retailer host that the brand plausibly owns (brandOwnsDomain) and
 *      that dominates the brand's non-retailer domains (>= MIN_SIBLINGS rows),
 *      set the official_domain COLUMN to that brand domain. strong/soft identity
 *      stay URL-evidence-honest (no official_domain), official_url stays NULL.
 *      Provenance is the per-row line this script prints (from -> to, and the
 *      sibling count behind a re-derived domain): KEEP THE APPLY JOB'S LOG.
 *      pdp_identity_listing has no source_meta column to stamp it in, and a later
 *      full identity re-derive (admin backfill, a non --only-uncovered run) resets
 *      official_domain from the rebuild, i.e. to NULL for these rows.
 *   5. Preserve keys other tables reference (sellable_item_group_id,
 *      product_line_id, review_family_id) and preserve matched_by_rule /
 *      match_basis / identity_status for 'reviewed_multi_offer_merge' rows —
 *      the merge review grouped offers; that decision is not invalidated by
 *      correcting the official domain.
 *   6. Never touch source_payload or live_read_enabled.
 *   7. With --apply, recompute catalog_row_trust for every touched row
 *      (upsertCatalogRowTrustForSourceListingRefs — the same refresh an override
 *      write triggers), so serving follows the identity change now instead of up
 *      to 6h later on the next trust cron. --no-trust-refresh opts out.
 *
 * The dry run also reports SERVING IMPACT, predicted with the trust cron's own code: every
 * catalog row a planned listing decides is loaded through catalogRowTrustUpserter's join and
 * run through catalogTrustPolicy.deriveTrust twice -- as it stands, and with the planned
 * identity fields -- so overrides (an active force_exact_group keeps a row public whatever
 * the listing status), exemptions and every other gate are exactly the ones the refresh
 * applies. It also lists rows whose STORED trust already differs from a recompute: the
 * refresh changes those regardless of the repair (2026-09-27: one listing went public that way).
 *
 * Dry-run by default:
 *   node ./scripts/repairRetailerOfficialDomain.cjs                      # report only
 *   node ./scripts/repairRetailerOfficialDomain.cjs --apply              # write (promotions held)
 *   node ./scripts/repairRetailerOfficialDomain.cjs --apply --allow-promotions
 *
 * Prod Postgres is VPC-only: run this from a one-off job inside the prod VPC with
 * DATABASE_URL set, never from a laptop.
 * --apply WRITES PROD ROWS: it needs the operator's explicit go on a fresh dry-run, every time.
 */

const {
  knownRetailerDomains,
  isKnownRetailer,
  brandOwnsDomain,
} = require('../src/services/offerSellerIdentity');
const {
  buildIdentityListingFromProduct,
  _internals: { applyIdentityOverrides },
} = require('../src/services/pdpIdentityGraph');

const MIN_SIBLINGS = 3;

function parseArgs(argv = []) {
  const apply = argv.includes('--apply');
  return {
    apply,
    allowPromotions: argv.includes('--allow-promotions'),
    trustRefresh: apply && !argv.includes('--no-trust-refresh'),
  };
}

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

// Every catalog row a listing ref serves through, with its current trust decision and the seed's kind.
// Same two resolution arms as catalogRowTrustUpserter.upsertCatalogRowTrustForSourceListingRefs.
const SERVING_SQL = `
  SELECT pil.source_listing_ref AS ref, pil.live_read_enabled, pil.merchant_id,
         k.product_key, crt.serving_decision, eps.seed_kind
  FROM pdp_identity_listing pil
  LEFT JOIN LATERAL (
    SELECT cp.product_key FROM catalog_products cp
    WHERE cp.merchant_id = pil.merchant_id AND cp.source_product_id = pil.product_id
    UNION
    SELECT cp.product_key FROM external_product_seeds eps2
    JOIN catalog_products cp
      ON cp.product_key = eps2.attached_product_key
     AND cp.source_system = 'catalog_enrichment_agent_v1'
     AND cp.merchant_id = pil.merchant_id
    WHERE eps2.external_product_id = pil.product_id
  ) k ON TRUE
  LEFT JOIN catalog_row_trust crt ON crt.product_key = k.product_key
  LEFT JOIN external_product_seeds eps ON eps.external_product_id = pil.product_id
  WHERE pil.source_listing_ref = ANY($1::text[])
`;

function looksLikeRelationMissing(err) {
  return err && (err.code === '42P01' || /relation .* does not exist/i.test(String(err.message || '')));
}

// Pure: what this repair would do to one affected row.
function planRow({ row, rebuilt, overrides = [], brandDomain = new Map(), allowPromotions = false }) {
  const ref = row.source_listing_ref;
  if (!rebuilt) return { ref, kind: 'skip', reason: 'rebuild returned null' };
  if (rebuilt.source_listing_ref && rebuilt.source_listing_ref !== ref) {
    return { ref, kind: 'skip', reason: `rebuild produced a different ref (${rebuilt.source_listing_ref})` };
  }
  if (rebuilt.official_domain && isKnownRetailer(rebuilt.official_domain)) {
    return { ref, kind: 'skip', reason: 'rebuilt official_domain still retailer — is the pdpIdentityGraph fix in this tree?' };
  }

  const matching = overrides.filter((o) => {
    const payloadRef = o && o.payload && typeof o.payload === 'object' ? o.payload.source_listing_ref : null;
    return o && (o.source_listing_ref === ref || payloadRef === ref);
  });
  const withOverrides = applyIdentityOverrides({ ...rebuilt, source_listing_ref: ref }, matching);

  const rederived = row.brand_norm ? brandDomain.get(row.brand_norm) : null;
  const officialDomain = withOverrides.official_domain || (rederived ? rederived.domain : null);
  const strong = { ...(withOverrides.strong_identity || {}) };
  const soft = { ...(withOverrides.soft_identity || {}) };
  for (const obj of [strong, soft]) {
    if (obj.official_domain && isKnownRetailer(obj.official_domain)) {
      delete obj.official_domain;
      delete obj.official_url;
      delete obj.official_handle;
    }
  }

  const preserveReviewedMerge = row.matched_by_rule === 'reviewed_multi_offer_merge';
  const pick = (field) => (preserveReviewedMerge ? row[field] : withOverrides[field]);
  const fields = {
    strong_identity: strong,
    soft_identity: soft,
    official_url: withOverrides.official_url || null,
    official_domain: officialDomain,
    matched_by_rule: pick('matched_by_rule'),
    match_basis: pick('match_basis') || [],
    identity_status: pick('identity_status'),
    identity_confidence: preserveReviewedMerge ? row.identity_confidence : withOverrides.identity_confidence,
    review_required: pick('review_required') === true,
    review_reason_codes: pick('review_reason_codes') || [],
  };
  const transition = { from: row.identity_status, to: fields.identity_status };
  const plan = {
    ref,
    brand: row.brand_norm || null,
    transition,
    fields,
    overrides: matching.map((o) => o.action_type),
    rederived_domain: rederived ? rederived.domain : null,
    rederived_siblings: rederived ? rederived.siblings : null,
    previous: {
      official_domain: row.official_domain,
      matched_by_rule: row.matched_by_rule,
      identity_confidence: row.identity_confidence,
      review_reason_codes: row.review_reason_codes || [],
    },
  };
  const isPromotion = transition.from !== 'approved' && transition.to === 'approved';
  if (isPromotion && !allowPromotions) return { ...plan, kind: 'hold', reason: 'promotion held (pass --allow-promotions)' };
  return { ...plan, kind: 'update', promotion: isPromotion };
}

const QUARANTINE_SQL = `
  SELECT quarantine_id, match_type, match_value, state, expires_at
  FROM catalog_source_quarantine
  WHERE state = 'active' AND (expires_at IS NULL OR expires_at > now())
`;

// What serving does for each planned listing, before and after, decided by the trust cron's own
// code rather than a restatement of it: the 2026-09-26 predictor read "trust-public or live_read"
// and missed the override arm, so 15 of its 18 predicted changes never happened. Returns
// Map<ref, [{ product_key, live_read, stored, before, after, override }]>. A catalog row whose
// identity join lands on a DIFFERENT listing is not this plan's to decide and is left out.
async function predictServing({ client, plans, now = new Date(), upserter, deriveTrust }) {
  const { PRODUCT_JOIN_SQL, rowToPolicyInputs } = upserter || require('../src/services/catalogRowTrustUpserter');
  const derive = deriveTrust || require('../src/services/catalogTrustPolicy').deriveTrust;
  const planByRef = new Map(plans.filter((p) => p.kind === 'update').map((p) => [p.ref, p]));
  const out = new Map();
  if (!planByRef.size) return out;
  const keyed = await client.query(SERVING_SQL, [[...planByRef.keys()]]);
  const stored = new Map(keyed.rows.filter((r) => r.product_key).map((r) => [r.product_key, r.serving_decision || null]));
  if (!stored.size) return out;
  const rows = (await client.query(`${PRODUCT_JOIN_SQL}  WHERE cp.product_key = ANY($1::text[])\n`, [[...stored.keys()]])).rows;
  const quarantines = (await client.query(QUARANTINE_SQL)).rows;
  for (const row of rows) {
    const plan = planByRef.get(row.pil_source_listing_ref);
    if (!plan) continue;
    const before = derive(rowToPolicyInputs(row, quarantines, now));
    const inputs = rowToPolicyInputs(row, quarantines, now);
    if (inputs.identity) {
      inputs.identity = { ...inputs.identity, identity_status: plan.fields.identity_status,
        identity_confidence: plan.fields.identity_confidence, review_required: plan.fields.review_required };
    }
    const after = derive(inputs);
    const list = out.get(plan.ref) || [];
    list.push({ product_key: row.product_key, live_read: row.live_read_enabled === true,
      stored: stored.get(row.product_key) ?? null, before: before.serving_decision, after: after.serving_decision,
      override: row.override_id ? row.override_action_type : null });
    out.set(plan.ref, list);
  }
  return out;
}

// Pure: the dry-run report.
function summarize(plans, predictions = new Map()) {
  const transitions = {};
  for (const p of plans) {
    const key = p.kind === 'skip' ? `skip: ${p.reason}` : `${p.kind} ${p.transition.from} -> ${p.transition.to}`;
    transitions[key] = (transitions[key] || 0) + 1;
  }
  const demotions = plans.filter((p) => p.kind === 'update' && p.transition.from === 'approved' && p.transition.to !== 'approved');
  const table = new Map();
  let changing = 0;
  for (const p of demotions) {
    const pred = predictions.get(p.ref) || [];
    const liveRead = pred.some((x) => x.live_read);
    const changes = pred.some((x) => x.before !== x.after);
    const publicNow = pred.some((x) => x.before === 'public');
    const heldByOverride = pred.some((x) => x.before === 'public' && x.after === 'public' && x.override);
    if (changes) changing += 1;
    const key = `${p.brand || '(no brand)'}|${liveRead}`;
    const cell = table.get(key) || { brand: p.brand || '(no brand)', live_read: liveRead,
      demoted: 0, serving_changes: 0, public_now: 0, stays_public_by_override: 0 };
    cell.demoted += 1;
    if (changes) cell.serving_changes += 1;
    if (publicNow) cell.public_now += 1;
    if (heldByOverride) cell.stays_public_by_override += 1;
    table.set(key, cell);
  }
  // Any planned listing (not only demotions) whose stored trust already differs from a recompute,
  // and any that ends up public when it is not public today.
  const stale = []; const newlyPublic = [];
  for (const [ref, pred] of predictions) {
    for (const x of pred) {
      if (x.stored !== x.before) stale.push({ ref, product_key: x.product_key, stored: x.stored, recomputed: x.before });
      if (x.after === 'public' && x.stored !== 'public') newlyPublic.push({ ref, product_key: x.product_key, override: x.override });
    }
  }
  const promotions = plans.filter((p) => p.kind === 'hold' || (p.kind === 'update' && p.promotion)).map((p) => ({
    ref: p.ref, brand: p.brand, kind: p.kind,
    previous_review_reason_codes: p.previous.review_reason_codes, active_overrides: p.overrides,
  }));
  return {
    transitions,
    demotions: demotions.length,
    demotions_changing_serving: changing,
    stale_trust: stale,
    newly_public: newlyPublic,
    demotion_table: [...table.values()].sort((a, b) => b.serving_changes - a.serving_changes || b.demoted - a.demoted || a.brand.localeCompare(b.brand)),
    promotions,
  };
}

function printReport(report, log) {
  log('\n=== transitions ===');
  for (const [k, n] of Object.entries(report.transitions).sort()) log(`  ${String(n).padStart(5)}  ${k}`);
  log(`\n=== demotions (approved -> review_required): ${report.demotions}; serving actually changes for ${report.demotions_changing_serving} ===`);
  log('  (predicted with catalogTrustPolicy.deriveTrust on the trust cron\'s own join: overrides and exemptions included)');
  log('  brand | live_read_enabled | demoted | serving_changes | public_now | stays_public_by_override');
  for (const c of report.demotion_table) {
    log(`  ${c.brand} | ${c.live_read} | ${c.demoted} | ${c.serving_changes} | ${c.public_now} | ${c.stays_public_by_override}`);
  }
  log(`\n=== stored trust differs from a recompute (the refresh changes these regardless of the repair): ${report.stale_trust.length} ===`);
  for (const x of report.stale_trust) log(`  ${x.ref} | ${x.product_key} | stored ${x.stored} -> recomputed ${x.recomputed}`);
  log(`\n=== ends up public but is not public today: ${report.newly_public.length} ===`);
  for (const x of report.newly_public) log(`  ${x.ref} | ${x.product_key}${x.override ? ` | override ${x.override}` : ''}`);
  log(`\n=== promotions (review_required -> approved): ${report.promotions.length} ===`);
  for (const p of report.promotions) {
    log(`  ${p.kind.toUpperCase()} ${p.ref} | ${p.brand} | previous review_reason_codes=${JSON.stringify(p.previous_review_reason_codes)} | active overrides=${JSON.stringify(p.active_overrides)}`);
  }
}

async function run({ client, apply = false, allowPromotions = false, trustRefresh = false, log = console.log, refreshTrust, upserter, deriveTrust }) {
  const retailers = knownRetailerDomains();
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
  log(`mode=${apply ? 'APPLY' : 'DRY-RUN'} allow_promotions=${allowPromotions} trust_refresh=${trustRefresh}`);
  log(`affected rows (any field retailer): ${affected.rows.length}`);

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
  log('brand -> re-derived official domain:');
  for (const [b, v] of brandDomain) log(`  ${b} -> ${v.domain} (${v.siblings} siblings)`);
  for (const b of brands) if (!brandDomain.has(b)) log(`  ${b} -> (none; official_domain will be NULL)`);

  let overrides = [];
  try {
    overrides = (await client.query('SELECT * FROM pdp_identity_override WHERE active = true ORDER BY created_at DESC NULLS LAST')).rows;
  } catch (err) {
    if (!looksLikeRelationMissing(err)) throw err;
  }
  log(`active identity overrides loaded: ${overrides.length}`);

  const plans = affected.rows.map((row) => planRow({
    row,
    rebuilt: buildIdentityListingFromProduct({
      merchantId: row.merchant_id,
      productId: row.product_id,
      product: row.source_payload,
      sourceKind: row.source_kind,
      // pdp_identity_listing has no source_meta column. That only affects live_read eligibility,
      // which this script never writes; identity_status / rule / confidence do not read it.
      sourceMeta: {},
    }),
    overrides,
    brandDomain,
    allowPromotions,
  }));

  let predictions = new Map();
  try {
    predictions = await predictServing({ client, plans, upserter, deriveTrust });
  } catch (err) {
    log(`serving impact unavailable: ${String(err.message || err).slice(0, 200)}`);
    predictions = new Map();
  }

  for (const p of plans) {
    if (p.kind === 'skip') { log(`SKIP (${p.reason}): ${p.ref}`); continue; }
    log(
      `${p.kind === 'hold' ? 'HOLD' : apply ? 'FIX' : 'DRY'}: ${p.ref} | ${p.brand} | ` +
        `official_domain ${p.previous.official_domain} -> ${p.fields.official_domain}` +
        `${p.rederived_domain ? ` (re-derived from ${p.rederived_siblings} siblings)` : ''} | ` +
        `rule ${p.previous.matched_by_rule} -> ${p.fields.matched_by_rule} | ` +
        `status ${p.transition.from} -> ${p.transition.to} | ` +
        `conf ${p.previous.identity_confidence} -> ${p.fields.identity_confidence}` +
        `${p.overrides.length ? ` | overrides ${JSON.stringify(p.overrides)}` : ''}`,
    );
  }
  const report = summarize(plans, predictions);
  printReport(report, log);

  let updated = 0;
  const touched = [];
  if (apply) {
    for (const p of plans) {
      if (p.kind !== 'update') continue;
      const f = p.fields;
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
        [p.ref, JSON.stringify(f.strong_identity), JSON.stringify(f.soft_identity), f.official_url, f.official_domain,
          f.matched_by_rule, JSON.stringify(f.match_basis), f.identity_status, f.identity_confidence,
          f.review_required, JSON.stringify(f.review_reason_codes)],
      );
      updated += 1;
      touched.push(p.ref);
    }
  }
  const held = plans.filter((p) => p.kind === 'hold').length;
  const skipped = plans.filter((p) => p.kind === 'skip').length;
  log(`\ndone. mode=${apply ? 'APPLY' : 'DRY-RUN'} updated=${updated} held=${held} skipped=${skipped} of ${affected.rows.length}`);

  let trustRows = null;
  if (apply && trustRefresh && touched.length) {
    trustRows = await refreshTrust(client, touched);
    log(`catalog_row_trust recomputed for ${touched.length} touched listings: ${trustRows} catalog rows evaluated (a row whose verdict is unchanged is not rewritten)`);
  } else if (apply && touched.length) {
    log('catalog_row_trust NOT recomputed (--no-trust-refresh): serving follows on the next trust cron (up to 6h)');
  }

  if (apply) {
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
    log(`residual rows with retailer official_domain: ${residual.rows[0].n} (held promotions and skips stay until handled)`);
  }
  return { report, predictions, updated, held, skipped, touched, trustRows };
}

async function main() {
  const { Client } = require('pg');
  const { upsertCatalogRowTrustForSourceListingRefs } = require('../src/services/catalogRowTrustUpserter');
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  try {
    await run({ client, ...args, refreshTrust: upsertCatalogRowTrustForSourceListingRefs });
  } finally {
    await client.end();
  }
  // Run as a Cloud Run one-off, the last lines (the promotions list, `done.`) were lost to log ingestion
  // lag on 2026-09-27; a pause before exit lets the log pipeline take them.
  await new Promise((r) => setTimeout(r, Number(process.env.REPAIR_TAIL_PAUSE_MS ?? 30000)));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('repair failed:', err);
    process.exit(1);
  });
}

module.exports = { parseArgs, planRow, predictServing, summarize, run, SERVING_SQL };
