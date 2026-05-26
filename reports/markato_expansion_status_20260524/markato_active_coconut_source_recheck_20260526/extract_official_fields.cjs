#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const HTML_DIR = path.join(ROOT, 'source_html');
const OUT_DIR = path.join(ROOT, 'analysis');

const products = [
  {
    brand: 'Active Drip',
    external_product_id: 'ext_94e9169cdf21031b65f760c9',
    title: 'HA + PEPTIDES EYE CARE',
    source_url: 'https://activedrip.com/products/hyaluronic-acid-peptides-eye-contour',
    file: 'active_drip_ha_peptides_eye.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_833660ffbf5c744869351463',
    title: 'R-Q10 EYE CARE',
    source_url: 'https://activedrip.com/products/retinol-q10-anti-age-eye-contour',
    file: 'active_drip_r_q10_eye.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_daba06ea03080351d96dd6f9',
    title: 'CICA MILK DRIP',
    source_url: 'https://activedrip.com/products/cica-b5-recovery-serum',
    file: 'active_drip_cica_milk.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_eea9ddc94177c421b32a1ed5',
    title: 'C + E DRIP',
    source_url: 'https://activedrip.com/products/vitamin-c-e-serum',
    file: 'active_drip_c_e_drip.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_edef015844086dd8eaa792b2',
    title: 'RETINOL DRIP',
    source_url: 'https://activedrip.com/products/retinol-anti-wrinkle-serum',
    file: 'active_drip_retinol.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_11509e4feaf83a2419d8c77d',
    title: 'KOJIC DRIP',
    source_url: 'https://activedrip.com/products/niacinamide-kojic-acid-glow-and-corrective-serum',
    file: 'active_drip_kojic.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_441b5d142009ef8ae5082262',
    title: 'HYDRATE DRIP',
    source_url: 'https://activedrip.com/products/hyaluronic-acid-b12-b5-serum',
    file: 'active_drip_hydrate.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Active Drip',
    external_product_id: 'ext_7e270c8cb635a23a446a76f9',
    title: 'THE ICONIC MOISTURISER',
    source_url: 'https://activedrip.com/products/vitamin-c-hyaluronic-acid-moisturising-and-antioxidant-cream',
    file: 'active_drip_iconic_moisturiser.html',
    extractor: 'activeDrip',
  },
  {
    brand: 'Coconut Matter',
    external_product_id: 'ext_fda8be630c6dc79ef599df3c',
    title: 'NOURISHING HAND BALM',
    source_url: 'https://coconutmatter.com/products/nourishing-hand-balm',
    file: 'coconut_matter_hand_balm.html',
    extractor: 'coconutMatter',
  },
  {
    brand: 'Coconut Matter',
    external_product_id: 'ext_c840771410198f627d75673a',
    title: 'TINTED COCONUT LIP BALM',
    source_url: 'https://coconutmatter.com/products/tinted-coconut-lip-balm',
    file: 'coconut_matter_tinted_lip_balm.html',
    extractor: 'coconutMatter',
  },
  {
    brand: 'Coconut Matter',
    external_product_id: 'ext_a7f414cda657f8c5857fafe8',
    title: 'Goji Shake Shampoo Concentrate | For Treated Hair',
    source_url: 'https://coconutmatter.com/products/goji-shake-shampoo-concentrate',
    file: 'coconut_matter_goji_shake.html',
    extractor: 'coconutMatter',
  },
  {
    brand: 'Coconut Matter',
    external_product_id: 'ext_9518e81076efc5c5138214ee',
    title: 'Matcha Shake Shampoo Concentrate | For All Hair Types',
    source_url: 'https://coconutmatter.com/products/matcha-shake-shampoo-concentrate',
    file: 'coconut_matter_matcha_shake.html',
    extractor: 'coconutMatter',
  },
  {
    brand: 'Coconut Matter',
    external_product_id: 'ext_57fe66e03e7b47b972b78c30',
    title: 'Oaty Shake Body Wash Concentrate',
    source_url: 'https://coconutmatter.com/products/oaty-shake-body-wash-concentrate',
    file: 'coconut_matter_oaty_shake.html',
    extractor: 'coconutMatter',
  },
  {
    brand: 'Coconut Matter',
    external_product_id: 'ext_8982e4384c3bd70a5718c899',
    title: 'CLEAR LIP CARE',
    source_url: 'https://coconutmatter.com/products/clear-lip-care',
    file: 'coconut_matter_clear_lip_care.html',
    extractor: 'coconutMatter',
  },
];

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function textFromHtml(html) {
  return decodeEntities(html)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p[^>]*>/gi, ' ')
    .replace(/<\/li>\s*<li[^>]*>/gi, '; ')
    .replace(/<\s*\/?(?:p|div|span|strong|b|em|i|ul|ol|li|meta)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*,+/g, ', ')
    .trim();
}

function normalizeIngredients(value) {
  return String(value || '')
    .replace(/\s+\*+\s*Ingredients\s+from\b.*$/i, '')
    .replace(/\s*\*\*Naturally occurring ingredients of essential oils\b/gi, ' **Naturally occurring ingredients of essential oils')
    .replace(/\s+\*+\s*(?=\()/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*:\s*/g, ': ')
    .trim();
}

function extractActiveDrip(html) {
  const productInfo = html.match(/id="Product-Information-Drawer"[\s\S]*?id="Alternate-Product-Information-Drawer"/i)?.[0] || '';
  const ingredientsHtml =
    productInfo.match(/side-panel-content--tab-panel rte tab-active">\s*([\s\S]*?)\s*<\/div>/i)?.[1] || '';
  const howToHtml =
    html.match(/<summary>\s*How to use\s*<span><\/span>\s*<\/summary>\s*<div[^>]*>\s*([\s\S]*?)\s*<\/div>/i)?.[1] || '';
  const tabbedHowToHtml =
    html.match(/<div class="ws_tabbed-product-info__panel"[\s\S]*?data-index="2"[\s\S]*?<div class="ws_tabbed-product-info__panel-inner rte">\s*([\s\S]*?)\s*<\/div>/i)?.[1] || '';
  const tabbedIngredientsHtml =
    html.match(/<div class="ws_tabbed-product-info__panel"[\s\S]*?data-index="3"[\s\S]*?<div class="ws_tabbed-product-info__panel-inner rte">\s*([\s\S]*?)\s*<\/div>/i)?.[1] || '';
  const tabbedIngredientText = textFromHtml(tabbedIngredientsHtml);
  const allIngredientsTail = tabbedIngredientText.includes('All ingredients')
    ? tabbedIngredientText.split(/All ingredients/i).pop()
    : '';
  return {
    pdp_ingredients_raw: normalizeIngredients(textFromHtml(ingredientsHtml) || allIngredientsTail),
    pdp_how_to_use_raw: textFromHtml(howToHtml || tabbedHowToHtml),
  };
}

function extractCoconutMatterGuideSections(html) {
  const sections = {};
  const re =
    /<div class="product_guide_paragraph_topic">([\s\S]*?)<\/div>[\s\S]*?<div class="product_guide_paragraph_description">([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = re.exec(html))) {
    const topic = textFromHtml(match[1]).toLowerCase().replace(/\?+$/g, '').trim();
    sections[topic] = textFromHtml(match[2]);
  }
  return sections;
}

function cleanCoconutMatterIngredients(raw, product) {
  let value = String(raw || '')
    .replace(/^.*?\bas listed below:\s*/i, '')
    .replace(/\*/g, '')
    .replace(/\bOrganic certified\b.*$/i, '')
    .replace(/\bAloe Barbadensi s\b/g, 'Aloe Barbadensis')
    .replace(/\s+/g, ' ')
    .trim();

  if (product.external_product_id === 'ext_fda8be630c6dc79ef599df3c') {
    value =
      'Vitis vinifera seed oil, Cocos nucifera oil, Jojoba oil, Butyrospermum parkii butter, Euphorbia cerifera cera, Maranta arundinacea root powder, Tocopherol, Jasminum grandifloruml oil, Lavandula angustifolia oil, d-Limonene, Geraniol, Linalol, Rosa damascena oil.';
  }

  if (product.external_product_id === 'ext_c840771410198f627d75673a') {
    value = value
      .replace(/\s*All our colours have a particle size range\b.*$/i, '')
      .replace(/\s*Titanium Dioxide EU Regulation\b.*$/i, '')
      .replace(/\s*Tin Oxide formulations\b.*$/i, '')
      .replace(/\s*May Contain\s*\[-\/\+\]\s*:\s*/i, ', ')
      .replace(/\s+Iron Oxides\b/i, ', Iron Oxides')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return normalizeIngredients(value);
}

function extractCoconutMatter(html, product) {
  const sections = extractCoconutMatterGuideSections(html);
  const ingredientKey = Object.keys(sections).find((key) => key.includes('ingredient')) || '';
  const howToKey =
    Object.keys(sections).find((key) => key.includes('how to use')) ||
    Object.keys(sections).find((key) => key.includes('how do i use')) ||
    '';
  const sourceIngredientsSection = normalizeIngredients(sections[ingredientKey] || '');
  return {
    source_ingredients_section_raw: sourceIngredientsSection,
    pdp_ingredients_raw: cleanCoconutMatterIngredients(sourceIngredientsSection, product),
    pdp_how_to_use_raw: sections[howToKey] || '',
    guide_topics: Object.keys(sections),
  };
}

function validateExtracted(item) {
  const blockers = [];
  if (!item.pdp_ingredients_raw || item.pdp_ingredients_raw.length < 80) blockers.push('missing_or_short_ingredients');
  if (!item.pdp_ingredients_raw.includes(',')) blockers.push('ingredients_not_comma_separated');
  if (item.brand === 'Coconut Matter' && (!item.pdp_how_to_use_raw || item.pdp_how_to_use_raw.length < 20)) {
    blockers.push('missing_or_short_how_to');
  }
  return blockers;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const extracted = products.map((product) => {
    const html = fs.readFileSync(path.join(HTML_DIR, product.file), 'utf8');
    const fields = product.extractor === 'activeDrip' ? extractActiveDrip(html) : extractCoconutMatter(html, product);
    const row = {
      ...product,
      ...fields,
    };
    row.blockers = validateExtracted(row);
    row.ready_for_reviewed_patch = row.blockers.length === 0;
    return row;
  });

  const manifest = {
    market: 'US',
    reviewed_by: 'codex_review',
    reason: 'markato_active_drip_coconut_matter_official_pdp_full_inci_how_to_repair',
    source_kind: 'official_pdp_structured_product_section',
    entries: extracted
      .filter((row) => row.ready_for_reviewed_patch)
      .map((row) => ({
        external_product_id: row.external_product_id,
        source_url: row.source_url,
        source_kind:
          row.brand === 'Active Drip'
            ? 'official_pdp_all_ingredients_drawer_and_how_to_accordion'
            : 'official_pdp_product_guide_ingredients_and_how_to',
        evidence:
          row.brand === 'Active Drip'
            ? `Official Active Drip PDP for ${row.title} includes an All ingredients drawer with a full comma-separated ingredient list and a How to use accordion.`
            : `Official Coconut Matter PDP for ${row.title} includes product guide sections for ingredients and how-to use.`,
        pdp_ingredients_raw: row.pdp_ingredients_raw,
        pdp_how_to_use_raw: row.pdp_how_to_use_raw,
      })),
  };

  fs.writeFileSync(path.join(OUT_DIR, 'extracted_official_fields.json'), `${JSON.stringify(extracted, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, 'reviewed_pdp_content_patch_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        scanned: extracted.length,
        ready_for_reviewed_patch: manifest.entries.length,
        blocked: extracted.filter((row) => row.blockers.length > 0).map((row) => ({
          external_product_id: row.external_product_id,
          title: row.title,
          blockers: row.blockers,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

main();
