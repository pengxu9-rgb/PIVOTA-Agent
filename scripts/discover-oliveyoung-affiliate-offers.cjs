#!/usr/bin/env node
'use strict';
/**
 * Fix Plan D · T4 — Olive Young affiliate-feed discovery (compliant 3P lane).
 *
 * Reads an affiliate-network product datafeed (NOT a crawl — OY ToS forbids
 * crawling), normalizes each record via the feed-format adapter seam
 * (src/services/oliveYoungAffiliateFeed.js), filters to safe/priced offers, and
 * emits a seed manifest identical in shape to the Ulta lane so the SAME sync +
 * resolve-first matcher (src/services/retailerOfferIdentity.js) collapses OY offers
 * onto existing D2C products.
 *
 * MODES
 *   --fixture <path>   Read a local feed file (dev/test). No credentials needed.
 *                      Defaults to fixtures/oliveyoung/affiliate_feed_sample.json.
 *   (live)             With OY_AFFILIATE_* env creds set, fetch OY_AFFILIATE_FEED_URL.
 *                      Without creds the lane FAILS GRACEFULLY (empty manifest,
 *                      status=missing_affiliate_credentials) — it never crawls and
 *                      never fabricates product data.
 *
 * Usage:
 *   node ./scripts/discover-oliveyoung-affiliate-offers.cjs --fixture --out reports/oy.json --manifest-out data/oy_manifest.json
 *   OY_AFFILIATE_NETWORK=... OY_AFFILIATE_FEED_URL=... OY_AFFILIATE_API_KEY=... node ./scripts/discover-oliveyoung-affiliate-offers.cjs
 *
 * See docs/oliveyoung_affiliate_feed_runbook.md for credential + feed-format detail.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeFeedRecord,
  parseFeed,
  hasAffiliateCredentials,
  isSafeOYOffer,
  buildSeedRowFromOYOffer,
} = require('../src/services/oliveYoungAffiliateFeed');
const { buildDiscoveredVia } = require('../src/services/seedProvenance');

const DEFAULT_FIXTURE = path.join(__dirname, '..', 'fixtures', 'oliveyoung', 'affiliate_feed_sample.json');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return !v || v.startsWith('--') ? fallback : v;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }
function asString(v) { return String(v == null ? '' : v).trim(); }
function resolveOut(v) { const t = asString(v); return !t ? '' : (path.isAbsolute(t) ? t : path.join(process.cwd(), t)); }
function parseDelimited(v) { return Array.from(new Set(asString(v).split(/[,\n]/g).map((s) => s.trim()).filter(Boolean))); }

async function loadFeedPayload({ fixturePath, useFixture, fetchImpl }) {
  if (useFixture) {
    const p = fixturePath || DEFAULT_FIXTURE;
    return { source: `fixture:${p}`, payload: fs.readFileSync(p, 'utf8'), status: 'ok' };
  }
  // LIVE mode — requires credentials. Never crawl, never fabricate.
  if (!hasAffiliateCredentials()) {
    return { source: 'live', payload: null, status: 'missing_affiliate_credentials' };
  }
  const feedUrl = asString(process.env.OY_AFFILIATE_FEED_URL);
  const apiKey = asString(process.env.OY_AFFILIATE_API_KEY || process.env.OY_AFFILIATE_TOKEN);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { source: feedUrl, payload: null, status: 'no_fetch_available' };
  try {
    const res = await doFetch(feedUrl, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(Number(process.env.OY_AFFILIATE_TIMEOUT_MS || 60000)),
    });
    if (!res.ok) return { source: feedUrl, payload: null, status: `feed_http_${res.status}` };
    return { source: feedUrl, payload: await res.text(), status: 'ok' };
  } catch (err) {
    return { source: feedUrl, payload: null, status: `feed_error:${String(err?.message || err)}` };
  }
}

async function run() {
  const market = (asString(argValue('market', 'US')) || 'US').toUpperCase();
  const useFixture = hasFlag('fixture') || Boolean(argValue('fixture'));
  const fixturePath = asString(argValue('fixture')) && !argValue('fixture').startsWith('--')
    ? resolveOut(argValue('fixture'))
    : DEFAULT_FIXTURE;
  const feedFormat = asString(argValue('format', 'auto')) || 'auto';
  const brandFilter = parseDelimited(argValue('brands')).map((b) => b.toLowerCase());
  const out = resolveOut(argValue('out'));
  const manifestOut = resolveOut(argValue('manifest-out'));

  const loaded = await loadFeedPayload({ fixturePath, useFixture });
  const rawRecords = loaded.payload ? parseFeed(loaded.payload, { format: feedFormat }) : [];

  const accepted = [];
  const rejected = [];
  for (const raw of rawRecords) {
    const offer = normalizeFeedRecord(raw, { market });
    if (brandFilter.length && !brandFilter.includes(asString(offer.brand).toLowerCase())) continue;
    if (!isSafeOYOffer(offer)) {
      rejected.push({ brand: offer.brand, title: offer.title, reason: 'unsafe_or_unpriced_offer' });
      continue;
    }
    const seedRow = buildSeedRowFromOYOffer(offer, { market, buildDiscoveredVia });
    accepted.push({ target_brand: offer.brand, extract_status: 'accepted_oliveyoung_affiliate_offer', seed_row: seedRow });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    source: 'oliveyoung_affiliate_feed_v1',
    channel: 'olive_young',
    market,
    feed_source: loaded.source,
    feed_status: loaded.status,
    item_count: accepted.length,
    items: accepted,
  };
  const report = {
    plan: 'fix_plan_D_T4_oliveyoung_affiliate_lane',
    generated_at: new Date().toISOString(),
    mode: useFixture ? 'fixture' : 'live',
    feed_status: loaded.status,
    feed_source: loaded.source,
    raw_records: rawRecords.length,
    accepted_seed_rows: accepted.length,
    rejected_count: rejected.length,
    rejected_sample: rejected.slice(0, 20),
    by_brand: Object.entries(
      accepted.reduce((acc, a) => { const b = a.target_brand || 'unknown'; acc[b] = (acc[b] || 0) + 1; return acc; }, {}),
    ).map(([brand, n]) => ({ brand, n })).sort((a, b) => b.n - a.n),
    manifest_path: manifestOut || null,
    note:
      loaded.status === 'missing_affiliate_credentials'
        ? 'No OY affiliate credentials configured — lane no-opped (no crawl, no fabricated data). Provision creds per docs/oliveyoung_affiliate_feed_runbook.md, or run with --fixture for dev/test.'
        : undefined,
  };

  if (manifestOut) { fs.mkdirSync(path.dirname(manifestOut), { recursive: true }); fs.writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); }
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // Graceful: missing creds is NOT an error exit — the coordinator can schedule it
  // to become live the moment creds land.
  process.exitCode = 0;
}

run().catch((err) => { process.stderr.write(`${err?.stack || err?.message || String(err)}\n`); process.exit(1); });
