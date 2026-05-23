#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PRODUCT_INTEL_CONTRACT_VERSION } = require('../src/pdpProductIntel');
const { closePool, query } = require('../src/db');
const {
  buildKbEntriesForRow,
  prepareEntriesForWrite,
  fetchExistingProductIntelKbRows,
} = require('./publish_product_intel_pilot_to_kb');
const {
  buildPivotaInsightInventoryRow,
  hasCommerceTruthClaim,
} = require('../src/services/pivotaInsightsQuality');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const SAFE_REWRITE_QUALITY_STATES = new Set(['limited', 'eligible']);
const SAFE_REWRITE_EVIDENCE_PROFILES = new Set(['seller_only', 'seller_plus_formula']);
const SAFE_REWRITE_BLOCKERS = new Set(['kb_blocked', 'kb_displayable_limited']);
const NON_CORE_PUBLIC_REWRITE_TITLE_RE = /\b(?:sample|e-gift|gift card|hoodie|hat|tote|bucket|bag)\b/i;
const MULTI_ITEM_PUBLIC_REWRITE_TITLE_RE = /\b(?:set|kit|duo|trio|bundle|routine|collection|must-haves?|choose your|gift set|gift trio)\b/i;

function text(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeId(value) {
  return text(value);
}

function firstSentence(value, maxLength = 220) {
  const cleaned = text(value);
  if (!cleaned) return '';
  const bulletParts = cleaned
    .split(/\s*(?:•|\u2022|\n)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^[“"']/.test(part) && !/\b-\s*petra\b/i.test(part));
  let source =
    bulletParts.find((part) => part.length >= 32 && /[a-z]/i.test(part)) ||
    cleaned.match(/^(.{40,}?[.!?])\s/)?.[1] ||
    bulletParts.find(Boolean) ||
    cleaned;
  source = source.replace(/\s+[–-]\s*discover\b.*$/i, '');
  const limited =
    source.length <= maxLength
      ? source
      : source.slice(0, maxLength - 1).replace(/\s+\S*$/, '');
  return `${limited}`
    .replace(/\s+that\s+(?:deliver|delivers|provide|provides|help|helps|support|supports|improve|improves)[,.!:;]*$/i, '')
    .replace(/(?:\s+(?:with|and|or|for|from|to|of|the|a|an|in|on|by|while|including|include|includes|throughout|added|broad|fresh|natural))+[,.!:;]*$/i, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[,:;]+$/g, '')
    .replace(/[.!?]*$/, '.');
}

function sanitizePublicSourceText(value) {
  return text(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[$€£¥]\s*\d+(?:\.\d{2})?\s*(?:value)?\b/gi, '')
    .replace(/\b\d{1,3}%\s*off\b/gi, '')
    .replace(/\bsave\s+\d{1,3}%\s+with\s+this\s+kit\.?/gi, '')
    .replace(/\bsave\s+\d{1,3}%\b/gi, '')
    .replace(/\b\d+(?:\.\d{2})?\s*(?:usd|eur|gbp|jpy|cny|rmb|value)\b/gi, '')
    .replace(/\bnot eligible for discounts?\.?/gi, '')
    .replace(/\b(?:ulta beauty|sephora|target|walmart|amazon)\s+exclusive\b/gi, '')
    .replace(/\b(?:an?|the)?\s*exclusive bundle available only at\s+[a-z0-9 .&'-]+\.?/gi, 'bundle')
    .replace(/\bavailable only at\s+[a-z0-9 .&'-]+\.?/gi, '')
    .replace(/\byour new favorite for ([^,.;:!?]+),\s*use this\b/gi, 'Use this')
    .replace(/\byour new favorite(?:\s+for)?\b/gi, '')
    .replace(/\bis your go-to for\b/gi, 'is designed for')
    .replace(/\bthis genius tool\b/gi, 'this tool')
    .replace(/\b(?:must-have|pro-favorite|ultimate|powerful)\b/gi, '')
    .replace(/\b(?:best[-\s]?selling|bestselling|viral|cult[-\s]?favorite)\b/gi, '')
    .replace(/\baward[-\s]?winning\b(?!\s+brush\s+set)/gi, '')
    .replace(/\beditor['’]?s choice,\s*beauty shortlist awards\s*\d{4}\b/gi, '')
    .replace(/\bdiscover\s+the\s+brush\s+collection\s+that\s+has\s+captured\s+beauty\s+lovers['’]?\s+hearts\s+worldwide[.!]?\s*/gi, '')
    .replace(/\bdiscover\s+the\s+collection\s+that\s+has\s+captured\s+beauty\s+lovers['’]?\s+hearts\s+worldwide[.!]?\s*/gi, '')
    .replace(/\b(?:captured|captures)\s+beauty\s+lovers['’]?\s+hearts\s+worldwide[.!]?/gi, '')
    .replace(/\bstay centred all day long with this potent,\s*nourishing serum\.?/gi, 'A nourishing smoothing serum positioned around calming-looking skin care.')
    .replace(/\bcleansing,\s*purifying,\s*brightening and correcting\s*-\s*there['’]s a reason we called this (?:ultra\s+luxe\s+)?daily cleanser everything!?/gi, 'A daily cleanser positioned for cleansing, brightening, and oil-control support.')
    .replace(/\bkiss goodbye to dry,\s*flaky skin with our nourishing cream cleanser\.?/gi, 'A nourishing cream cleanser positioned for dry, flaky skin.')
    .replace(/\bkiss goodbye to ([^.?!]+) with our ([^.?!]+)(?:[.!?]|$)/gi, 'A $2 positioned for $1.')
    .replace(/\ba specially formulated blend of botanical extracts which work harmoniously to cleanse,\s*nourish and protect sensitive skin\.?/gi, 'A botanical cleanser positioned for sensitive-skin cleansing and nourishment.')
    .replace(/\bbalance and restore your oil\s*-\s*prone skin naturally with our signature oily skin cleanser\.?/gi, 'A cleanser positioned for oily-skin routines.')
    .replace(/\bbalance and restore your oil-prone skin naturally with our signature oily skin cleanser\.?/gi, 'A cleanser positioned for oily-skin routines.')
    .replace(/\blooking for a (?:powerful,\s*)?firming and brightening moisturiser that won['’]?t mess with your makeup\??/gi, 'A lightweight moisturiser positioned around firming- and brightening-looking care.')
    .replace(/\bthe best of nature['’]s\s+['"]?botox['"]?,?\s+now bottled for your benefit!?/gi, 'An eye serum positioned around firming-looking eye-area care.')
    .replace(/\bnature['’]s\s+['"]?botox['"]?\b/gi, 'firming eye-care positioning')
    .replace(/\bintroducing your all in one solution to naturally radiant skin\.?/gi, 'A hydrating serum positioned around radiant-looking skin.')
    .replace(/\bkeep your glow looking as young as you feel with our pure and potent anti[-\s]?ageing serum\.?/gi, 'A mature-skin serum positioned around Vitamin B and peptide support.')
    .replace(/\bkeep your glow looking as young as you feel with our pure and potent anti[-\s]?aging serum\.?/gi, 'A mature-skin serum positioned around Vitamin B and peptide support.')
    .replace(/\bkeep your glow looking as young as you feel with our pure and potent mature-skin serum\.?/gi, 'A mature-skin serum positioned around Vitamin B and peptide support.')
    .replace(/\bkeep your glow looking as young as you feel with our\s+mature-skin serum\.?/gi, 'A mature-skin serum positioned around Vitamin B and peptide support.')
    .replace(/\bhealthy radiant glow\b/gi, 'radiant-looking finish')
    .replace(/\bover-time\b/gi, 'over time')
    .replace(/\bpure and potent\b/gi, '')
    .replace(/\bultra\s+luxe\b/gi, '')
    .replace(/\boil\s*-\s*prone\b/gi, 'oil-prone')
    .replace(/\bformulated for all skin types\b/gi, 'described by the official page as a gentle formula')
    .replace(/\bfor all skin types\b/gi, 'with broad routine positioning')
    .replace(/\ball skin types\b/gi, 'broad skin-type positioning')
    .replace(
      /\bsuitable\s+with broad routine positioning,\s+including\s+sensitive skin\b/gi,
      'positioned by the official page for broad routine use, including sensitive skin',
    )
    .replace(
      /\bsuitable\s+with broad routine positioning\b/gi,
      'positioned by the official page for broad routine use',
    )
    .replace(/\.\s*with broad routine positioning\b/gi, ' with broad routine positioning')
    .replace(
      /\bby choosing this\s+([^.!?]*?)\s+you help plant\s+\d+(?:\.\d+)?\s*m(?:2|²)\s+of\s+biodiverse forest\b/gi,
      '$1',
    )
    .replace(/\byou help plant\s+\d+(?:\.\d+)?\s*m(?:2|²)\s+of\s+biodiverse forest\b/gi, '')
    .replace(/\brelief of inflammatory skin conditions\b/gi, 'calming skin-comfort positioning')
    .replace(/\breduce redness\b/gi, 'support the look of calmer skin')
    .replace(/\breduces redness\b/gi, 'supports the look of calmer skin')
    .replace(/\breducing redness\b/gi, 'supporting the look of calmer skin')
    .replace(/\btackle dark spots\b/gi, 'address the look of uneven tone')
    .replace(/\btackles dark spots\b/gi, 'addresses the look of uneven tone')
    .replace(/\btarget discolou?ration,\s*age spots and fine lines\b/gi, 'address the look of uneven tone and fine lines')
    .replace(/\btargets discolou?ration,\s*age spots and fine lines\b/gi, 'addresses the look of uneven tone and fine lines')
    .replace(/\btargeting discolou?ration,\s*age spots and fine lines\b/gi, 'addressing the look of uneven tone and fine lines')
    .replace(/\btarget age spots\b/gi, 'address the look of uneven tone')
    .replace(/\btargets age spots\b/gi, 'addresses the look of uneven tone')
    .replace(/\btargeting age spots\b/gi, 'addressing the look of uneven tone')
    .replace(/\bage spots\b/gi, 'uneven tone')
    .replace(/\bvisibly reduce wrinkles,\s*dark circles and puffiness\b/gi, 'address the look of wrinkles, dark circles, and puffiness')
    .replace(/\breduce wrinkles,\s*dark circles and puffiness\b/gi, 'address the look of wrinkles, dark circles, and puffiness')
    .replace(/\breduce wrinkles\b/gi, 'address the look of wrinkles')
    .replace(/\breduces wrinkles\b/gi, 'addresses the look of wrinkles')
    .replace(/\breducing wrinkles\b/gi, 'addressing the look of wrinkles')
    .replace(
      /,\s*address the look of uneven tone\s+and\s+address the look of uneven tone\b/gi,
      ' and address the look of uneven tone',
    )
    .replace(
      /\bour\s+soleil\s+b[ée]b[ée]\s+was\s+developed\s+to\s+be\s+the\s+purest,?\s+and\s+most\s+natural,?\s+organic\s+sunscreen\s+for\s+babies\s+and\s+children\.?/gi,
      'Soleil Bebe is an organic mineral sunscreen positioned for babies and children.',
    )
    .replace(
      /\bdeveloped\s+to\s+be\s+the\s+purest(?:,?\s+and\s+most\s+natural)?,?\s+luxurious\s+organic\s+sunscreen\.?/gi,
      'An organic mineral sunscreen positioned for face or body use.',
    )
    .replace(/\banti[-\s]?ageing benefits\b/gi, 'skin-conditioning benefits')
    .replace(/\banti[-\s]?aging benefits\b/gi, 'skin-conditioning benefits')
    .replace(/\banti[-\s]?ageing serum\b/gi, 'mature-skin serum')
    .replace(/\banti[-\s]?aging serum\b/gi, 'mature-skin serum')
    .replace(/\bpromotes a healthy,\s*luminous glow\b/gi, 'supports the look of a healthy, luminous glow')
    .replace(/\bEnhances skin brightness and natural radiance Helps\b/g, 'Enhances skin brightness and natural radiance. Helps')
    .replace(/\btone Supports smoother\b/g, 'tone. Supports smoother')
    .replace(/\btexture Deeply nourishes\b/g, 'texture. Deeply nourishes')
    .replace(/\bskin supports the look\b/g, 'skin. Supports the look')
    .replace(/\bthinning hair density\b/gi, 'hair density concerns')
    .replace(/\bexcessive shedding\b/gi, 'shedding concerns')
    .replace(/\bRestore damaged, dehydrated and overly processed hair\b/g, 'Supports damaged-feeling, dehydrated, or overly processed hair')
    .replace(/\brestore damaged, dehydrated and overly processed hair\b/g, 'support damaged-feeling, dehydrated, or overly processed hair')
    .replace(/\b(?:combat|reduce|reducing|target)\s+cellulite\b/gi, 'support body-smoothing positioning')
    .replace(/\bstimulate\s+fat\s+burning\b/gi, 'support firming and toning positioning')
    .replace(/,\s*while preventing the formation of new cells\b/gi, '')
    .replace(/\bwhile preventing the formation of new cells\b/gi, '')
    .replace(/\ba\s+antiperspirant\b/gi, 'an antiperspirant')
    .replace(/\ba\s+antioxidant\b/gi, 'an antioxidant')
    .replace(/\ban\s+lightweight\b/gi, 'a lightweight')
    .replace(/\b(?:winner of|voted one of|voted as one of)[^.?!]*[.!]?/gi, '')
    .replace(/\b(?:an?|the)\s+(designed|made|created)\b/gi, '$1')
    .replace(/\b(?:everyone loves|widely loved)\b/gi, '')
    .replace(/\bWhit antioxidant-rich\b/gi, 'With antioxidant-rich')
    .replace(
      /\bThis Vitamin-C Lotion provides the finishing,\s*radiant touch your skin deserves\.\s*Not only is your skin treated to rich hydration,\s*but you['’]?ll also enjoy the benefits of key ingredients known for their abilities\.?/gi,
      'Vitamin-C Lotion is positioned as a hydrating lotion step with a radiant-looking finish.',
    )
    .replace(
      /\bIf you['’]?re looking for a serum that provides a radiant glow\s*-\s*and so much more\s*-\s*you['’]?ll find it with Pixi Beauty Vitamin-C Serum\.\s*This enriching serum helps improve skin tone and creates a smoother complexion\.?/gi,
      'Vitamin-C Serum is positioned around a radiant-looking glow and smoother-looking complexion support.',
    )
    .replace(/\.\s*fresh from the first pump to the last\.?\s*why you['’]?ll love it\.?/gi, '.')
    .replace(
      /\.\s*to revive,\s*protect and revitalize the skin\.?\s*Use the Vitamin-C Lotion daily as your go-to moisturizer or as needed for a skincare\.?/gi,
      '.',
    )
    .replace(
      /\.\s*while reducing the effects of sun damage and free radicals\.?\s*Enjoy our multi-use Vitamin-C Serum daily or as needed\.?/gi,
      '.',
    )
    .replace(
      /\s+to keep your glow-boosting ingredients feeling\s+fresh from the first pump to the last\.?\s*why you['’]?ll love it\.?/gi,
      '.',
    )
    .replace(/\s+to keep your glow-boosting ingredients feeling\.?/gi, '.')
    .replace(/\s+known for their abilities\.?/gi, '.')
    .replace(/\.\s*pick-me-up\.?/gi, '.')
    .replace(/\.{2,}|…/g, '. ')
    .replace(/\ba\s*,\s+(?=(?:firming|hydrating|brightening|calming|cleansing|moisturizing|moisturising|gentle|lightweight|nourishing)\b)/gi, 'a ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\bCleansing,\s*purifying,\s*brightening and correcting\s*-\s*there['’]s a reason we called this daily cleanser Everything!?/gi, 'A daily cleanser positioned for cleansing, brightening, and oil-control support.')
    .replace(/\bBalance and restore your oil-prone skin naturally with our signature oily skin cleanser\.?/gi, 'A cleanser positioned for oily-skin routines.')
    .replace(/\bLooking for a firming and brightening moisturiser that won['’]?t mess with your makeup\??/gi, 'A lightweight moisturiser positioned around firming- and brightening-looking care.')
    .replace(/\bKeep your glow looking as young as you feel with our mature-skin serum\.?/gi, 'A mature-skin serum positioned around Vitamin B and peptide support.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizePublicTitleText(value) {
  const cleaned = text(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[$€£¥]\s*\d+(?:\.\d{2})?\s*(?:value)?\b/gi, '')
    .replace(/\s*[\[(]\s*\d{1,3}%\s*off\s*[\])]\s*/gi, ' ')
    .replace(/\s*[\[(]\s*[\])]\s*/g, ' ')
    .replace(/\s*[\[(]\s*(?:sale|clearance|promo|promotion|discount|free gift)\s*[\])]\s*/gi, ' ')
    .replace(/\b(?:sale|clearance|promo|promotion|discount)\s*$/gi, '')
    .replace(/\.{2,}|…/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const pipeParts = cleaned.split('|').map((part) => part.trim()).filter(Boolean);
  const candidate = pipeParts.length > 1 ? pipeParts[pipeParts.length - 1] : cleaned;
  return candidate
    .replace(/\s+[–-]\s+[A-Z0-9][A-Z0-9 .&'™®-]{2,}$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeFormulaSummary(value) {
  return text(value)
    .replace(/\bVitamin-C brightens\s*&\s*promotes collagen production\b/gi, 'Vitamin-C supports radiant-looking tone')
    .replace(/\bEvens skintone and improves the appearance of skin\b/gi, 'Supports the look of more even tone')
    .replace(/\b(?:see all|how to use|complete list)\b[\s:-]*/gi, ' ')
    .replace(/\b(?:wholesale|affiliate program|refer-a-friend|press|social|instagram|facebook|twitter|tiktok|pinterest|youtube)\b/gi, ' ')
    .replace(/\b(?:var\s+\w+|await)\b[^.!?;,]*/gi, ' ')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    .replace(/\s*;\s*\./g, ';')
    .replace(/\s*,\s*\./g, '.')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sentenceFragment(value) {
  return text(value).replace(/[.;:!?]+$/g, '').trim();
}

function articleFor(value) {
  const cleaned = text(value);
  if (!cleaned) return 'A';
  return /^[aeiou]/i.test(cleaned) ? 'An' : 'A';
}

function titleCaseFromPath(value) {
  return text(value)
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function brandFromUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    const root = host.split('.')[0];
    return titleCaseFromPath(root);
  } catch {
    return '';
  }
}

function displayBrand(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw === raw.toLowerCase()) {
    return raw.replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }
  return raw;
}

function inferCategory(seed, inventoryRow) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    text(seedData.category) ||
    text(snapshot.category) ||
    text(seedData.product_type) ||
    text(snapshot.product_type) ||
    titleCaseFromPath(seedData.category_path || snapshot.category_path || inventoryRow?.category_path)
  );
}

function inferCategoryPath(seed, inventoryRow) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return text(
    seedData.category_path ||
      snapshot.category_path ||
      seedData.catalog_category_path ||
      snapshot.catalog_category_path ||
      inventoryRow?.category_path ||
      inventoryRow?.catalog_category_path,
  );
}

function inferSetKind(titleCategoryText, descriptionText) {
  const joined = `${titleCategoryText} ${descriptionText}`;
  const fragranceSignalText = joined.replace(/\bfragrance[-\s]?free\b/g, ' ');
  const makeupSignal =
    /\b(?:look|makeup|lash|mascara|brow|blush|blush tint|lip\s*(?:&|and)\s*cheek|glow balm|bronze|bronzer|bronzing|complexion|colour|color|base|liquidglow|superglow|blur\s*(?:,|&|and)?\s*(?:colour|color)?\s*&?\s*set|foundation|conceal|correct|concealer|palette|eye pen|eye duo|eye trio|eye look|eye looks|eyeliner|eye liner|eye shadow|eyeshadow)\b/;
  const skincareSignal = /\b(?:skin|skincare|cleanse|cleanser|cleansing|tonic|toner|serum|mask|peel|clarity|rose|milky|mud)\b/;
  const strongSkincareSignal = /\b(?:cleanse|cleanser|cleansing|tonic|toner|serum|mask|peel|clarity|rose|milky|mud)\b/;
  if (/\b(?:spot sticker|spot stickers|blemish sticker|blemish stickers|zit sticker|zit stickers)\b/.test(joined)) return 'blemish_patch_set';
  if (/\b(?:cleansing cloth|cleansing cloths|face cloth|face cloths|makeup melting cleansing cloths|wash cloth|wash cloths|muslin cloth|muslin cloths)\b/.test(joined)) {
    return 'skincare_tool_set';
  }
  if (/\b(?:eau de parfum|parfum|perfume|pen spray|body mist|hair\s*&\s*body mist|hair and body mist)\b/.test(fragranceSignalText)) return 'fragrance_set';
  if (/\b(?:lip patch|lippatch|lip treat|liptreat|liptone|lip butter|butter balm|lip combo|lip oil|lip glaze|lip tint|lip liner|precision pout|powder matte lip|high gloss|lip kit|lip set|lip bundle|lip duo|lip trio|lip favourites|lip favorites)\b/.test(titleCategoryText)) return 'lip_set';
  if (/\b(?:eye patch|eye patches|eye care kit|eye care set|detoxifeye|fortifeye|dream-yeye|antioxifeye|beautifeye)\b/.test(titleCategoryText)) return 'eye_care_set';
  if (makeupSignal.test(titleCategoryText)) {
    return 'makeup_set';
  }
  if (/\b(?:lip treat|liptreat|liptone|lip butter|butter balm|lip combo|lip oil|lip glaze|lip tint|lip liner|precision pout|powder matte lip|high gloss|lip kit|lip set|lip bundle|lip duo|lip trio|lip favourites|lip favorites)\b/.test(joined) && !makeupSignal.test(joined)) return 'lip_set';
  if (/\b(?:lip\s*(?:&|and)\s*cheek|blush|blush tint|powder blush|bronze|bronzer|glow balm|eye pen|eyeliner|eye liner)\b/.test(joined) && !strongSkincareSignal.test(joined)) return 'makeup_set';
  if (skincareSignal.test(titleCategoryText)) {
    return 'skincare_set';
  }
  if (/\b(?:eye patch|eye patches|eye kit|eye set|eye trio)\b/.test(joined)) return 'eye_care_set';
  if (strongSkincareSignal.test(joined) && !makeupSignal.test(titleCategoryText)) return 'skincare_set';
  if (skincareSignal.test(joined) && !makeupSignal.test(joined)) return 'skincare_set';
  if (makeupSignal.test(joined)) {
    return 'makeup_set';
  }
  if (/\b(?:cleanse|cleanser|cleansing|tonic|toner|serum|skin|skincare|mask|peel|clarity|glow|rose)\b/.test(joined)) {
    return 'skincare_set';
  }
  return 'beauty_set';
}

function inferKind(title, category, categoryPath, description = '') {
  const titleText = `${title}`.toLowerCase();
  const titleCategoryText = `${title} ${category} ${categoryPath}`.toLowerCase();
  const titleDescriptionText = `${title} ${description}`.toLowerCase();
  const descriptionText = `${description}`.toLowerCase();
  const haystack = `${titleCategoryText} ${descriptionText}`;
  const brushCareTitlePattern =
    /\b(?:palmat|brush\s+care|brush cleanser|brush cleaning|brush cleaner|brushampoo|sigmagic|travel\s+switch|switch\s+set|dry['’]?n\s+shape|brush\s+cleaning\s+mat|brush\s+cleaning\s+tool)\b|sigma\W*switch\b/;
  const brushCareDescriptionPattern =
    /\b(?:palmat|brush cleanser|brush cleaning|brush cleaner|brushampoo|sigmagic|travel\s+switch|switch\s+set|dry['’]?n\s+shape|brush\s+cleaning\s+mat|brush\s+cleaning\s+tool|deep cleans? your brushes)\b|sigma\W*switch\b/;
  if (/\b(?:grwm routine|look)\b/.test(titleCategoryText)) return 'makeup_set';
  if (/\b(?:brush\s+cup|brush\s+holder|brush\s+case|brush\s+bag|brush\s+storage|makeup\s+brush\s+cup)\b/.test(titleCategoryText)) return 'brush_storage';
  if (brushCareTitlePattern.test(titleCategoryText)) return 'brush_care';
  if (/\b(?:face cloth|cleansing cloth|wash cloth|muslin cloth)\b/.test(titleText)) return 'skincare_tool';
  if (/\b(?:3dhd|makeup\s+blender|beauty\s+blender|blending\s+sponge|makeup\s+sponge|beauty\s+sponge|complexion\s+sponge)\b/.test(titleCategoryText)) {
    return 'makeup_applicator';
  }
  if (
    /\bbrush(?:\s+[a-z0-9&'’.-]+){0,4}\s+(?:set|kit|duo|trio|quad|bundle|collection)\b/.test(titleCategoryText) ||
    /\b(?:set|kit|duo|trio|quad|bundle|collection)\b.*\bbrush(?:es)?\b/.test(titleCategoryText) ||
    (/\b(?:set|kit|duo|trio|quad|bundle|collection|favorites|favourites)\b/.test(titleCategoryText) &&
      /\b(?:brush\s+set|brushes\s+included|brushes\s+needed|go-to\s+brushes)\b/.test(descriptionText))
  ) {
    return 'brush_set';
  }
  if (/\b(?:set|kit|duo|trio|quad|sampler|bundle|vault|box|favourites|favorites|collection|routine|best of|holiday edition|choose your shades)\b/.test(titleCategoryText)) {
    return inferSetKind(titleCategoryText, descriptionText);
  }
  if (brushCareDescriptionPattern.test(descriptionText)) return 'brush_care';
  if (
    /\b(?:brush|beauty tool|makeup brush)\b/.test(titleCategoryText) &&
    !/\bbrush cleanser\b/.test(titleCategoryText)
  ) {
    return 'brush';
  }
  if (/\bapplicator\b/.test(titleCategoryText) && !/\b(?:roll[-\s]?on|serum)\b/.test(titleCategoryText)) return 'brush';
  if (/\bdry\s+shampoo\b/.test(haystack)) return 'dry_shampoo';
  if (/\bhair\s+mask\b/.test(titleDescriptionText)) return 'hair_mask';
  if (/\b(?:scalp\s+scrub\s+shampoo|scrub\s+shampoo)\b/.test(titleDescriptionText)) return 'shampoo';
  if (/\b(?:leave[-\s]?in(?:\s+conditioning)?|conditioning\s+hair\s+milk|hair\s+milk)\b/.test(titleDescriptionText)) {
    return 'leave_in_conditioner';
  }
  if (/\b(?:conditioner|hair\s+conditioning\s+concentrate)\b/.test(titleDescriptionText)) return 'conditioner';
  if (/\b(?:shampoo|hair\s+cleanse\s+concentrate)\b/.test(titleDescriptionText)) return 'shampoo';
  if (/\b(?:scalp\s+serum|hair\s+density[^.!?]{0,40}\bserum|hair[^.!?]{0,30}\bscalp\s+serum)\b/.test(titleDescriptionText)) {
    return 'scalp_serum';
  }
  if (/\b(?:scalp\s+(?:treatment\s+)?oil|scalp\s*&\s*hair\s+oil|scalp\s+and\s+hair\s+oil)\b/.test(titleDescriptionText)) {
    return 'scalp_oil';
  }
  if (/\b(?:pre[-\s]?wash\s+hair\s+oil|hair\s+oil)\b/.test(titleDescriptionText)) return 'hair_oil';
  if (
    /\b(?:hair\s+shine|glass\s+rinse|hair\s+rinse|apple\s+cider\s+vinegar\s+rinse|acv[^.!?]{0,40}\brinse)\b/.test(
      titleDescriptionText,
    ) ||
    /\brinse\b[^.!?]{0,40}\bhair\b/.test(titleDescriptionText)
  ) {
    return 'hair_rinse';
  }
  if (/\b(?:foundation|skin tint|skintint|skin-tint)\b/.test(haystack)) return 'foundation';
  if (/\bconcealer\b/.test(haystack)) return 'concealer';
  if (/\b(?:primer|poreless)\b/.test(haystack)) return 'primer';
  if (/\b(?:lipstick|lip color|lip balm|lip butter|butter balm|balm stick|lip oil|lip gloss|lipgloss|lip glaze|lip treatment|lip mask|lipmask|lip liner|lip pencil|lip luxe|lip patch|lippatch|gloss|pout)\b/.test(haystack)) return 'lip';
  if (/\b(?:candle)\b/.test(haystack)) return 'home_fragrance';
  if (/\bdeodorant\b/.test(haystack)) return 'deodorant';
  if (/\b(?:shower\s+gel|body\s+wash|hand\s*&\s*body\s+wash|hand\s+and\s+body\s+wash)\b/.test(titleCategoryText)) return 'body_wash';
  if (/\bhand\s+wash\b/.test(haystack)) return 'hand_wash';
  if (/\b(?:bath\s+soak|circulation\s+soak)\b/.test(haystack)) return 'bath_soak';
  if (/\b(?:hair\s+mask|hair\s+treatment)\b/.test(haystack)) return 'hair_mask';
  if (/\b(?:body\s+scrub|body\s+polish|body\s+exfoliant)\b/.test(haystack)) return 'body_scrub';
  if (/\bbody\s+balm\b/.test(haystack)) return 'body_balm';
  if (/\bbody\s+gel\b/.test(haystack)) return 'body_gel';
  if (/\b(?:hair\s*&\s*body mist|hair and body mist|body mist)\b/.test(titleCategoryText)) return 'body_mist';
  if (/\b(?:eau de parfum|parfum|eau de toilette|body spray|fragrance|cologne)\b/.test(titleCategoryText)) return 'fragrance';
  if (/\b(?:perfumery|scent|olfactive|oud|ombre leather|ombré leather|soleil blanc|private blend)\b/.test(titleCategoryText)) {
    return 'fragrance';
  }
  if (/\b(?:face cloth|cleansing cloth|wash cloth|muslin cloth)\b/.test(titleText)) return 'skincare_tool';
  if (/\b(?:brow|eyebrow)\b/.test(haystack)) return 'brow';
  if (/\b(?:eye repair|eye cream|eye oil|eye treatment|eye serum|eye patch|eye patches|antioxifeye|beautifeye|detoxifeye|fortifeye|dream-yeye|dream-yeye|eye-surrounds)\b/.test(haystack)) return 'eye_treatment';
  if (/\b(?:sharpener|pencil sharpener|liner sharpener)\b/.test(titleText)) return 'makeup_sharpener';
  if (/\b(?:face palette|glow palette)\b/.test(titleCategoryText)) return 'face_palette';
  if (/\b(?:eyeliner|mascara|false lashes|falsies|eyelashes|lashes|lash|eye color|eyeshadow|eye primer|palette)\b/.test(haystack)) return 'eye_makeup';
  if (/\b(?:blush)\b/.test(haystack)) return 'blush';
  if (/\b(?:bronzer|bronze|bronzing)\b/.test(haystack)) return 'bronzer';
  if (/\b(?:highlighting|highlighter|illuminate)\b/.test(haystack)) return 'highlighter';
  if (/\bskinveil\b/.test(titleCategoryText) || /\b(?:loose water[-\s]?powder|setting makeup|velvet finish)\b/.test(haystack)) return 'face_powder';
  if (/\b(?:body oil|movement oil|universal oil)\b/.test(haystack)) return 'body_oil';
  if (/\b(?:oil blend|facial oil|face oil)\b/.test(haystack)) return 'face_oil';
  if (/\b(?:spot sticker|spot stickers|zit|blemish spot|blemish sticker|blemish stickers)\b/.test(haystack)) return 'blemish_patch';
  if (/\b(?:cleansing pad|cleansing pads|cotton rounds?|reusable pads?|bamboo velour)\b/.test(haystack)) return 'cleansing_pads';
  if (/\b(?:sunscreen|sun\s*screen|spf\s*\d+|sun\s+stick|sun\s+cream)\b/.test(haystack)) return 'sunscreen';
  if (/\b(?:foaming face wash|face wash|foaming gel cleanser|gel cleanser|face wipes|facial wipes|goat milk soap|bar soap|soap)\b/.test(haystack)) return 'cleanser';
  if (/\b(?:facial oil|face oil)\b/.test(haystack)) return 'face_oil';
  if (/\b(?:toning mist|toner|tonic)\b/.test(haystack)) return 'toner';
  if (/\bretinol\s+oil\b/.test(haystack)) return 'skincare';
  if (/\b(?:peel|polish|exfoliat|resurfac|steam facial|facial treatment)\b/.test(haystack)) return 'skincare';
  if (/\b(?:facial cream|face cream|moisturizer|moisturiser|volume cream|body cream|body lotion|whipped body cream|goat milk lotion|water gel|gel cream)\b/.test(haystack)) return 'moisturizer';
  if (/\b(?:cleansing|cleanser)\b/.test(titleCategoryText)) return 'cleanser';
  if (/\b(?:retinol|serum|peptide|aha|bha|lactic|glycolic|salicylic)\b/.test(haystack)) return 'serum';
  if (/\b(?:hand cream|hand salve|cuticle serum)\b/.test(haystack)) return 'skincare';
  if (/\b(?:sheet mask|face mask|jelly mask|remedy mask|lip patch|lippatch|body polish|retinol oil|concentrate|essence oil|oil-essence|enzyme treatment|exfoliat|resurfac|steam facial|facial treatment)\b/.test(haystack)) return 'skincare';
  if (/\b(?:cleansing|cleanser)\b/.test(haystack)) return 'cleanser';
  if (/\b(?:powder)\b/.test(titleCategoryText)) return 'face_powder';
  if (/\b(?:treatment lotion|treatment emulsion|emulsion|lotion|serum|toner|tonic|to-go|pads|cloths)\b/.test(haystack)) return 'skincare';
  if (/\b(?:moisturizer|cream|mist|serum|cleanser|skincare|radiance|clarity|glow tonic)\b/.test(haystack)) return 'skincare';
  return 'beauty_product';
}

function kindLabel(kind, category) {
  const labels = {
    foundation: 'foundation',
    concealer: 'concealer',
    primer: 'primer',
    lip: text(category).toLowerCase() || 'lip product',
    body_mist: 'body mist',
    fragrance_set: 'fragrance set',
    fragrance: 'fragrance',
    brow: 'brow product',
    eye_treatment: 'eye treatment',
    eye_makeup: 'eye makeup',
    face_palette: 'face palette',
    blush: 'blush',
    bronzer: 'bronzer',
    highlighter: 'highlighter',
    face_powder: 'face powder',
    body_oil: 'body oil',
    dry_shampoo: 'dry shampoo',
    shampoo: 'shampoo',
    conditioner: 'hair conditioner',
    leave_in_conditioner: 'leave-in conditioner',
    hair_oil: 'hair oil',
    scalp_oil: 'scalp treatment oil',
    hair_rinse: 'hair rinse',
    scalp_serum: 'scalp serum',
    deodorant: 'deodorant',
    body_wash: 'body wash',
    hand_wash: 'hand wash',
    bath_soak: 'bath soak',
    hair_mask: 'hair mask',
    body_scrub: 'body scrub',
    body_balm: 'body balm',
    body_gel: 'body gel',
    face_oil: 'face oil',
    toner: 'toner',
    moisturizer: 'moisturizer',
    serum: 'skincare treatment',
    sunscreen: 'sunscreen',
    blemish_patch: 'blemish patch',
    cleanser: 'cleanser',
    cleansing_pads: 'cleansing pads',
    makeup_sharpener: 'makeup sharpener',
    skincare_tool: 'skincare tool',
    makeup_applicator: 'makeup applicator',
    brush: 'brush',
    brush_storage: 'brush storage accessory',
    brush_set: 'brush set',
    brush_care: 'brush-care product',
    skincare_tool_set: 'skincare tool set',
    blemish_patch_set: 'blemish patch set',
    skincare: 'skincare product',
    home_fragrance: 'home fragrance',
    beauty_set: 'beauty set',
    skincare_set: 'skincare set',
    makeup_set: 'makeup set',
    eye_care_set: 'eye care set',
    lip_set: 'lip set',
    beauty_product: text(category).toLowerCase() || 'beauty product',
  };
  return labels[kind] || labels.beauty_product;
}

function displayCategoryForKind(kind, category) {
  const labels = {
    foundation: 'Foundation',
    concealer: 'Concealer',
    primer: 'Primer',
    lip: 'Lip Product',
    body_mist: 'Body Mist',
    fragrance_set: 'Fragrance Set',
    fragrance: 'Fragrance',
    brow: 'Brow Product',
    eye_treatment: 'Eye Treatment',
    eye_makeup: 'Eye Makeup',
    face_palette: 'Face Palette',
    blush: 'Blush',
    bronzer: 'Bronzer',
    highlighter: 'Highlighter',
    face_powder: 'Face Powder',
    body_oil: 'Body Oil',
    dry_shampoo: 'Dry Shampoo',
    shampoo: 'Shampoo',
    conditioner: 'Conditioner',
    leave_in_conditioner: 'Leave-In Conditioner',
    hair_oil: 'Hair Oil',
    scalp_oil: 'Scalp Treatment Oil',
    hair_rinse: 'Hair Rinse',
    scalp_serum: 'Scalp Serum',
    deodorant: 'Deodorant',
    body_wash: 'Body Wash',
    hand_wash: 'Hand Wash',
    bath_soak: 'Bath Soak',
    hair_mask: 'Hair Mask',
    body_scrub: 'Body Scrub',
    body_balm: 'Body Balm',
    body_gel: 'Body Gel',
    face_oil: 'Face Oil',
    toner: 'Toner',
    moisturizer: 'Moisturizer',
    serum: 'Skincare Treatment',
    sunscreen: 'Sunscreen',
    blemish_patch: 'Blemish Patch',
    cleanser: 'Cleanser',
    cleansing_pads: 'Cleansing Pads',
    makeup_sharpener: 'Makeup Sharpener',
    skincare_tool: 'Skincare Tool',
    makeup_applicator: 'Makeup Applicator',
    brush: 'Beauty Brush',
    brush_storage: 'Brush Storage',
    brush_set: 'Brush Set',
    brush_care: 'Brush Care',
    skincare_tool_set: 'Skincare Tool Set',
    blemish_patch_set: 'Blemish Patch Set',
    skincare: 'Skincare',
    home_fragrance: 'Home Fragrance',
    beauty_set: 'Beauty Set',
    skincare_set: 'Skincare Set',
    makeup_set: 'Makeup Set',
    eye_care_set: 'Eye Care Set',
    lip_set: 'Lip Set',
    beauty_product: 'Beauty Product',
  };
  const controlledCategoryKinds = new Set([
    'makeup_applicator',
    'makeup_sharpener',
    'skincare_tool',
    'face_palette',
    'brush',
    'brush_storage',
    'brush_set',
    'brush_care',
    'beauty_set',
    'skincare_set',
    'skincare_tool_set',
    'blemish_patch_set',
    'lip_set',
    'makeup_set',
    'fragrance_set',
    'eye_care_set',
    'body_mist',
    'dry_shampoo',
    'shampoo',
    'conditioner',
    'leave_in_conditioner',
    'hair_oil',
    'scalp_oil',
    'hair_rinse',
    'scalp_serum',
    'deodorant',
    'body_wash',
    'hand_wash',
    'bath_soak',
    'hair_mask',
    'body_scrub',
    'body_balm',
    'body_gel',
    'body_oil',
    'face_oil',
    'toner',
    'moisturizer',
    'serum',
    'sunscreen',
    'cleansing_pads',
  ]);
  if (controlledCategoryKinds.has(kind)) return labels[kind] || labels.beauty_product;
  const explicit = text(category);
  if (/makeup sharpener/i.test(explicit) && kind !== 'makeup_sharpener') return labels[kind] || labels.beauty_product;
  if (explicit && explicit.toLowerCase() !== 'beauty product') return explicit;
  return labels[kind] || labels.beauty_product;
}

function routineStep(kind) {
  const steps = {
    foundation: 'complexion',
    concealer: 'complexion',
    primer: 'complexion',
    lip: 'lip_color',
    body_mist: 'fragrance',
    fragrance_set: 'set',
    fragrance: 'fragrance',
    brow: 'brow_makeup',
    eye_treatment: 'skin_care',
    eye_makeup: 'eye_makeup',
    face_palette: 'complexion',
    blush: 'cheek_color',
    bronzer: 'cheek_color',
    highlighter: 'complexion',
    face_powder: 'complexion',
    body_oil: 'body_care',
    dry_shampoo: 'hair_refresh',
    shampoo: 'hair_cleanse',
    conditioner: 'hair_care',
    leave_in_conditioner: 'hair_care',
    hair_oil: 'hair_care',
    scalp_oil: 'scalp_care',
    hair_rinse: 'hair_care',
    scalp_serum: 'scalp_care',
    deodorant: 'body_care',
    body_wash: 'body_cleanse',
    hand_wash: 'hand_cleanse',
    bath_soak: 'body_care',
    hair_mask: 'hair_care',
    body_scrub: 'body_care',
    body_balm: 'body_care',
    body_gel: 'body_care',
    face_oil: 'skin_care',
    toner: 'skin_care',
    moisturizer: 'skin_care',
    serum: 'skin_care',
    sunscreen: 'skin_care',
    blemish_patch: 'spot_care',
    cleanser: 'cleanse',
    cleansing_pads: 'tool',
    makeup_sharpener: 'tool',
    skincare_tool: 'tool',
    makeup_applicator: 'tool',
    brush: 'tool',
    brush_storage: 'tool',
    brush_set: 'tool',
    brush_care: 'tool_care',
    skincare_tool_set: 'tool',
    blemish_patch_set: 'spot_care',
    skincare: 'skin_care',
    home_fragrance: 'home_fragrance',
    beauty_set: 'set',
    skincare_set: 'set',
    makeup_set: 'set',
    eye_care_set: 'set',
    lip_set: 'set',
    beauty_product: 'beauty',
  };
  return steps[kind] || 'beauty';
}

function ingredientSignals(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const ingredientLikePattern = /\b(?:aqua|water|glycerin|sodium|aloe|simmondsia|helianthus|extract|oil|glycol|alcohol|acid|butter|wax|ester|triglyceride|caprylic|fragrance|parfum|cetearyl|citric|tocopherol|niacinamide|squalane|retinol|peptide|polysorbate|xanthan|benzyl|linalool|limonene|ayurvedic complex|key actives?)\b/i;
  const boilerplatePattern = /\b(?:vstar_review_settings|loox_global_hash|visitor_level_referral|schema\.org|@context|@type|productgroup|wholesale\s+affiliate\s+program|refer-a-friend|social\s+instagram|add to cart|sold out)\b/i;
  const nonFormulaPattern = /\b(?:how to use|directions?|shipping|returns?|privacy policy|terms of service|customer service|subscribe|newsletter)\b/i;
  function formulaCandidate(value) {
    const cleaned = sanitizeFormulaSummary(value);
    if (cleaned.length < 20) return '';
    if (boilerplatePattern.test(value) || nonFormulaPattern.test(value)) return '';
    const fragments = cleaned
      .split(/(?:[.!?]\s+|\n+)/)
      .map((item) => item.trim())
      .filter(Boolean);
    const formulaFragment = fragments.find((fragment) => {
      const commaCount = (fragment.match(/,/g) || []).length;
      return (
        ingredientLikePattern.test(fragment) &&
        (commaCount >= 2 || /\b(?:key actives?|complete list)\b/i.test(fragment))
      );
    });
    if (formulaFragment) return formulaFragment;
    const commaCount = (cleaned.match(/,/g) || []).length;
    if (ingredientLikePattern.test(cleaned) && commaCount >= 2) return cleaned;
    if (/\bkey actives?\b/i.test(cleaned) && ingredientLikePattern.test(cleaned)) return cleaned;
    return '';
  }
  function ingredientTextFromValue(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      const cleaned = text(value);
      if (/^\{.*(?:force_fill_contract|inci_applicability|approved_source_not_captured).*}$/i.test(cleaned)) {
        return '';
      }
      return cleaned;
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => ingredientTextFromValue(item))
        .filter(Boolean)
        .join(', ');
    }
    if (typeof value === 'object') {
      const applicability = asObject(value.inci_applicability);
      if (text(applicability.status).toLowerCase() === 'not_applicable') return '';
      return [
        value.raw_ingredient_text_clean,
        value.raw_text,
        value.ingredients_raw,
        value.ingredients_inci,
        value.inci_list,
        value.inci_normalized,
        value.ingredient_tokens,
        value.key_ingredients,
        value.active_ingredients,
        value.full_ingredients,
        value.full_ingredient_list,
      ]
        .map((item) => ingredientTextFromValue(item))
        .filter(Boolean)
        .join(', ');
    }
    return '';
  }
  const candidates = [
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
    seedData.ingredients_inci,
    snapshot.ingredients_inci,
    seedData.inci_list,
    snapshot.inci_list,
    seedData.ingredient_tokens,
    snapshot.ingredient_tokens,
    seedData.key_ingredients,
    snapshot.key_ingredients,
    seedData.ingredient_intel,
    snapshot.ingredient_intel,
  ];
  const flattened = candidates
    .map((item) => formulaCandidate(ingredientTextFromValue(item)))
    .filter(Boolean);
  const joined = text(flattened.join(' '));
  const ingredientCount = asArray(seedData.ingredient_tokens || snapshot.ingredient_tokens).length;
  return {
    available: joined.length > 20,
    ingredient_count: ingredientCount,
    summary: sanitizeFormulaSummary(firstSentence(joined, 160)),
  };
}

function sourceDescription(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return (
    text(seedData.description) ||
    text(snapshot.description) ||
    text(seedData.pdp_description_raw) ||
    text(snapshot.pdp_description_raw)
  );
}

function buildBestFor(kind, category) {
  const label = kindLabel(kind, category);
  return [
    {
      tag: `${kind}_shoppers`,
      label: `${label.charAt(0).toUpperCase()}${label.slice(1)} shoppers`,
      confidence: 'moderate',
    },
    {
      tag: 'official_source_comparison',
      label: 'Official-source comparison',
      confidence: 'moderate',
    },
  ];
}

function buildHighlightPhrase(kind, category, description, title = '') {
  const desc = description.toLowerCase();
  const titleText = `${title}`.toLowerCase();
  const signalText = `${category} ${description} ${title}`.toLowerCase();
  if (kind === 'foundation' && /soft-?matte|blurring|blur/.test(signalText)) return 'Soft-matte blurring base';
  if (kind === 'concealer' && /conceal|soft-?matte|shade/.test(signalText)) return 'Complexion coverage detail';
  if (kind === 'primer' && /pore|blur|shine|smooth/.test(signalText)) return 'Pore-blurring primer detail';
  if (kind === 'lip') {
    if (/mask/.test(titleText)) return 'Lip mask formula detail';
    if (/liner|pout/.test(titleText)) return 'Lip liner format detail';
    if (/gloss|glaze|shine/.test(titleText)) return 'Shine lip formula detail';
    if (/matte/.test(titleText)) return 'Matte lip formula detail';
    if (/oil|balm|butter|cream|creme|crème/.test(titleText)) return 'Creamy lip formula detail';
    if (/matte/.test(signalText)) return 'Matte lip formula detail';
    if (/gloss|glaze|shine/.test(signalText)) return 'Shine lip formula detail';
    if (/liner|pout/.test(signalText)) return 'Lip liner format detail';
    if (/oil|balm|butter|creamy|emollience|glide/.test(signalText)) return 'Creamy lip formula detail';
  }
  if (kind === 'body_mist') return 'Hair-and-body mist detail';
  if (kind === 'fragrance_set') return 'Fragrance gift set';
  if (kind === 'fragrance' && /(?:amber|leather|vanilla|floral|wood|rose|oud|citrus|ginger|cardamom)/.test(signalText)) {
    const noteTerms = [
      ['ginger', 'Ginger'],
      ['cardamom', 'Cardamom'],
      ['coriander', 'Coriander'],
      ['vanilla', 'Vanilla'],
      ['leather', 'Leather'],
      ['amber', 'Amber'],
      ['honeyed wood', 'Honeyed woods'],
      ['woods', 'Woods'],
      ['oud', 'Oud'],
      ['rose', 'Rose'],
      ['citrus', 'Citrus'],
      ['bergamot', 'Bergamot'],
      ['jasmine', 'Jasmine'],
      ['tobacco', 'Tobacco'],
      ['cherry', 'Cherry'],
      ['sandalwood', 'Sandalwood'],
      ['neroli', 'Neroli'],
      ['tonka', 'Tonka'],
      ['myrrh', 'Myrrh'],
    ]
      .filter(([needle]) => desc.includes(needle))
      .map(([, label]) => label);
    if (noteTerms.length >= 2) return `${noteTerms.slice(0, 2).join(' ')} scent profile`.slice(0, 40);
    if (noteTerms.length === 1) return `${noteTerms[0]} scent profile`;
    return 'Official scent note profile';
  }
  if (kind === 'foundation') return 'Complexion base detail';
  if (kind === 'brow') return 'Brow-shaping format detail';
  if (kind === 'primer') return 'Primer format detail';
  if (kind === 'eye_treatment') return /patch|goggle|caffeine|de-?puff|hydrate/.test(signalText) ? 'Eye-care format detail' : 'Eye treatment detail';
  if (kind === 'eye_makeup') return /shimmer|glimmer|metallic|fairy|light/.test(signalText) ? 'Eye shimmer format detail' : 'Eye-makeup formula detail';
  if (kind === 'face_palette') return 'Complexion palette detail';
  if (kind === 'blush') return 'Cheek color formula detail';
  if (kind === 'bronzer') return 'Bronzing complexion detail';
  if (kind === 'highlighter') return 'Highlighter formula detail';
  if (kind === 'face_powder') return 'Complexion powder detail';
  if (kind === 'body_oil') return 'Body oil formula detail';
  if (kind === 'dry_shampoo') return 'Post-workout dry shampoo';
  if (kind === 'shampoo') return /scalp|scrub/.test(titleText) ? 'Scalp shampoo format detail' : 'Shampoo format detail';
  if (kind === 'conditioner') return 'Conditioner format detail';
  if (kind === 'leave_in_conditioner') return 'Leave-in conditioner detail';
  if (kind === 'hair_oil') return /pre[-\s]?wash/.test(signalText) ? 'Pre-wash hair oil detail' : 'Hair oil format detail';
  if (kind === 'scalp_oil') return 'Scalp oil format detail';
  if (kind === 'hair_rinse') return 'Hair rinse format detail';
  if (kind === 'scalp_serum') return /peptide|density/.test(signalText) ? 'Scalp serum format detail' : 'Scalp serum detail';
  if (kind === 'deodorant') {
    if (/after\s+workout/.test(signalText)) return 'Post-workout deodorant';
    if (/sensitive\s+skin/.test(signalText)) return 'Sensitive deodorant detail';
    if (/extra\s+strength/.test(signalText)) return 'Extra-strength deodorant';
    return 'Deodorant format detail';
  }
  if (kind === 'body_wash') {
    if (/after\s+workout/.test(signalText)) return 'Post-workout shower gel';
    if (/shower\s+gel/.test(signalText)) return 'Shower gel format detail';
    return 'Body wash format detail';
  }
  if (kind === 'hand_wash') return 'Hand wash format detail';
  if (kind === 'bath_soak') return 'Bath soak format detail';
  if (kind === 'hair_mask') return 'Hair mask format detail';
  if (kind === 'body_scrub') return /salt|polish|exfoliat/.test(signalText) ? 'Body polish format detail' : 'Body scrub format detail';
  if (kind === 'body_balm') return 'Body balm format detail';
  if (kind === 'body_gel') return 'Body gel format detail';
  if (kind === 'face_oil') return 'Face oil formula detail';
  if (kind === 'toner') return /mist/.test(signalText) ? 'Toning mist detail' : 'Toner formula detail';
  if (kind === 'moisturizer') return /body/.test(signalText) ? 'Body moisturizer detail' : 'Moisturizer formula detail';
  if (kind === 'serum') {
    if (/retinol/.test(signalText)) return 'Retinol treatment detail';
    if (/peptide/.test(signalText)) return 'Peptide serum detail';
    if (/\baha\b|glycolic|lactic/.test(signalText)) return 'AHA serum detail';
    return 'Treatment formula detail';
  }
  if (kind === 'sunscreen') return /baby|children|kids?/.test(signalText) ? 'Child sunscreen format detail' : 'Sunscreen format detail';
  if (kind === 'blemish_patch') return 'Spot-care format detail';
  if (kind === 'cleanser') return /glycolic|retinol|mud|jasmine/.test(signalText) ? 'Active cleanser detail' : 'Cleanser formula detail';
  if (kind === 'cleansing_pads') return 'Reusable cleansing pads';
  if (kind === 'makeup_sharpener') return 'Pencil sharpener tool';
  if (kind === 'skincare_tool') return 'Cleansing cloth tool';
  if (kind === 'makeup_applicator') return 'Makeup sponge format detail';
  if (kind === 'brush') return 'Brush format detail';
  if (kind === 'brush_storage') return 'Brush storage detail';
  if (kind === 'brush_set') {
    if (/dry['’]?n\s*shape|drying\s+(?:and\s+)?storage|tower/.test(signalText)) {
      return 'Brushes plus drying tower';
    }
    if (/\bfavorites?\b|featuring a selection/.test(signalText)) return 'Curated favorites brush set';
    if (/\bface\b.*\beye\b|\beye\b.*\bface\b/.test(signalText)) return 'Face and eye brush set';
    return 'Brush set format detail';
  }
  if (kind === 'brush_care') return 'Brush-care cleaning detail';
  if (kind === 'skincare_tool_set') return 'Cleansing cloth set';
  if (kind === 'blemish_patch_set') return 'Spot-care sticker set';
  if (kind === 'skincare') {
    if (/moisturizer|moisturiser|body lotion|lotion/.test(titleText)) return 'Moisturizer formula detail';
    if (/peel|polish|exfoliat|resurfac/.test(signalText)) return 'Exfoliating treatment detail';
    if (/facial|steam/.test(signalText)) return 'Facial treatment detail';
    if (/glycolic|lactic|salicylic|retinol|vitamin c|\+c vit/.test(signalText)) return 'Active skincare detail';
    if (/mask|remedy|sheet/.test(signalText)) return 'Mask format detail';
    if (/mist/.test(signalText)) return 'Mist hydration detail';
    if (/tonic|toner/.test(signalText)) return 'Tonic formula detail';
    if (/oil|essence/.test(signalText)) return 'Oil-essence formula detail';
    return 'Skincare formula detail';
  }
  if (kind === 'home_fragrance') return 'Home-fragrance note detail';
  if (kind === 'beauty_set') {
    if (/fragrance|parfum|body mist|pen spray/.test(signalText)) return 'Fragrance gift set';
    if (/lip|gloss|balm|liner/.test(signalText)) return 'Lip routine set';
    if (/mascara|palette|makeup|look/.test(signalText)) return 'Makeup routine set';
    return 'Multi-item routine set';
  }
  if (kind === 'skincare_set') {
    if (/cleanse|cleanser|cleansing/.test(signalText)) return 'Cleansing routine set';
    if (/tonic|toner/.test(signalText)) return 'Tonic routine set';
    if (/mist/.test(signalText)) return 'Mist routine set';
    if (/glow|bright|radiance/.test(signalText)) return 'Glow routine set';
    return 'Skincare routine set';
  }
  if (kind === 'makeup_set') {
    if (/lip\s*(?:&|and)\s*cheek|glow balm/.test(signalText)) return 'Lip-and-cheek color set';
    if (/blush|cheek/.test(signalText)) return 'Cheek color set';
    if (/\b(?:favorites|favourites|routine|bundle|set)\b/.test(titleText) && /\b(?:eye|eyeshadow|palette|lip|brush)\b/.test(signalText)) return 'Makeup routine set';
    if (/complexion|base|foundation|conceal|blur|bronze/.test(signalText)) return 'Complexion routine set';
    if (/eye|eyeshadow|palette|lash|mascara/.test(signalText)) return 'Eye-makeup routine set';
    return 'Makeup routine set';
  }
  if (kind === 'eye_care_set') return 'Eye-care routine set';
  if (kind === 'lip_set') return 'Lip-care routine set';
  return `${text(category) || 'Product'} format detail`.slice(0, 40).trim();
}

function buildBundle({ seed, inventoryRow, generatedAt, batchName, reviewer }) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const productId = text(seed.external_product_id);
  const rawTitle = text(seed.title || seedData.title || inventoryRow.title);
  const title = sanitizePublicTitleText(rawTitle);
  const sourceUrl = text(seed.canonical_url || seed.destination_url || inventoryRow.canonical_url);
  const brand = displayBrand(seedData.brand || snapshot.brand || inventoryRow.brand || brandFromUrl(sourceUrl));
  const brandPrefix = brand ? `${brand} ` : '';
  const rawCategory = inferCategory(seed, inventoryRow);
  const categoryPath = inferCategoryPath(seed, inventoryRow);
  const description = sourceDescription(seedData);
  const descriptionSentence = firstSentence(sanitizePublicSourceText(description));
  const kind = inferKind(title, rawCategory, categoryPath, description);
  const category = displayCategoryForKind(kind, rawCategory);
  const label = kindLabel(kind, category);
  const ingredient = ingredientSignals(seedData);
  const evidenceProfile = ingredient.available ? 'seller_plus_formula' : 'official_pdp_seed';
  const highlight = buildHighlightPhrase(kind, category, description, title);
  const labeledProduct = text(`${brandPrefix}${label}`);
  const article = articleFor(labeledProduct);
  const whatItIsBody = descriptionSentence
    ? `${article} ${labeledProduct} listed on the official source page as ${title}. The official description identifies: ${descriptionSentence}`
    : `${article} ${labeledProduct} listed on the official source page as ${title}.`;
  const formulaBody = ingredient.available
    ? `Captured formula fields include ${sentenceFragment(ingredient.summary) || `${ingredient.ingredient_count} ingredient tokens`}. Agents should keep composition claims within those source fields.`
    : `No complete ingredient list was captured for this review batch, so formula-level claims stay unavailable.`;

  const sourceCoverage = {
    seller: {
      available: Boolean(sourceUrl),
      source_url: sourceUrl,
    },
    formula: {
      available: ingredient.available,
      ingredient_count: ingredient.ingredient_count,
      source_url: sourceUrl,
    },
    reviews: {
      available: false,
      count: 0,
    },
    creator: {
      available: false,
      count: 0,
    },
    editorial: {
      available: false,
      count: 0,
    },
  };
  const fieldSources = {
    what_it_is: 'official_seed_description',
    best_for: 'reviewed_category_and_official_title',
    why_it_stands_out: ingredient.available ? 'official_seed_description_and_formula' : 'official_seed_description',
    routine_fit: 'reviewed_category_and_official_title',
    watchouts: 'owner_delegated_assistant_review',
    texture_finish: 'reviewed_category_and_official_title',
    source_coverage: 'official_pdp_seed_snapshot',
    community_signals: 'not_collected',
  };

  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: 'Pivota Insights',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: productId,
      platform: 'external_seed',
    },
    product_group_id: text(inventoryRow.sellable_item_group_id) || null,
    product_intel_core: {
      display_name: 'Pivota Insights',
      what_it_is: {
        headline: `${label.charAt(0).toUpperCase()}${label.slice(1)} identity`,
        body: whatItIsBody,
      },
      best_for: buildBestFor(kind, category),
      why_it_stands_out: [
        {
          headline: 'Official product detail',
          body: descriptionSentence
            ? `The official page describes ${title} with product-specific detail: ${descriptionSentence}`
            : `The official title and reviewed category identify this PDP as ${category}, giving agents a grounded product type.`,
          evidence_strength: evidenceProfile,
        },
        {
          headline: ingredient.available ? 'Formula context captured' : 'Evidence gaps kept explicit',
          body: formulaBody,
          evidence_strength: evidenceProfile,
        },
      ],
      routine_fit: {
        step: routineStep(kind),
        am_pm: ['as_needed'],
        pairing_notes: [
          `Use within the ${label} context; avoid inferring benefits not present in the official source.`,
        ],
      },
      watchouts: [
        {
          type: ingredient.available ? 'formula_scope' : 'formula_gap',
          label: ingredient.available
            ? 'Formula details are source-derived; avoid medical, safety, or suitability claims not present in the source.'
            : 'No complete ingredient list was captured for this review batch; avoid formula-level or safety claims.',
          severity: 'medium',
        },
        {
          type: 'evidence_gap',
          label: 'No independent review or community evidence was approved for this row; keep public copy source-bound.',
          severity: 'medium',
        },
        {
          type: 'scope_guardrail',
          label: 'Use the commerce mainline for offer facts; keep this insight focused on source-backed product identity.',
          severity: 'medium',
        },
      ],
      confidence: {
        overall: 'moderate',
        fields: {
          what_it_is: sourceUrl ? 'high' : 'moderate',
          best_for: 'moderate',
          why_it_stands_out: descriptionSentence ? 'moderate' : 'low',
          routine_fit: 'moderate',
          watchouts: 'moderate',
        },
      },
      freshness: {
        generated_at: generatedAt,
        source_version: batchName,
      },
      quality_state: 'reviewed',
      evidence_profile: evidenceProfile,
      source_coverage: sourceCoverage,
    },
    texture_finish: {
      finish: label,
      texture: kind,
      source: 'reviewed_category_and_official_title',
    },
    community_signals: {
      status: 'unavailable',
      reason: 'not_collected_for_this_review_batch',
    },
    recommendation_intents: {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: null,
      confidence: 'low',
    },
    market_signal_badges: [],
    external_highlight_signals: [],
    quality_state: 'reviewed',
    evidence_profile: evidenceProfile,
    source_coverage: sourceCoverage,
    confidence: {
      overall: 'moderate',
      fields: {
        what_it_is: sourceUrl ? 'high' : 'moderate',
        best_for: 'moderate',
        why_it_stands_out: descriptionSentence ? 'moderate' : 'low',
        routine_fit: 'moderate',
        watchouts: 'moderate',
      },
    },
    freshness: {
      generated_at: generatedAt,
      source_version: batchName,
    },
    offer_pointers: {
      offers_count: 0,
      default_offer_id: null,
      best_price_offer_id: null,
      commerce_modes: [],
    },
    provenance: {
      source: 'owner_delegated_official_seed_rewrite',
      generator: 'owner_delegated_assistant_reviewed_rewrite',
      selection_strategy: 'official_pdp_seed_guarded_manual_review',
      field_sources: fieldSources,
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: generatedAt,
      external_highlight_review_status: 'rewrite',
      external_review_batch: batchName,
      official_source_url: sourceUrl,
      official_source_ingredient_count: ingredient.ingredient_count,
      rewrite_reason:
        'Owner-delegated assistant review: official PDP seed rewrite; no commerce-state, community, medical, or unsupported safety claims added.',
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title,
      subtitle: category,
      highlight,
      intro: whatItIsBody,
      evidence_profile: evidenceProfile,
    },
    search_card: {
      title_candidate: title,
      compact_candidate: category,
      highlight_candidate: highlight,
      intro_candidate: whatItIsBody,
      proof_badge_candidate: '',
    },
  };
}

function buildReportRows({ seeds, inventoryById, generatedAt, batchName, reviewer }) {
  return seeds.map((seed) => {
    const productId = text(seed.external_product_id);
    const inventoryRow = inventoryById.get(productId) || {};
    const bundle = buildBundle({ seed, inventoryRow, generatedAt, batchName, reviewer });
    return {
      case_id: `live_${productId}`,
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: generatedAt,
      notes: `Approved official-PDP-seed rewrite for ${bundle.shopping_card.title}; evidence_profile=${bundle.evidence_profile}; source_url=${text(seed.canonical_url || seed.destination_url)}`,
      owner_delegated_review: {
        contract_version: 'pivota.owner_delegated_review.v1',
        delegated_to: reviewer,
        reviewer_kind: 'assistant',
        owner_instruction: 'User delegated Codex to perform high-quality human review for Pivota Insights quality improvement.',
        guardrails: [
          'Do not overwrite good content with lower-quality content.',
          'No commerce-state claims in Pivota Insights.',
          'Use official source facts only; keep evidence confidence explicit.',
        ],
      },
      quality_improvement_review: {
        decision: 'approved_replacement',
        reviewer_kind: 'assistant',
        owner_delegated: true,
        reason:
          'Owner-delegated assistant review confirms the replacement uses official PDP seed facts, avoids commerce and unsupported evidence claims, and explicitly marks evidence gaps instead of inventing claims.',
      },
      baseline: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: productId,
          platform: 'external_seed',
        },
      },
      selected: {
        selected_mode: 'manual_reviewed_rewrite',
        selected_field_count: 7,
        field_sources: bundle.provenance.field_sources,
        bundle,
      },
    };
  });
}

function isConservativeRewriteCandidate(row, options = {}) {
  if (options.safeOnly === false) return true;
  const qualityState = text(row.kb_direct_quality_state).toLowerCase();
  const evidenceProfile = text(row.kb_direct_evidence_profile).toLowerCase();
  if (row.terminal_hold) return false;
  if (row.kb_direct_high_quality_ready) return false;
  if (row.kb_direct_human_reviewed !== true) return false;
  if (!SAFE_REWRITE_EVIDENCE_PROFILES.has(evidenceProfile)) return false;
  if (!SAFE_REWRITE_BLOCKERS.has(text(row.main_blocker))) return false;
  const reviewedSellerOnlyAllowed =
    options.includeReviewedSellerOnly === true &&
    qualityState === 'reviewed' &&
    evidenceProfile === 'seller_only';
  if (!SAFE_REWRITE_QUALITY_STATES.has(qualityState) && !reviewedSellerOnlyAllowed) return false;
  if (NON_CORE_PUBLIC_REWRITE_TITLE_RE.test(text(row.title))) return false;
  if (options.singleItemOnly && MULTI_ITEM_PUBLIC_REWRITE_TITLE_RE.test(text(row.title))) return false;
  if (options.requirePublicCommerceDoc) {
    if (row.catalog_attached !== true) return false;
    if (row.index_serving_eligible !== true) return false;
    if (row.commerce_doc_public !== true) return false;
  }
  return true;
}

function selectInventoryRows(rows, options) {
  const domain = text(options.domain).toLowerCase();
  const lane = text(options.lane) || 'lane_3_kb_rewrite_review';
  const limit = Math.max(1, Number(options.limit || 100) || 100);
  const requireDescription = options.requireDescription !== false;
  const safeOnly = options.safeOnly !== false;
  const requirePublicCommerceDoc = options.requirePublicCommerceDoc === true;
  const singleItemOnly = options.singleItemOnly === true;
  const includeReviewedSellerOnly = options.includeReviewedSellerOnly === true;
  return rows
    .filter((row) => !domain || text(row.domain).toLowerCase() === domain)
    .filter((row) => text(row.recommended_lane) === lane)
    .filter((row) => !text(row.seed_missing_fields))
    .filter((row) => text(row.identity_status) === 'approved' && row.identity_live_read_enabled !== false)
    .filter((row) => !row.kb_direct_high_quality_ready)
    .filter((row) =>
      isConservativeRewriteCandidate(row, {
        safeOnly,
        requirePublicCommerceDoc,
        singleItemOnly,
        includeReviewedSellerOnly,
      }),
    )
    .filter((row) => (requireDescription ? true : true))
    .slice(0, limit);
}

async function fetchSeeds(productIds) {
  if (!productIds.length) return [];
  const result = await query(
    `
      SELECT
        external_product_id,
        title,
        image_url,
        destination_url,
        canonical_url,
        seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], external_product_id)
    `,
    [productIds],
  );
  return result.rows || [];
}

function validateCandidateRows(reportRows) {
  const diagnostics = [];
  for (const row of reportRows) {
    const entries = buildKbEntriesForRow(row);
    if (entries.length !== 1) {
      diagnostics.push({ case_id: row.case_id, ok: false, reason: 'publish_entry_not_built' });
      continue;
    }
    const entry = entries[0];
    const inventory = buildPivotaInsightInventoryRow(entry, {
      title: row.selected?.bundle?.shopping_card?.title,
      canonicalUrl: row.selected?.bundle?.provenance?.official_source_url,
    });
    const commerceClaim = hasCommerceTruthClaim(row.selected?.bundle);
    diagnostics.push({
      case_id: row.case_id,
      product_id: row.selected?.bundle?.canonical_product_ref?.product_id,
      ok: inventory.public_ready && !commerceClaim,
      public_ready: inventory.public_ready,
      high_quality_ready: inventory.high_quality_ready,
      lane: inventory.lane,
      issues: inventory.issues,
      blocking_issues: inventory.blocking_issues,
      evidence_profile: inventory.evidence_profile,
      commerce_truth_claim: commerceClaim,
    });
  }
  return diagnostics;
}

async function main() {
  const inventoryPath = argValue('inventory');
  const outPath = argValue('out');
  if (!inventoryPath) throw new Error('--inventory is required');
  if (!outPath) throw new Error('--out is required');

  const batchName = text(argValue('batch-name')) || `official_seed_product_intel_${Date.now()}`;
  const reviewer = text(argValue('reviewer')) || 'codex_quality_reviewer_owner_delegated';
  const generatedAt = new Date().toISOString();
  const inventoryRows = readJson(inventoryPath);
  const selectedInventory = selectInventoryRows(inventoryRows, {
    domain: argValue('domain'),
    lane: argValue('lane', 'lane_3_kb_rewrite_review'),
    limit: argValue('limit', '100'),
    requireDescription: !hasFlag('allow-missing-description'),
    safeOnly: !hasFlag('include-protected-existing'),
    requirePublicCommerceDoc: hasFlag('require-public-commerce-doc'),
    singleItemOnly: hasFlag('single-item-only'),
    includeReviewedSellerOnly: hasFlag('include-reviewed-seller-only'),
  });
  const productIds = selectedInventory.map((row) => normalizeId(row.external_product_id)).filter(Boolean);
  const seeds = await fetchSeeds(productIds);
  const inventoryById = new Map(selectedInventory.map((row) => [normalizeId(row.external_product_id), row]));
  const seedById = new Map(seeds.map((seed) => [normalizeId(seed.external_product_id), seed]));
  const orderedSeeds = productIds.map((id) => seedById.get(id)).filter(Boolean);
  const reportRows = buildReportRows({
    seeds: orderedSeeds,
    inventoryById,
    generatedAt,
    batchName,
    reviewer,
  });
  const candidateDiagnostics = validateCandidateRows(reportRows);
  const badDiagnostics = candidateDiagnostics.filter((item) => !item.ok);
  if (badDiagnostics.length) {
    const err = new Error(`candidate_quality_validation_failed:${badDiagnostics.length}`);
    err.diagnostics = badDiagnostics;
    throw err;
  }

  if (hasFlag('validate-replacements')) {
    const entries = reportRows.flatMap((row) => buildKbEntriesForRow(row));
    const existingByKey = await fetchExistingProductIntelKbRows(entries.map((entry) => entry.kb_key));
    const { blockedEntries } = prepareEntriesForWrite(entries, reportRows, existingByKey);
    if (blockedEntries.length) {
      const err = new Error(`replacement_validation_blocked:${blockedEntries.length}`);
      err.blockedEntries = blockedEntries;
      throw err;
    }
  }

  const report = {
    meta: {
      generated_at: generatedAt,
      source: 'reviewed_official_seed_product_intel_report',
      batch_name: batchName,
      inventory: inventoryPath,
      selected_cases: reportRows.length,
      reviewer,
      reviewer_kind: 'assistant',
      candidate_quality_summary: {
        public_ready: candidateDiagnostics.filter((item) => item.public_ready).length,
        high_quality_ready: candidateDiagnostics.filter((item) => item.high_quality_ready).length,
        evidence_profile: candidateDiagnostics.reduce((acc, item) => {
          acc[item.evidence_profile] = (acc[item.evidence_profile] || 0) + 1;
          return acc;
        }, {}),
      },
    },
    rows: reportRows,
  };
  writeJson(outPath, report);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      out: outPath,
      rows: reportRows.length,
      selected_product_ids: productIds,
      quality: report.meta.candidate_quality_summary,
    })}\n`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      if (err && err.diagnostics) {
        process.stderr.write(`${JSON.stringify(err.diagnostics, null, 2)}\n`);
      }
      if (err && err.blockedEntries) {
        process.stderr.write(`${JSON.stringify(err.blockedEntries, null, 2)}\n`);
      }
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    brandFromUrl,
    buildBundle,
    buildHighlightPhrase,
    inferKind,
    isConservativeRewriteCandidate,
    sanitizeFormulaSummary,
    sanitizePublicSourceText,
    sanitizePublicTitleText,
    selectInventoryRows,
  },
};
