#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require(path.join(process.cwd(), 'src/db'));

const CONFIRM_TOKEN = 'APPLY_WAVE15_7JOURNEYS_PUBLIC_DESCRIPTION_REPAIR';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readManifest(filePath) {
  const manifest = JSON.parse(fs.readFileSync(resolvePath(filePath), 'utf8'));
  return Array.isArray(manifest.items) ? manifest.items : [];
}

function splitIngredients(raw) {
  return text(raw)
    .replace(/(\d),(\d)(?=-[A-Za-z])/g, '$1__INCI_COMMA__$2')
    .replace(/\s*\*\s*$/g, '')
    .split(/\s*,\s*/)
    .map((item) =>
      item
        .replace(/__INCI_COMMA__/g, ',')
        .replace(/^[*+\s]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((item) => item.length >= 2)
    .filter((item) => !/^ingredients?$/i.test(item));
}

function ingredientPreview(ingredients, limit = 5) {
  return asArray(ingredients).slice(0, limit).join(', ');
}

function buildIncomingRows(items) {
  return items
    .map((item) => asObject(item.seed_row))
    .filter((row) => text(row.external_product_id) && asObject(row.seed_data).brand === '7Journeys');
}

function buildPublicDescription(row, seedData) {
  const productType = text(seedData.product_type || asObject(seedData.snapshot).product_type).toLowerCase() || 'skincare product';
  const ingredients = asArray(seedData.ingredients_inci);
  const formulaPreview = ingredientPreview(ingredients);
  const formulaSentence = formulaPreview
    ? ` The source ingredient list includes ${formulaPreview}.`
    : '';
  return (
    `7Journeys ${text(row.title)} is a source-backed ${productType} from the brand-owned US-localized product page.` +
    `${formulaSentence} Price, availability, images, use instructions, details, and formula fields were captured from the same source page.`
  );
}

function refreshIngredients(seedData) {
  const raw = text(seedData.pdp_ingredients_raw || asObject(seedData.ingredient_intel).inci_raw || seedData.raw_ingredient_text_clean);
  if (!raw) return seedData;
  const ingredients = splitIngredients(raw);
  if (!ingredients.length) return seedData;
  const next = {
    ...seedData,
    ingredients_inci: ingredients,
    inci_list: ingredients,
    ingredient_intel: {
      ...asObject(seedData.ingredient_intel),
      inci_list: ingredients,
      inci_normalized: ingredients,
    },
  };
  if (asObject(next.snapshot)) {
    next.snapshot = {
      ...asObject(next.snapshot),
      ingredients_inci: ingredients,
      inci_list: ingredients,
      ingredient_intel: {
        ...asObject(asObject(next.snapshot).ingredient_intel),
        inci_list: ingredients,
        inci_normalized: ingredients,
      },
    };
  }
  return next;
}

function refreshVariantDescriptions(variants, description) {
  return asArray(variants).map((variant) => ({
    ...asObject(variant),
    description,
  }));
}

function buildNextSeedData(row) {
  const initialSeedData = refreshIngredients(asObject(row.seed_data));
  const description = buildPublicDescription(row, initialSeedData);
  const nextSeedData = {
    ...initialSeedData,
    description,
    pdp_description_raw: description,
    variants: refreshVariantDescriptions(initialSeedData.variants, description),
  };
  if (asObject(nextSeedData.snapshot)) {
    nextSeedData.snapshot = {
      ...asObject(nextSeedData.snapshot),
      description,
      pdp_description_raw: description,
      variants: refreshVariantDescriptions(asObject(nextSeedData.snapshot).variants, description),
    };
  }
  return nextSeedData;
}

function validatePublicSeedData(seedData) {
  const description = text(seedData.description || asObject(seedData.snapshot).description || seedData.pdp_description_raw);
  const raw = text(seedData.pdp_official_description_raw || seedData.pdp_source_description_raw);
  const ingredients = asArray(seedData.ingredients_inci);
  const problems = [];
  if (description.length < 180) problems.push('public_description_too_short');
  if (!raw) problems.push('missing_preserved_official_raw_description');
  if (/\b(contact us|customer service|customer support|support center|support page|privacy policy|terms(?: and conditions)?|shipping policy|return policy|about us|blog|blogs|social highlights|official|avoid contact with eyes|keep out of reach|customerservice@|support@)\b/i.test(description)) {
    problems.push('public_description_contains_pollution');
  }
  if (!text(seedData.pdp_ingredients_raw) || ingredients.length < 2) {
    problems.push('missing_structured_formula_fields');
  }
  if (text(seedData.pdp_ingredients_raw).includes('1,2-Hexanediol') && !ingredients.includes('1,2-Hexanediol')) {
    problems.push('inci_decimal_comma_split_regression');
  }
  if (!text(seedData.pdp_how_to_use_raw)) problems.push('missing_how_to_use');
  return problems;
}

async function main() {
  const manifestPath = argValue('manifest');
  if (!manifestPath) throw new Error('Missing --manifest <db_ready_candidate_manifest.json>');
  const outPath = argValue('out');
  const apply = hasFlag('apply');
  const confirm = argValue('confirm');
  if (apply && confirm !== CONFIRM_TOKEN) {
    throw new Error(`Apply requires --confirm ${CONFIRM_TOKEN}`);
  }

  const incomingRows = buildIncomingRows(readManifest(manifestPath));
  const results = [];
  for (const row of incomingRows) {
    const externalProductId = text(row.external_product_id);
    const nextSeedData = buildNextSeedData(row);
    const validationProblems = validatePublicSeedData(nextSeedData);
    const existing = await query(
      `
        SELECT id, external_product_id, title, seed_data
        FROM external_product_seeds
        WHERE external_product_id = $1
          AND market = 'US'
          AND domain = '7journeys.com'
          AND status = 'active'
        LIMIT 1
      `,
      [externalProductId],
    );
    const existingRow = existing.rows?.[0] || null;
    const existingSeedData = asObject(existingRow?.seed_data);
    const existingDescription = text(
      existingSeedData.description ||
        asObject(existingSeedData.snapshot).description ||
        existingSeedData.pdp_description_raw,
    );
    const nextDescription = text(nextSeedData.description || asObject(nextSeedData.snapshot).description);

    if (!existingRow) {
      results.push({
        external_product_id: externalProductId,
        title: text(row.title),
        status: 'missing_existing_seed',
        validation_problems: validationProblems,
      });
      continue;
    }
    if (validationProblems.length) {
      results.push({
        external_product_id: externalProductId,
        title: text(row.title),
        status: 'invalid_incoming_seed_data',
        validation_problems: validationProblems,
      });
      continue;
    }

    const changed = JSON.stringify(existingSeedData) !== JSON.stringify(nextSeedData);
    if (apply && changed) {
      await query(
        `
          UPDATE external_product_seeds
          SET
            title = $2,
            image_url = $3,
            price_amount = $4,
            price_currency = $5,
            availability = $6,
            seed_data = $7::jsonb,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          existingRow.id,
          text(row.title) || null,
          text(row.image_url) || null,
          Number.isFinite(Number(row.price_amount)) ? Number(row.price_amount) : null,
          text(row.price_currency) || null,
          text(row.availability) || null,
          JSON.stringify(nextSeedData),
        ],
      );
    }
    results.push({
      external_product_id: externalProductId,
      title: text(row.title),
      status: apply ? (changed ? 'updated' : 'unchanged') : changed ? 'would_update' : 'unchanged',
      existing_description_length: existingDescription.length,
      next_description_length: nextDescription.length,
      preserved_official_raw_description_length: text(nextSeedData.pdp_official_description_raw).length,
      ingredients_count: asArray(nextSeedData.ingredients_inci).length,
      decimal_comma_inci_preserved: asArray(nextSeedData.ingredients_inci).includes('1,2-Hexanediol'),
      validation_problems: validationProblems,
    });
  }

  const payload = {
    ok: results.every((row) => !row.validation_problems?.length && row.status !== 'missing_existing_seed'),
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    manifest_path: resolvePath(manifestPath),
    scanned: incomingRows.length,
    summary: results.reduce(
      (acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      },
      {},
    ),
    results,
  };
  if (outPath) {
    const resolvedOut = resolvePath(outPath);
    ensureParent(resolvedOut);
    fs.writeFileSync(resolvedOut, `${JSON.stringify(payload, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
