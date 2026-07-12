#!/usr/bin/env node
'use strict';
/**
 * Fix Plan D · T3 — backfill `seed_data.discovered_via` where DERIVABLE only.
 *
 * Derivation precedence (never invents a channel):
 *   1. explicit ulta_discovery block / `ulta:` id / ulta.com host      -> 'ulta'
 *   2. evidence host matches a known retail channel (sephora/target/…)  -> that channel
 *   3. evidence host present but NOT a known retailer (a brand page)     -> 'brand_site'
 *   4. no usable evidence host                                          -> UNDETERMINED (skipped)
 *
 * Olive Young provenance is NEVER inferred: brands whose seeds resolve to
 * 'brand_site'/undetermined are reported as `founder_input_needed` so the operator
 * can supply which brands were discovered on Olive Young (T3 requirement).
 *
 * Read-only DRY-RUN by default. `--apply` writes. Set-based batch update only.
 *   railway run node ./scripts/backfill-seed-discovered-via.cjs
 *   railway run node ./scripts/backfill-seed-discovered-via.cjs --apply --out reports/pland_t3.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const {
  buildDiscoveredVia,
  inferChannelFromHost,
  hostFromUrl,
} = require('../src/services/seedProvenance');

const RETAILER_CHANNELS = new Set(['ulta', 'sephora', 'target', 'amazon', 'walmart', 'nordstrom', 'dermstore', 'olive_young', 'yesstyle']);
const BATCH = 500;

function hasFlag(n) { return process.argv.includes(`--${n}`); }
function argValue(n, f = '') { const i = process.argv.indexOf(`--${n}`); if (i === -1) return f; const v = process.argv[i + 1]; return !v || v.startsWith('--') ? f : v; }
function asObj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

function deriveChannel(row) {
  const sd = asObj(row.seed_data);
  const snap = asObj(sd.snapshot);
  const epid = String(row.external_product_id || '');
  const urls = [row.canonical_url, row.destination_url, sd.canonical_url, sd.destination_url, sd.external_redirect_url, snap.canonical_url]
    .map((u) => String(u || '')).filter(Boolean);
  const primaryUrl = urls[0] || '';
  // 1. explicit ulta signals
  if (sd.ulta_discovery || epid.startsWith('ulta:') || epid.startsWith('ulta-beauty:') || String(row.domain || '').toLowerCase().includes('ulta') || urls.some((u) => hostFromUrl(u) === 'ulta.com')) {
    return { channel: 'ulta', evidenceUrl: urls.find((u) => hostFromUrl(u) === 'ulta.com') || primaryUrl };
  }
  // 2. known retail channel by host
  for (const u of urls) {
    const ch = inferChannelFromHost(u);
    if (ch) return { channel: ch, evidenceUrl: u };
  }
  // 3. brand-owned page (a host that is not a known retailer)
  if (primaryUrl && hostFromUrl(primaryUrl)) return { channel: 'brand_site', evidenceUrl: primaryUrl };
  // 4. undetermined
  return null;
}

async function main() {
  const apply = hasFlag('apply');
  const outPath = argValue('out');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 300000 });
  await client.connect();

  const res = await client.query(`
    SELECT id, external_product_id, domain, canonical_url, destination_url, seed_data
    FROM external_product_seeds
    WHERE status = 'active'
      AND (seed_data->'discovered_via') IS NULL`);
  const rows = res.rows || [];

  const updates = []; // {id, dv}
  const byChannel = {};
  const undeterminedBrands = {};
  const brandSiteBrands = {};
  for (const row of rows) {
    const derived = deriveChannel(row);
    const brand = String(asObj(row.seed_data).brand || asObj(asObj(row.seed_data).snapshot).brand || '').trim() || 'unknown';
    if (!derived) {
      undeterminedBrands[brand] = (undeterminedBrands[brand] || 0) + 1;
      continue;
    }
    const dv = buildDiscoveredVia({ channel: derived.channel, evidenceUrl: derived.evidenceUrl });
    updates.push({ id: row.id, dv: JSON.stringify(dv) });
    byChannel[derived.channel] = (byChannel[derived.channel] || 0) + 1;
    if (derived.channel === 'brand_site') brandSiteBrands[brand] = (brandSiteBrands[brand] || 0) + 1;
  }

  let applied = { mode: apply ? 'apply' : 'dry_run', rows_updated: 0, apply_error: null };
  if (apply && updates.length) {
    try {
      for (let i = 0; i < updates.length; i += BATCH) {
        const chunk = updates.slice(i, i + BATCH);
        const ids = chunk.map((u) => u.id);
        const dvs = chunk.map((u) => u.dv);
        const r = await client.query(
          `
          UPDATE external_product_seeds s
          SET seed_data = CASE WHEN s.seed_data ? 'snapshot'
                THEN jsonb_set(jsonb_set(coalesce(s.seed_data,'{}'::jsonb), '{discovered_via}', d.dv::jsonb, true), '{snapshot,discovered_via}', d.dv::jsonb, true)
                ELSE jsonb_set(coalesce(s.seed_data,'{}'::jsonb), '{discovered_via}', d.dv::jsonb, true)
              END,
              updated_at = now()
          FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS dv) d
          WHERE s.id = d.id AND (s.seed_data->'discovered_via') IS NULL`,
          [ids, dvs],
        );
        applied.rows_updated += r.rowCount || 0;
      }
    } catch (err) {
      applied.apply_error = String(err?.message || err);
    }
  }

  // Founder-input request: brands whose D2C seeds have NO recorded external
  // discovery channel (brand_site or undetermined). The founder marks which of
  // these were discovered on Olive Young — we do NOT infer it.
  const founderInput = {};
  for (const [b, n] of Object.entries(brandSiteBrands)) founderInput[b] = (founderInput[b] || 0) + n;
  for (const [b, n] of Object.entries(undeterminedBrands)) founderInput[b] = (founderInput[b] || 0) + n;
  const founderList = Object.entries(founderInput)
    .filter(([b]) => b && b !== 'unknown')
    .map(([brand, seeds]) => ({ brand, seeds }))
    .sort((a, b) => b.seeds - a.seeds);

  const report = {
    plan: 'fix_plan_D_T3_backfill_discovered_via',
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    seeds_missing_discovered_via: rows.length,
    derivable_updates: updates.length,
    by_channel: Object.entries(byChannel).map(([channel, n]) => ({ channel, n })).sort((a, b) => b.n - a.n),
    undetermined_seeds: Object.values(undeterminedBrands).reduce((a, b) => a + b, 0),
    applied,
    founder_input_needed: {
      note: 'Brands whose seeds carry no external retail-channel provenance (brand_site/undetermined). Founder: mark which were DISCOVERED on Olive Young so we can stamp discovered_via.channel=olive_young with evidence. NOT inferred.',
      brand_count: founderList.length,
      brands: founderList.slice(0, 200),
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outPath) {
    const resolved = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, serialized, 'utf8');
  }
  await client.end();
}

main().catch((err) => { process.stderr.write(`${err?.stack || err?.message || String(err)}\n`); process.exit(1); });
