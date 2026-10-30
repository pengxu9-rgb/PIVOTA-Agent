'use strict';

// A small external-seed catalog for the retinoid query gate in isBeautyProductContraindicatedForQuery
// (src/server.js): retinoid creams, moisturizers, cleansers and sunscreens, retinoid serums, stand-ins,
// and the non-retinoid products of each form. Every host is under .invalid, so nothing here can name a
// reachable store; the rows are only ever handed to a mocked db.query.

const ROWS = [
  ['ret_night_cream', 'Retinol Night Cream', 'moisturizer', 'Night cream with 0.3% encapsulated retinol.', ['retinol']],
  ['ret_pro_cream', 'Pro-Retinol Smoothing Cream', 'moisturizer', 'Smoothing face cream with pro-retinol.', ['retinol']],
  ['ret_creme_riche', 'Retinol Creme Riche', 'moisturizer', 'Rich face creme with retinol.', ['retinol']],
  ['ret_moisturizer', 'Retinol Renewal Moisturizer', 'moisturizer', 'Daily face moisturizer with retinol.', ['retinol']],
  ['retinal_cream', 'Retinal Renewal Cream', 'moisturizer', 'Face cream with retinaldehyde.', ['retinal', 'retinoid']],
  ['granactive_emulsion', 'Granactive Retinoid 2% Emulsion', 'moisturizer', 'Lightweight face emulsion with hydroxypinacolone retinoate.', ['retinoid', 'hydroxypinacolone retinoate']],
  ['retinal_eye_cream', 'Retinal Eye Cream', 'eye cream', 'Under-eye cream with retinaldehyde.', ['retinal', 'retinoid']],
  ['ret_cleanser', 'Retinol Renewing Cleanser', 'cleanser', 'Face cleanser with retinol.', ['retinol']],
  ['retinyl_spf', 'Retinyl Palmitate Daily Sunscreen SPF 30', 'sunscreen', 'Daily face sunscreen with retinyl palmitate.', ['retinyl palmitate', 'retinoid']],
  ['cn_retinol_cream', '视黄醇修护面霜', 'moisturizer', '含视黄醇的面霜。', ['retinol']],
  ['ret_serum', 'Retinol 0.5% Serum', 'serum', 'Face serum with retinol.', ['retinol', 'squalane']],
  ['retinal_serum', 'Retinal Night Serum', 'serum', 'Night serum with retinaldehyde.', ['retinal', 'retinoid']],
  ['adapalene_gel', 'Adapalene Gel 0.1% Acne Treatment', 'treatment', 'Acne treatment gel with adapalene.', ['adapalene', 'retinoid']],
  ['ret_body_lotion', 'Retinol Body Lotion', 'body lotion', 'Body lotion with retinol.', ['retinol']],
  ['bakuchiol_cream', 'Bakuchiol Retinol Alternative Cream', 'moisturizer', 'Plant-based retinol alternative. Retinol-free face cream.', ['bakuchiol']],
  ['preg_moisturizer', 'Pregnancy Safe Moisturizer Retinol-Free', 'moisturizer', 'Retinol-free face moisturizer.', ['glycerin']],
  ['barrier_moisturizer', 'Barrier Ceramide Moisturizer', 'moisturizer', 'Face moisturizer with ceramides.', ['ceramide']],
  ['gel_cream', 'Hydrating Gel Cream', 'moisturizer', 'Lightweight face gel cream with hyaluronic acid.', ['hyaluronic acid']],
  ['peptide_night_cream', 'Peptide Night Cream', 'moisturizer', 'Face night cream with peptides.', ['peptides']],
  ['caffeine_eye_cream', 'Caffeine Eye Cream', 'eye cream', 'Under-eye cream with caffeine.', ['caffeine']],
  ['foam_cleanser', 'Daily Foaming Cleanser', 'cleanser', 'Foaming face cleanser.', ['glycerin']],
  ['cream_cleanser', 'Hydrating Cream Cleanser', 'cleanser', 'Cream face cleanser with ceramides.', ['ceramide']],
  ['salicylic_cleanser', 'Salicylic Acid Acne Cleanser', 'cleanser', 'Acne face cleanser with 2% salicylic acid.', ['salicylic acid']],
  ['mineral_spf', 'Daily Mineral Sunscreen SPF 50', 'sunscreen', 'Daily broad spectrum face sunscreen.', ['zinc oxide']],
  ['tinted_spf', 'Tinted Moisturizer SPF 30', 'sunscreen', 'Tinted face sunscreen.', ['zinc oxide']],
  ['niacinamide_serum', 'Niacinamide 10% Serum', 'serum', 'Face serum with niacinamide.', ['niacinamide']],
  ['vitc_serum', 'Vitamin C Brightening Serum', 'serum', 'Brightening face serum with ascorbic acid.', ['vitamin c', 'ascorbic acid']],
  ['hyaluronic_serum', 'Hyaluronic Acid Hydrating Serum', 'serum', 'Hydrating face serum.', ['hyaluronic acid']],
  ['glycolic_toner', 'Glycolic Acid Toning Solution', 'toner', 'Exfoliating toner with glycolic acid.', ['glycolic acid']],
  ['lip_balm_spf', 'Lip Balm SPF 15', 'lip balm', 'Lip balm with SPF.', ['shea butter']],
  ['hand_cream', 'Shea Hand Cream', 'hand cream', 'Hand cream with shea butter.', ['shea butter']],
  ['skin_tint', 'Skin Tint Foundation', 'foundation', 'Light coverage foundation.', ['glycerin']],
  ['red_lipstick', 'Classic Red Lipstick', 'lipstick', 'Matte red lipstick.', ['castor oil']],
];

function buildRetinoidFixtureSeedRows(now = '2026-10-01T00:00:00.000Z', extraRows = []) {
  return [...ROWS, ...extraRows].map(([key, title, category, description, ingredientTokens], index) => ({
    id: `seed-${key}`,
    external_product_id: `ext_${key}`,
    market: 'US',
    tool: '*',
    destination_url: `https://fixture-store.invalid/products/${key}`,
    canonical_url: `https://fixture-store.invalid/products/${key}`,
    domain: 'fixture-store.invalid',
    title,
    image_url: `https://fixture-cdn.invalid/${key}.jpg`,
    price_amount: String(18 + (index % 9) * 2) + '.00',
    price_currency: 'USD',
    availability: 'in stock',
    seed_data: {
      brand: 'Fixture Beauty',
      category,
      description,
      ingredient_ids: ingredientTokens.slice(),
      derived: { recall: { ingredient_tokens: ingredientTokens.slice() } },
    },
    updated_at: now,
    created_at: now,
  }));
}

// The db.query the route sees: every external_product_seeds read returns the whole fixture catalog, the
// other reads return nothing. Each call is recorded, so a replay can compare the SQL two builds issue.
// extraRows (same shape as ROWS) are appended for one file's own cases; the default catalog is unchanged.
function createRetinoidFixtureQuery({ calls = null, now, extraRows = [] } = {}) {
  const rows = buildRetinoidFixtureSeedRows(now, extraRows);
  return async (sql, params) => {
    const text = String(sql || '');
    if (Array.isArray(calls)) calls.push({ sql: text, params: params === undefined ? null : params });
    if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
    if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
      return { rows: [] };
    }
    if (text.includes('FROM external_product_seeds') && !text.includes('FROM external_product_seeds eps')) {
      return { rows: rows.map((row) => JSON.parse(JSON.stringify(row))) };
    }
    return { rows: [] };
  };
}

module.exports = {
  RETINOID_FIXTURE_ROWS: ROWS,
  buildRetinoidFixtureSeedRows,
  createRetinoidFixtureQuery,
};
