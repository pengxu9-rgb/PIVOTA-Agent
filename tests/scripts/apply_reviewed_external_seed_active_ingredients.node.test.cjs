'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  activeEvidenceStatus,
  parseActiveIngredients,
  patchSeedData,
} = require('../../scripts/apply-reviewed-external-seed-active-ingredients.cjs');

test('parseActiveIngredients dedupes comma and newline input', () => {
  assert.deepEqual(parseActiveIngredients('Salicylic acid, Salicylic Acid\nNiacinamide'), [
    'Salicylic acid',
    'Niacinamide',
  ]);
});

test('activeEvidenceStatus requires source-backed evidence', () => {
  const seedData = {
    pdp_active_ingredients_raw: 'SALICYLIC ACID (BHA) exfoliates skin.',
    snapshot: {},
  };

  assert.equal(activeEvidenceStatus(seedData, ['Salicylic acid']).backed, true);
  assert.deepEqual(activeEvidenceStatus(seedData, ['Peptides']).missing, ['Peptides']);
});

test('patchSeedData writes reviewed active ingredients to root, snapshot, and ingredient intel', () => {
  const patched = patchSeedData(
    {
      active_ingredients: ['Peptides'],
      snapshot: { active_ingredients: ['Peptides'] },
      ingredient_intel: {},
    },
    ['Salicylic acid'],
    {
      source_url: 'https://olehenriksen.com/products/detox-drops-2-salicylic-acid-toner-4oz',
      evidence: 'SALICYLIC ACID (BHA)',
      reviewed_at: '2026-05-17T00:00:00.000Z',
    },
  );

  assert.deepEqual(patched.active_ingredients, ['Salicylic acid']);
  assert.deepEqual(patched.snapshot.active_ingredients, ['Salicylic acid']);
  assert.deepEqual(patched.ingredient_intel.active_ingredients, ['Salicylic acid']);
  assert.deepEqual(patched.snapshot.ingredient_intel.active_ingredients, ['Salicylic acid']);
  assert.equal(
    patched.reviewed_active_ingredients_v1.contract_version,
    'external_seed.reviewed_active_ingredients.v1',
  );
  assert.equal(
    patched.pdp_field_quality_summary.active_ingredients.source_origin,
    'pivota_reviewed_source_backed_patch',
  );
});

test('patchSeedData can clear stale non-source-backed structured ingredient fields', () => {
  const patched = patchSeedData(
    {
      active_ingredients: ['Peptides'],
      ingredient_tokens: ['Peptides'],
      key_ingredients: ['Peptides'],
      ingredient_intel: {
        active_ingredients: ['Peptides'],
        key_ingredients: ['Peptides'],
        inci_list: 'polluted copy',
        force_fill_contract: { source_origin: 'pivota_force_fill' },
      },
      snapshot: {
        active_ingredients: ['Peptides'],
        ingredient_tokens: ['Peptides'],
        key_ingredients: ['Peptides'],
        ingredient_intel: {
          active_ingredients: ['Peptides'],
          key_ingredients: ['Peptides'],
          inci_raw: 'polluted copy',
        },
      },
    },
    ['Salicylic acid'],
    {
      source_url: 'https://olehenriksen.com/products/detox-drops-2-salicylic-acid-toner-4oz',
      evidence: 'SALICYLIC ACID (BHA)',
      reviewed_at: '2026-05-17T00:00:00.000Z',
      clear_stale_structured_ingredients: true,
    },
  );

  assert.deepEqual(patched.active_ingredients, ['Salicylic acid']);
  assert.equal(patched.ingredient_tokens, undefined);
  assert.equal(patched.key_ingredients, undefined);
  assert.deepEqual(patched.ingredient_intel, { active_ingredients: ['Salicylic acid'] });
  assert.equal(patched.snapshot.ingredient_tokens, undefined);
  assert.deepEqual(patched.snapshot.ingredient_intel, { active_ingredients: ['Salicylic acid'] });
  assert.equal(
    patched.structured_ingredient_remediation_v1.contract_version,
    'external_seed.structured_ingredient_remediation.v1',
  );
});
