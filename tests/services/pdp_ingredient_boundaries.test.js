const {
  buildAuthoritativeIngredientView,
  buildStructuredPdpIngredientModules,
  _internals,
} = require('../../src/services/pdpIngredientAuthority');
const live = require('../fixtures/ingredients/then_i_met_you_live_20261004.json');

const cleanItems = ['Water', 'Glycerin', 'Oenothera Biennis (Evening Primrose) Oil', 'Citronellol', 'Geraniol', 'Linalool'];
const cleanRaw = cleanItems.join(', ');
const usage = 'Apply a layer onto your face and neck. Use twice daily, morning and night.';
const staleAuthority = (capture) => ({
  ...capture.ingredients_inci,
  purity_status: 'authoritative',
  active_items: [],
});

function expectCleanModule(product, expected = cleanItems) {
  const { authority, ingredientsInciData } = buildStructuredPdpIngredientModules(product);
  expect(authority.purity_status).toBe('authoritative');
  expect(ingredientsInciData.items).toEqual(expected);
  expect(ingredientsInciData.raw_text).toBe(expected.join(', '));
  expect(ingredientsInciData.raw_text).not.toMatch(/morning and night|how to use|apply a layer/i);
  return ingredientsInciData;
}

describe('ingredient boundaries and stored-authority revalidation', () => {
  test.each(live.captures)('repairs the exact $artifact section without inventing allergens', (capture) => {
    expect(capture.ingredients_inci.items).toHaveLength(57);
    expect(capture.ingredients_inci.items.at(-1)).toBe('morning and night');
    expect(capture.ingredients_inci.items).not.toContain('LINALOOL');
    expect(capture.ingredients_inci.raw_text).toContain('LINALOOL HOW TO USE');
    expect(live.expected_items).toHaveLength(57);
    expect(live.expected_items.at(-1)).toBe('LINALOOL');
    expectCleanModule({ pdp_ingredients_raw: capture.ingredients_inci.raw_text }, live.expected_items);
    expectCleanModule({
      pdp_details_sections: [{ heading: 'Ingredients', content: capture.ingredients_inci.raw_text }],
    }, live.expected_items);
  });

  test.each(live.captures)('reparses both raw text and items in stored $artifact authority', (capture) => {
    for (const source_origin of ['pdp_section', 'official_html', 'kb_reviewed']) {
      const authoritative = { ...staleAuthority(capture), source_origin };
      expectCleanModule({ ingredient_intel: { authoritative } }, live.expected_items);
      expectCleanModule({ seed_data: { ingredient_intel: { authoritative } } }, live.expected_items);
      expectCleanModule({ seed_data: { snapshot: { ingredient_intel: { authoritative } } } }, live.expected_items);
    }
  });

  test.each(live.captures)('does not let structured $artifact arrays bypass source parsing', (capture) => {
    for (const field of ['ingredients_inci', 'ingredientsInci', 'inci_ingredients', 'inciIngredients', 'inci_list', 'inciList', 'ingredients', 'inci']) {
      expectCleanModule({ [field]: capture.ingredients_inci }, live.expected_items);
    }
    const attachedUsageItems = _internals.splitIngredientText(capture.ingredients_inci.raw_text);
    // Without its raw-page source, a malformed structured sequence cannot prove
    // completeness. The capture objects above retain raw text and recover57.
    expect(buildStructuredPdpIngredientModules({ ingredients_inci: attachedUsageItems }).ingredientsInciData).toBeNull();
  });

  test.each([
    ' HOW TO USE ',
    ' How to Use: ',
    '\nHow\tto\nUse\n',
    '<h2>How <span>to</span> Use</h2><p>',
    '&nbsp;How&#160;to&#xA0;Use&nbsp;',
    'How to Use: ',
    ' Directions: ',
    ' Directions for Use ',
    ' Suggested Use: ',
    ' Recommended Use ',
    ' Usage: ',
    ' Application Instructions ',
    ' Warnings ',
    ' Caution ',
    ' Precautions ',
    ' Safety Information ',
  ])('retains the final allergen before the section boundary %s', (boundary) => {
    expectCleanModule({ pdp_ingredients_raw: `${cleanRaw}${boundary}${usage}` });
  });

  test.each([
    'Apply a layer onto your face and neck, morning and night',
    'Massage gently onto the face, twice daily',
    'Rinse thoroughly with water, pat dry',
    'Use twice daily, morning and night',
  ])('bounds inline instructions even without a heading: %s', (instructions) => {
    expectCleanModule({ pdp_ingredients_raw: `${cleanRaw} ${instructions}` });
  });

  test.each(['', 'Full Ingredients: '])('does not reopen a finished ingredient section from later copy (%s)', (prefix) => {
    expectCleanModule({
      pdp_ingredients_raw: `${prefix}${cleanRaw} How to Use: ${usage} Full Ingredients: Water, Glycerin, Panthenol.`,
    });
  });

  test('keeps uncommon real tokens and fragrance allergens instead of filtering to a chemical-name whitelist', () => {
    const items = ['Water', 'Glycerin', 'Ectoin', 'Asiaticoside', 'Phytosphingosine', 'Benzyl Benzoate', 'Hydroxycitronellal', 'Alpha-Isomethyl Ionone', 'Evernia Prunastri Extract', 'Linalool'];
    expectCleanModule({ ingredients_inci: items }, items);
    expectCleanModule({ pdp_ingredients_raw: `${items.join(', ')} How to Use: ${usage}` }, items);
  });

  test('preserves decimal/numeric chemical prefixes, botanical names, alcohol abbreviation and marked allergens', () => {
    const items = ['Water', 'Glycerin', '1,2-Hexanediol', '0.1% Tocopherol', 'Alcohol Denat. (SD Alcohol)', 'Oenothera Biennis (Evening Primrose) Oil', 'Citral^', 'Linalool*'];
    expectCleanModule({ pdp_ingredients_raw: `${items.join(', ')}. *Organic ingredients` }, items);
  });

  test('retains optional colorants rather than silently dropping a colon-containing INCI token', () => {
    const items = ['Mica', 'Silica', 'Glycerin', 'Red 7 Lake (CI 15850:1)', '[+/-: Iron Oxides (CI 77491, CI 77492, CI 77499)]'];
    expectCleanModule({ pdp_ingredients_raw: items.join(', ') }, items);
  });

  test.each(['morning and night', 'MORNING AND NIGHT', 'AM/PM', 'face and neck', 'Use daily', 'Your daily routine', 'RINSE', 'This is our formula'])('rejects usage token %s despite an ingredient-shaped surrounding set', (copy) => {
    expect(_internals.isLikelyIngredientItem(copy)).toBe(false);
    // No section boundary proves where this unstructured corruption began.
    // Do not drop an arbitrary token and label the remaining set authoritative.
    const items = ['Water', 'Glycerin', copy, 'Panthenol'];
    const raw_text = items.join(', ');
    for (const product of [
      { pdp_ingredients_raw: raw_text },
      { ingredients_inci: items },
      { ingredient_intel: { authoritative: { items, raw_text, purity_status: 'authoritative' } } },
    ]) {
      const modules = buildStructuredPdpIngredientModules(product);
      expect(modules.ingredientsInciData).toBeNull();
      expect(modules.authority.purity_status).toBe('suppressed');
    }
  });

  test('does not fabricate an omitted allergen when the original source text is unavailable', () => {
    const capture = live.captures[0];
    const items = capture.ingredients_inci.items;
    for (const product of [
      { ingredients_inci: items },
      { ingredient_intel: { authoritative: { items, purity_status: 'authoritative' } } },
    ]) {
      const modules = buildStructuredPdpIngredientModules(product);
      expect(modules.ingredientsInciData).toBeNull();
      expect(modules.authority.items).not.toContain('LINALOOL');
    }
  });

  test('recovers from an invalid stored authority using another clean source and revalidates its actives', () => {
    const product = {
      pdp_ingredients_raw: cleanRaw,
      ingredient_intel: {
        authoritative: {
          raw_text: 'Water, Glycerin, Your evening routine, Panthenol',
          items: ['Water', 'Glycerin', 'Panthenol'],
          active_items: ['Niacinamide'],
          purity_status: 'authoritative',
          source_origin: 'pdp_section',
        },
      },
    };
    expectCleanModule(product);
    expect(buildAuthoritativeIngredientView(product).active_items).not.toContain('Niacinamide');
  });

  test('does not let a reviewed origin bless a source truncated inside a corrupted list', () => {
    const items = ['Water', 'Glycerin', 'Use daily', 'Panthenol'];
    const { ingredientsInciData } = buildStructuredPdpIngredientModules({
      ingredient_intel: { authoritative: {
        items, raw_text: items.join(', '), purity_status: 'authoritative', source_origin: 'kb_reviewed',
      } },
    });
    expect(ingredientsInciData).toBeNull();
  });

  test('does not label a capped ingredient list as complete authority', () => {
    const items = Array.from({ length: 181 }, (_, index) => `Peptide-${index + 1}`);
    for (const product of [
      { pdp_ingredients_raw: items.join(', ') },
      { ingredients_inci: items },
      { ingredient_intel: { authoritative: { items, purity_status: 'authoritative', source_origin: 'kb_reviewed' } } },
    ]) {
      expect(buildStructuredPdpIngredientModules(product).ingredientsInciData).toBeNull();
    }
  });

  test('uses the same structured source for its list and raw text', () => {
    const alternate = ['Water', 'Niacinamide', 'Panthenol'];
    expectCleanModule({
      ingredients_inci: cleanItems,
      inci_list: { items: alternate, raw_text: alternate.join(', ') },
    });
  });

  test.each([{ unusable: [] }, { unusable: ['Water', 'Glycerin', 'Your daily routine'] }])('recovers a complete structured source after an unusable earlier array ($unusable)', ({ unusable }) => {
    expectCleanModule({
      ingredients_inci: unusable,
      inci_list: { items: cleanItems, raw_text: `${cleanRaw} How to Use: ${usage}` },
    });
  });

  test('preserves a clean short existing authority without upgrading unrelated partial source data', () => {
    const items = ['Oenothera Biennis (Evening Primrose) Oil', 'Tocopherol'];
    expectCleanModule({ ingredient_intel: { authoritative: {
      items, raw_text: items.join(', '), purity_status: 'authoritative', source_origin: 'official_html',
    } } }, items);
  });

  test.each(['[object Object]', 'undefined', 'null', 'none', 'N/A', '100%', '---'])('rejects malformed serialized token %s', (value) => {
    expect(_internals.isLikelyIngredientItem(value)).toBe(false);
  });

  test('does not broaden an existing reviewed partial scope using unrelated full INCI', () => {
    const items = ['Ceramides', 'Panthenol'];
    const authority_scope = 'reviewed_key_ingredients_not_full_inci';
    const module = expectCleanModule({
      pdp_ingredients_raw: cleanRaw,
      ingredient_intel: {
        authoritative: {
          items,
          raw_text: `${items.join(', ')} How to Use: ${usage}`,
          purity_status: 'authoritative',
          authority_scope,
          source_origin: 'reviewed_exact_product_source_partial_ingredient_scope',
        },
      },
    }, items);
    expect(module.authority_scope).toBe(authority_scope);
  });

  test('retains the reviewed partial, not-applicable and bundle guardrails', () => {
    const partial = buildStructuredPdpIngredientModules({
      pdp_ingredients_raw: 'Ceramides, Panthenol How to Use: Apply a layer',
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_quality_status: 'reviewed_key_ingredients_partial_not_full_inci',
          authority_scope: 'reviewed_key_ingredients_not_full_inci',
        },
      },
    });
    expect(partial.ingredientsInciData.authority_scope).toBe('reviewed_key_ingredients_not_full_inci');
    const notApplicable = buildStructuredPdpIngredientModules({
      ingredient_remediation_v1: { action: 'mark_inci_not_applicable' },
      ingredient_intel: { force_fill_contract: { contract_version: 'pivota.pdp.force_fill.v1', display_note: 'Source capture pending' } },
    });
    expect(notApplicable.ingredientsInciData).toBeNull();
    const bundle = buildStructuredPdpIngredientModules({
      merchant_id: 'external_seed', source: 'external_seed', title: 'Radiance Routine Set',
      ingredient_intel: { authoritative: staleAuthority(live.captures[0]) },
    });
    expect(bundle.ingredientsInciData).toBeNull();
    expect(bundle.authority.suppressed_reason).toBe('product_family_set_or_collection');
  });
});
