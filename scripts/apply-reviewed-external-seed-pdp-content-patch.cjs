#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const CONFIRM_TOKEN = 'APPLY_REVIEWED_EXTERNAL_SEED_PDP_CONTENT_PATCH';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const REVIEW_CONTRACT_VERSION = 'external_seed.reviewed_pdp_content_patch.v1';

const POLLUTED_COPY_RE =
  /\b(contact us|customer service|customer support|support center|support page|privacy policy|terms(?: and conditions)?|terms of use|shipping policy|return policy|about us|about jurlique|our farm|sustainability|brand ambassador program|blog|blogs|store locator|official|social highlights)\b/i;
const INGREDIENT_POLLUTION_RE =
  /\b(?:function|const\s+[a-z0-9_$]+\s*=|document\.|querySelector|MutationObserver|shadowRoot|monitorShadowContent|join_stories_generic_widget_integration|<\s*script\b|javascript:)\b/i;

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\\+u0000/gi, '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = text(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function readJson(filePath) {
  const normalized = text(filePath);
  if (!normalized) throw new Error('--manifest is required');
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
}

function digest(value) {
  return crypto.createHash('sha256').update(text(value)).digest('hex');
}

function sanitizeJson(value) {
  return JSON.stringify(value).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
}

function normalizeSection(section) {
  const item = asObject(section);
  const heading = text(item.heading || item.title || item.label);
  const body = text(item.body || item.content || item.text || item.value);
  if (!heading || !body) return null;
  return {
    ...item,
    heading,
    body,
  };
}

function sectionBody(section) {
  const item = asObject(section);
  return text(item.body || item.content || item.text || item.value);
}

function isPolluted(value) {
  return POLLUTED_COPY_RE.test(text(value));
}

function isIngredientPolluted(value) {
  const normalized = text(value);
  return isPolluted(normalized) || INGREDIENT_POLLUTION_RE.test(normalized);
}

function cleanSections(seedData, manifest) {
  const snapshot = asObject(seedData.snapshot);
  const existing = [
    ...asArray(seedData.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(seedData.details_sections),
    ...asArray(snapshot.details_sections),
  ];
  const manualSections = asArray(manifest.pdp_details_sections).map(normalizeSection).filter(Boolean);
  const seen = new Set();
  const cleaned = [];
  for (const section of [...manualSections, ...existing]) {
    const normalized = normalizeSection(section);
    if (!normalized) continue;
    const body = sectionBody(normalized);
    if (manifest.remove_polluted_detail_sections !== false && isPolluted(body)) continue;
    const key = `${text(normalized.heading).toLowerCase()}|${digest(body)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      ...normalized,
      source_origin: normalized.source_origin || 'reviewed_source_backed_pdp_content_patch',
      source_quality_status: normalized.source_quality_status || 'high',
    });
  }
  return cleaned.slice(0, 8);
}

function buildQualitySummary(seedData, fields, now, manifest) {
  const snapshot = asObject(seedData.snapshot);
  const quality = {
    ...asObject(snapshot.pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
  };
  const qualityKeyForField = (field) => {
    if (field === 'pdp_description_raw') return 'description_raw';
    if (field === 'pdp_ingredients_raw' || field === 'raw_ingredient_text_clean') return 'ingredients_raw';
    if (field === 'pdp_how_to_use_raw') return 'how_to_use_raw';
    if (field === 'pdp_details_sections') return 'details_sections';
    return field;
  };
  for (const field of fields) {
    quality[qualityKeyForField(field)] = {
      source_origin: 'reviewed_source_backed_pdp_content_patch',
      source_quality_status: 'high',
      source_kinds: uniq([
        manifest.source_kind || 'official_pdp_structured_section',
        manifest.description_source_kind,
      ]),
      source_url: text(manifest.source_url || manifest.canonical_url),
      reviewed_by: text(manifest.reviewed_by),
      reason: text(manifest.reason),
      updated_at: now,
    };
  }
  return quality;
}

function buildSnapshotContract(now) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'reviewed_source_backed_pdp_content_patch',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: now,
  };
}

function buildReviewContract(manifest, now, fields) {
  return {
    contract_version: REVIEW_CONTRACT_VERSION,
    review_state: 'assistant_reviewed',
    reviewed_by: text(manifest.reviewed_by),
    reviewed_at: now,
    reason: text(manifest.reason),
    evidence: text(manifest.evidence),
    source_url: text(manifest.source_url || manifest.canonical_url),
    source_kind: text(manifest.source_kind || 'official_pdp_structured_section'),
    patched_fields: fields,
  };
}

function readManifestEntries(raw) {
  const root = Array.isArray(raw) ? { entries: raw } : asObject(raw);
  const entries = asArray(root.entries || root.patches || root.rows);
  if (!entries.length) throw new Error('Manifest must contain entries[]');
  return entries.map((entry) => ({
    ...asObject(entry),
    external_product_id: text(entry.external_product_id),
    market: text(entry.market || root.market || 'US').toUpperCase(),
    reviewed_by: text(entry.reviewed_by || root.reviewed_by || 'codex_review'),
    reason: text(entry.reason || root.reason || 'reviewed_source_backed_pdp_content_patch'),
    evidence: text(entry.evidence || root.evidence),
    source_url: text(entry.source_url || entry.canonical_url),
    description: text(entry.description || entry.pdp_description_raw),
    pdp_how_to_use_raw: text(entry.pdp_how_to_use_raw || entry.how_to_use_raw || entry.how_to_use),
    pdp_ingredients_raw: text(
      entry.pdp_ingredients_raw || entry.raw_ingredient_text_clean || entry.ingredients_raw,
    ),
  }));
}

function validateEntry(entry) {
  const blockers = [];
  const patchableFields = [
    entry.description,
    entry.pdp_how_to_use_raw,
    entry.pdp_ingredients_raw,
    ...asArray(entry.pdp_details_sections).map((section) => sectionBody(section)),
  ].filter(Boolean);
  if (!entry.external_product_id) blockers.push('missing_external_product_id');
  if (!patchableFields.length) blockers.push('missing_patch_fields');
  if (entry.description) {
    if (entry.description.length < 60) blockers.push('description_too_short');
    if (isPolluted(entry.description)) blockers.push('description_polluted');
  }
  if (entry.pdp_how_to_use_raw) {
    if (entry.pdp_how_to_use_raw.length < 20) blockers.push('how_to_too_short');
    if (isPolluted(entry.pdp_how_to_use_raw)) blockers.push('how_to_polluted');
  }
  if (entry.pdp_ingredients_raw) {
    if (entry.pdp_ingredients_raw.length < 80) blockers.push('ingredients_too_short');
    if (isIngredientPolluted(entry.pdp_ingredients_raw)) blockers.push('ingredients_polluted');
    if (!/,/.test(entry.pdp_ingredients_raw)) blockers.push('ingredients_not_inci_like');
  }
  if (!entry.evidence || entry.evidence.length < 20) blockers.push('missing_review_evidence');
  if (!entry.reviewed_by) blockers.push('missing_reviewer');
  return blockers;
}

function buildNextSeedData(row, entry, now) {
  const seedData = JSON.parse(JSON.stringify(asObject(row.seed_data)));
  const snapshot = asObject(seedData.snapshot);
  seedData.snapshot = snapshot;
  const blockers = validateEntry(entry);
  if (blockers.length) {
    return { blocked: blockers, changed: false, seedData };
  }

  const cleanDescription = entry.description;
  const cleanHowTo = entry.pdp_how_to_use_raw;
  const cleanIngredients = entry.pdp_ingredients_raw;
  const sections = cleanSections(seedData, entry);
  const shouldPatchSections =
    asArray(entry.pdp_details_sections).length > 0 || entry.clean_existing_detail_sections === true;
  const fields = [];
  if (cleanDescription) fields.push('description', 'pdp_description_raw');
  if (cleanHowTo) fields.push('pdp_how_to_use_raw');
  if (shouldPatchSections && sections.length) fields.push('pdp_details_sections');
  if (cleanIngredients) fields.push('pdp_ingredients_raw', 'raw_ingredient_text_clean');

  if (cleanDescription) {
    seedData.description = cleanDescription;
    seedData.pdp_description_raw = cleanDescription;
    seedData.seed_description_origin = 'reviewed_source_backed_pdp_content_patch';
    snapshot.description = cleanDescription;
    snapshot.pdp_description_raw = cleanDescription;
    snapshot.seed_description_origin = 'reviewed_source_backed_pdp_content_patch';
  }

  if (cleanHowTo) {
    seedData.pdp_how_to_use_raw = cleanHowTo;
    snapshot.pdp_how_to_use_raw = cleanHowTo;
  }

  if (shouldPatchSections && sections.length) {
    seedData.pdp_details_sections = sections;
    snapshot.pdp_details_sections = sections;
  }

  if (cleanIngredients) {
    const patchIngredients = (target) => {
      if (!target || typeof target !== 'object') return;
      target.pdp_ingredients_raw = cleanIngredients;
      target.raw_ingredient_text_clean = cleanIngredients;
      target.inci_list = cleanIngredients;
      const ingredientIntel = asObject(target.ingredient_intel);
      target.ingredient_intel = {
        ...ingredientIntel,
        raw_ingredient_text_clean: cleanIngredients,
        inci_raw: cleanIngredients,
        inci_list: cleanIngredients,
      };
      delete target.ingredient_intel.inci_normalized;
      delete target.ingredient_intel.authoritative;
    };
    patchIngredients(seedData);
    patchIngredients(snapshot);
  }

  const quality = buildQualitySummary(seedData, fields, now, entry);
  seedData.pdp_field_quality_summary = quality;
  snapshot.pdp_field_quality_summary = quality;

  const contract = buildSnapshotContract(now);
  seedData.external_seed_snapshot_contract = {
    ...asObject(seedData.external_seed_snapshot_contract),
    ...contract,
  };
  snapshot.external_seed_snapshot_contract = {
    ...asObject(snapshot.external_seed_snapshot_contract),
    ...contract,
  };

  seedData.reviewed_pdp_content_patch_v1 = buildReviewContract(entry, now, fields);
  snapshot.reviewed_pdp_content_patch_v1 = seedData.reviewed_pdp_content_patch_v1;

  return {
    blocked: [],
    changed: sanitizeJson(seedData) !== sanitizeJson(row.seed_data || {}),
    seedData,
    fields,
  };
}

function buildServingPatch(seedData, fields = []) {
  const fieldSet = new Set(asArray(fields));
  const patch = {
    pdp_field_quality_summary: seedData.pdp_field_quality_summary,
    external_seed_snapshot_contract: seedData.external_seed_snapshot_contract,
    reviewed_pdp_content_patch_v1: seedData.reviewed_pdp_content_patch_v1,
  };
  if (fieldSet.has('description') || fieldSet.has('pdp_description_raw')) {
    patch.description = seedData.description;
    patch.pdp_description_raw = seedData.pdp_description_raw;
  }
  if (fieldSet.has('pdp_how_to_use_raw')) {
    patch.pdp_how_to_use_raw = seedData.pdp_how_to_use_raw;
  }
  if (fieldSet.has('pdp_details_sections')) {
    patch.pdp_details_sections = seedData.pdp_details_sections;
  }
  if (fieldSet.has('pdp_ingredients_raw') || fieldSet.has('raw_ingredient_text_clean')) {
    patch.pdp_ingredients_raw = seedData.pdp_ingredients_raw;
    patch.raw_ingredient_text_clean = seedData.raw_ingredient_text_clean;
    patch.inci_list = seedData.inci_list;
    patch.ingredient_intel = seedData.ingredient_intel;
  }
  return patch;
}

async function fetchRows(client, entries) {
  const ids = entries.map((entry) => entry.external_product_id);
  const res = await client.query(
    `
      SELECT id, external_product_id, market, status, title, canonical_url, destination_url,
             coalesce(seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
    `,
    [ids],
  );
  return new Map((res.rows || []).map((row) => [row.external_product_id, row]));
}

async function applyPlan(client, plan) {
  await client.query('BEGIN');
  try {
    await client.query(
      `
        UPDATE external_product_seeds
        SET seed_data = $2::jsonb,
            updated_at = NOW()
        WHERE external_product_id = $1
      `,
      [plan.external_product_id, sanitizeJson(plan.next_seed_data)],
    );
    const descriptionPatched =
      asArray(plan.patched_fields).includes('description') ||
      asArray(plan.patched_fields).includes('pdp_description_raw');
    const servingPatch = buildServingPatch(plan.next_seed_data, plan.patched_fields);
    const catalog = await client.query(
      `
        UPDATE catalog_products
        SET description = CASE WHEN $4::boolean THEN $2 ELSE description END,
            product_payload = COALESCE(product_payload, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
        WHERE merchant_id = 'external_seed'
          AND platform = 'external_seed'
          AND source_product_id = $1
      `,
      [plan.external_product_id, plan.next_seed_data.description || null, sanitizeJson(servingPatch), descriptionPatched],
    );
    const identity = await client.query(
      `
        UPDATE pdp_identity_listing
        SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE source_listing_ref = $1
      `,
      [`external_seed:${plan.external_product_id}`, sanitizeJson(servingPatch)],
    );
    await client.query('COMMIT');
    return {
      external_product_id: plan.external_product_id,
      seed_updates: 1,
      catalog_product_updates: Number(catalog.rowCount || 0),
      identity_updates: Number(identity.rowCount || 0),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function summarize(plans, applyResults) {
  return {
    scanned_rows: plans.length,
    missing_rows: plans.filter((plan) => plan.status === 'missing').length,
    blocked_rows: plans.filter((plan) => plan.status === 'blocked').length,
    change_candidates: plans.filter((plan) => plan.status === 'ready' && plan.changed).length,
    updated_rows: applyResults.length,
    catalog_product_updates: applyResults.reduce((sum, item) => sum + Number(item.catalog_product_updates || 0), 0),
    identity_updates: applyResults.reduce((sum, item) => sum + Number(item.identity_updates || 0), 0),
  };
}

async function main() {
  const manifestPath = argValue('manifest');
  const out = argValue('out');
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  const entries = readManifestEntries(readJson(manifestPath));
  const now = new Date().toISOString();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const rowsById = await fetchRows(client, entries);
    const plans = entries.map((entry) => {
      const row = rowsById.get(entry.external_product_id);
      if (!row) {
        return {
          external_product_id: entry.external_product_id,
          status: 'missing',
          changed: false,
          blockers: ['missing_external_seed'],
        };
      }
      if (row.status !== 'active') {
        return {
          external_product_id: entry.external_product_id,
          status: 'blocked',
          changed: false,
          blockers: [`seed_status_${row.status || 'unknown'}`],
        };
      }
      if (entry.market && text(row.market).toUpperCase() !== entry.market) {
        return {
          external_product_id: entry.external_product_id,
          status: 'blocked',
          changed: false,
          blockers: [`market_mismatch_${row.market || 'unknown'}`],
        };
      }
      const next = buildNextSeedData(row, entry, now);
      return {
        external_product_id: entry.external_product_id,
        seed_id: row.id,
        title: row.title,
        canonical_url: row.canonical_url || row.destination_url,
        status: next.blocked.length ? 'blocked' : 'ready',
        changed: next.changed,
        blockers: next.blocked,
        patched_fields: next.fields || [],
        before: {
          description: text(row.seed_data?.description || row.seed_data?.snapshot?.description),
          pdp_description_raw: text(row.seed_data?.pdp_description_raw || row.seed_data?.snapshot?.pdp_description_raw),
          pdp_ingredients_raw: text(row.seed_data?.pdp_ingredients_raw || row.seed_data?.snapshot?.pdp_ingredients_raw),
          pdp_how_to_use_raw: text(row.seed_data?.pdp_how_to_use_raw || row.seed_data?.snapshot?.pdp_how_to_use_raw),
          ingredients_polluted: isIngredientPolluted(
            row.seed_data?.pdp_ingredients_raw ||
              row.seed_data?.raw_ingredient_text_clean ||
              row.seed_data?.snapshot?.pdp_ingredients_raw ||
              row.seed_data?.snapshot?.raw_ingredient_text_clean,
          ),
          polluted_detail_section_count: [
            ...asArray(row.seed_data?.pdp_details_sections),
            ...asArray(row.seed_data?.snapshot?.pdp_details_sections),
          ].filter((section) => isPolluted(sectionBody(section))).length,
        },
        after: {
          description: next.seedData?.description || '',
          pdp_description_raw: next.seedData?.pdp_description_raw || '',
          pdp_how_to_use_raw: next.seedData?.pdp_how_to_use_raw || '',
          pdp_ingredients_raw: next.seedData?.pdp_ingredients_raw || '',
          ingredients_polluted: isIngredientPolluted(next.seedData?.pdp_ingredients_raw),
          detail_section_count: asArray(next.seedData?.pdp_details_sections).length,
          polluted_detail_section_count: asArray(next.seedData?.pdp_details_sections).filter((section) =>
            isPolluted(sectionBody(section)),
          ).length,
        },
        next_seed_data: next.seedData,
      };
    });
    const applyResults = [];
    if (write) {
      for (const plan of plans) {
        if (plan.status !== 'ready' || !plan.changed) continue;
        // eslint-disable-next-line no-await-in-loop
        applyResults.push(await applyPlan(client, plan));
      }
    }
    const report = {
      generated_at: now,
      dry_run: !write,
      manifest: manifestPath,
      summary: summarize(plans, applyResults),
      apply_results: applyResults,
      plans: plans.map(({ next_seed_data: _nextSeedData, ...plan }) => plan),
    };
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  _internals: {
    buildNextSeedData,
    buildServingPatch,
    readManifestEntries,
    validateEntry,
  },
};
