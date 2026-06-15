'use strict';

// WS1 actives authoring (docs/find_products_multi_phase2_scope.md): derive searchable
// actives from a product's ingredient evidence. The write-back + the admin preview
// endpoint need a live DB and validate post-deploy; this covers the pure derivation.

const app = require('../src/server.js');
const { deriveBeautyRecallActives: derive, buildBeautyIngredientSourceText: sourceText } = app._debug;

const PILOT = {
  title: 'Tofu Collagen Dual-Firming Jelly Cream',
  description: 'firming jelly cream',
  raw_ingredient_text_clean:
    'water, glycine soja (soybean) seed extract, adenosine, niacinamide, sodium hyaluronate, hydrolyzed collagen, butylene glycol',
};

describe('deriveBeautyRecallActives', () => {
  test('grounds friendly ingredient tokens from raw INCI (incl. glycine soja → soy)', () => {
    const d = derive(PILOT);
    expect(d.ingredient_tokens).toEqual(expect.arrayContaining(['soy', 'adenosine', 'collagen', 'niacinamide']));
  });

  test('alias_tokens carry BOTH the friendly word and the INCI surface form', () => {
    const d = derive(PILOT);
    expect(d.alias_tokens).toEqual(expect.arrayContaining(['soy', 'glycine soja', 'hydrolyzed collagen']));
  });

  test('benefit concepts live in concepts, never in ingredient_tokens', () => {
    const d = derive(PILOT);
    expect(d.concepts).toEqual(expect.arrayContaining(['firming']));
    expect(d.ingredient_tokens).not.toContain('firming');
    expect(d.ingredient_tokens).not.toContain('brightening');
  });

  test('per-concept evidence records which surface form matched', () => {
    const d = derive(PILOT);
    const soy = d.evidence.find((e) => e.concept === 'soy');
    expect(soy).toBeTruthy();
    expect(soy.matched).toEqual(expect.arrayContaining(['glycine soja']));
  });

  // The critical grounding guarantee: derivation must read REAL ingredient evidence,
  // not echo whatever derived.recall tokens already exist (else it can never fill a
  // sparse field correctly / it would launder bad prior data).
  test('ignores pre-existing derived.recall tokens (no self-echo)', () => {
    const noIngredients = {
      title: 'Mystery Cream',
      seed_data: { derived: { recall: { ingredient_tokens: ['bogus', 'fake_active'], alias_tokens: ['nonsense'] } } },
    };
    const d = derive(noIngredients);
    expect(d.ingredient_tokens).toEqual([]);
    expect(d.concepts).toEqual([]);
    expect(sourceText(noIngredients)).toBe('');
  });

  test('safe on empty/null/odd input', () => {
    expect(derive({})).toEqual({ ingredient_tokens: [], alias_tokens: [], concepts: [], evidence: [], source_chars: 0 });
    expect(derive(null).ingredient_tokens).toEqual([]);
    expect(derive('nope').ingredient_tokens).toEqual([]);
  });

  test('reads array ingredient fields (ingredients_inci / active_ingredients)', () => {
    const d = derive({ ingredients_inci: ['Aqua', 'Adenosine', 'Niacinamide'], active_ingredients: ['Retinol'] });
    expect(d.ingredient_tokens).toEqual(expect.arrayContaining(['adenosine', 'niacinamide', 'retinol']));
  });
});
