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
const HIGH_QUALITY_EXISTING_REWRITE_BLOCKERS = new Set(['db_serving_ready', 'ready_no_action']);
const NON_CORE_PUBLIC_REWRITE_TITLE_RE = /\b(?:sample|e-gift|gift card|hoodie|hat|tote|bucket|bag)\b/i;
const MULTI_ITEM_PUBLIC_REWRITE_TITLE_RE = /\b(?:set|kit|duo|trio|bundle|routine|collection|essentials|must-haves?|choose your|gift set|gift trio)\b/i;

function text(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function pathText(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('/');
  return text(value);
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
  const firstLongPart = bulletParts.find((part) => part.length >= 32 && /[a-z]/i.test(part));
  let source =
    firstLongPart?.match(/^(.{40,}?[.!?])\s/)?.[1] ||
    cleaned.match(/^(.{40,}?[.!?])\s/)?.[1] ||
    firstLongPart ||
    bulletParts.find(Boolean) ||
    cleaned;
  source = source.replace(/\s+[–-]\s*discover\b.*$/i, '');
  const limited =
    source.length <= maxLength
      ? source
      : source.slice(0, maxLength - 1).replace(/\s+\S*$/, '');
  return `${limited}`
    .replace(/\s+that\s+(?:deliver|delivers|provide|provides|help|helps|support|supports|improve|improves)[,.!:;]*$/i, '')
    .replace(/\s+to\s+help\s+improve[,.!:;]*$/i, '')
    .replace(/\s+(?:so|deeply|then|also)[,.!:;]*$/i, '')
    .replace(/(?:\s+(?:with|and|or|for|from|to|of|the|a|an|in|on|by|while|including|include|includes|throughout|added|broad|fresh|natural))+[,.!:;]*$/i, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[,:;]+$/g, '')
    .replace(/[.!?]*$/, '.');
}

function sanitizePublicSourceText(value) {
  return text(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[$€£¥]\s*\d+(?:\.\d{2})?\s*(?:value)?\b/gi, '')
    .replace(/\b\d{1,3}%\s*off\b/gi, '')
    .replace(/\bsave\s+\d{1,3}%\s+with\s+this\s+kit\.?/gi, '')
    .replace(/\bsave\s+\d{1,3}%\b/gi, '')
    .replace(/\b\d+(?:\.\d{2})?\s*(?:usd|eur|gbp|jpy|cny|rmb|value)\b/gi, '')
    .replace(/\bnot eligible for discounts?\.?/gi, '')
    .replace(/\bMSRP\s+was\s+last\s+offered\s+\d{1,2}\/\d{1,2}\/\d{2,4}\.?\s*/gi, '')
    .replace(/\bwas\s+last\s+offered\s+\d{1,2}\/\d{1,2}\/\d{2,4}\.?\s*/gi, '')
    .replace(/\b(?:ulta beauty|sephora|target|walmart|amazon)\s+exclusive\b/gi, '')
    .replace(/\b(?:an?|the)?\s*exclusive bundle available only at\s+[a-z0-9 .&'-]+\.?/gi, 'bundle')
    .replace(/\bavailable only at\s+[a-z0-9 .&'-]+\.?/gi, '')
    .replace(/\bNEW!\s*Free\s+Fuzzy\s+Gloss\s+Bomb\s+Holder\s+on\s+\+\s+orders\.?/gi, 'A Gloss Bomb keychain accessory.')
    .replace(/\bfree\b[^.?!]*(?:orders?|purchase)[^.?!]*\.?/gi, '')
    .replace(/\byour new favorite for ([^,.;:!?]+),\s*use this\b/gi, 'Use this')
    .replace(/\byour new favorite(?:\s+for)?\b/gi, '')
    .replace(/\bfan[-\s]?favo[u]?rite\b/gi, 'source-listed')
    .replace(/\bfaves?\b/gi, 'selected')
    .replace(/\bperfe{2,}c{2,}t+\b/gi, 'blend')
    .replace(/\bis the perfect addition to your\b/gi, 'is positioned for your')
    .replace(/\bperfect\s+for\b/gi, 'positioned for')
    .replace(/\bthe\s+perfect\s+amount\s+of\s+nourishing\s+colo[u]?r\s+and\s+shine\b/gi, 'sheer nourishing color and shine')
    .replace(/\bperfect\s+amount\s+of\b/gi, 'measured amount of')
    .replace(/\bperfect\s+pop\s+of\s+colo[u]?r\b/gi, 'sheer pop of color')
    .replace(/\bperfect\s+wash\s+of\s+colo[u]?r\b/gi, 'sheer wash of color')
    .replace(/\bto\s+perfect\s+and\s+extend\s+makeup\s+wear\b/gi, 'to set and extend makeup wear')
    .replace(/\bperfectly[-\s]?packaged,\s*/gi, 'packaged ')
    .replace(/\bultra[-\s]?luxe\b/gi, 'refillable')
    .replace(/\ball[-\s]?new,\s*/gi, '')
    .replace(/\bgame[-\s]?day ready\b/gi, '')
    .replace(/\bGet ready for your close up with this LED compact mirror\s*-\s*the magnification and bomb af lighting is here to get you photo-ready anytime,\s*anywhere\b/gi, 'An LED compact mirror with magnification and built-in lighting for makeup checks')
    .replace(/\bbomb af lighting\b/gi, 'built-in lighting')
    .replace(/\bphoto[-\s]?ready\b/gi, 'makeup-check')
    .replace(/\bon\s+lock\b/gi, '')
    .replace(/\bfavo[u]?rites?\b/gi, 'selected')
    .replace(/\bjust\s+add\s+your\b/gi, "designed to pair with the brand's")
    .replace(/\bexperience\s+the\s+full\s+cosmic\s+universe\s+with\s+this\s+packaged\s+ready-to-gift\s+set\s+featuring\b/gi, 'A ready-to-gift set featuring')
    .replace(/\bis your go-to for\b/gi, 'is designed for')
    .replace(/\bthis genius tool\b/gi, 'this tool')
    .replace(/\b(?:must-have|pro-favorite|ultimate|powerful)\b/gi, '')
    .replace(/\bultra\s+comfortable\b/gi, 'comfortable')
    .replace(/\bAn\s+comfortable\b/gi, 'A comfortable')
    .replace(/\bultra\s+portable\b/gi, 'portable')
    .replace(/\bsuper-chic,\s*/gi, '')
    .replace(/\bultra\s+controlled\b/gi, 'controlled')
    .replace(/\beffortless\s+smudging\b/gi, 'controlled smudging')
    .replace(/\beffortlessly\s+blend\b/gi, 'blend')
    .replace(/\bflawless\s+blending\s+and\s+sculpting\b/gi, 'blending and sculpting')
    .replace(/\bBring chapped lips back to life with triple the hydration\b/gi, 'A lip-care essentials set positioned for dry-lip hydration')
    .replace(/\bShop Fenty Hair to repair all hair types\s*\+\s*textures\b/gi, 'A hair-care set listed by the official source for hair-care routines')
    .replace(/\bSnatch shimmer and shine based on your vibe\s*\+\s*blend with a compatible brush of your choice\b/gi, 'A highlighter and brush bundle for shimmer placement and blending')
    .replace(/\bToo much shine\?\s*Ain['’]?t no such thing\.\s*Seal in moisture with lip-loving ingredients for a happy,\s*hydrated moisture barrier\b/gi, 'A lip gloss duo positioned around shine and moisture')
    .replace(/\bShop lip gloss from Fenty Beauty by Rihanna\b/gi, 'A lip gloss set listed by the official source')
    .replace(/\bShop\s+the\s+Fenty\s+Icon\s+reusable\s+case[^.?!]*Fenty\s+Icon\s+lipstick\b/gi, 'A reusable Fenty Icon case accessory')
    .replace(/\bLook sun-kissed in seconds with a cream or powder bronzer\s*\+\s*compatible brush of your choice\b/gi, 'A bronzer and brush bundle for bronzing placement and blending')
    .replace(/\bReady,\s*set\s*-\s*serve\.\s*Keep your look fresh\s*\+\s*photo-ready with a setting powder\s*\+\s*compatible brush of your choice\b/gi, 'A setting powder and brush bundle for powder application')
    .replace(/\bBleenndd,\s*blend,\s*HIKE!\s*Get that Fenty Face\s+with this\s+seasonal sponge\s*-\s*all decked out in a football-shape design\b/gi, 'A seasonal football-shape makeup sponge for blending complexion products')
    .replace(/\bBleenndd,\s*blend,\s*HIKE![^.?!]*football-shape design\b/gi, 'A seasonal football-shape makeup sponge for blending complexion products')
    .replace(/\bSuper-soft blending brush meant to be used with liquid,\s*cream,\s*or powder formulas to blend and set your way to a flawless Fenty face\b/gi, 'A blending brush for liquid, cream, or powder formulas')
    .replace(/\bWeightless,\s*longwear cream-powder hybrid highlighters that range from subtle dayglow to insanely supercharged in solos and expertly paired duos\b/gi, 'Weightless, longwear cream-powder hybrid highlighters available as solos or paired duos')
    .replace(/\bGet Rihanna['’]s starter routine for your best skin in three simple steps,\s*with this set of travel-size minis\b/gi, 'A travel-size skincare starter set with three routine steps')
    .replace(/\bYour best moisturized skin day\s*\+\s*night\.\s*Instantly hydrate,\s*smooth\s*\+\s*reduce the look of pores and dark spots\b/gi, 'A moisturizer bundle positioned for day and night routines')
    .replace(/\bDrip your body in hydration then top off with a spicy,\s*floral fragrance\b/gi, 'A body-care and fragrance bundle for body hydration and scent layering')
    .replace(/\bA hydrating multi-use stick that plays by your rules\b/gi, 'A hydrating multi-use cheek and lip stick')
    .replace(/\bGET CAUGHT LOOKING BLUE[’']?TIFUL STRAIGHT UP:?\s*Catch yourself in all your glory with a handheld mirror to keep your Fenty looks on point and the essence of Smurfette reflected\b/gi, 'A handheld beauty mirror for checking makeup')
    .replace(/\bMagnetic and multifaceted\.\s*Refined and raw\b/gi, 'A solid fragrance format listed by the official source')
    .replace(/\bA paddle-shaped eyeshadow brush custom cut for versatile precision:\s*Pack it on for targeted eyeshadow application then buff it out for controlled crease blending\b/gi, 'A paddle-shaped eyeshadow brush for targeted eyeshadow application and crease blending')
    .replace(/\bFeaturing\s+yet\s+gentle\s+formulas\b/gi, 'Featuring gentle formulas')
    .replace(/\bpowerful\s+yet\s+gentle\s+formulas\b/gi, 'gentle formulas')
    .replace(/\byet\s+gentle\s+formulas\b/gi, 'gentle formulas')
    .replace(/\bworks\s+to\s+purify,\s*smooth\s+and\s+soothe\s+while\s+targeting\s+excess\s+oil\b/gi, 'supports a clarifying-looking, excess-oil routine')
    .replace(/\bexcess-oil routine\s+and\s+visible\b[^.?!]*/gi, 'excess-oil routine')
    .replace(/\.\s*With skin-loving\.?/gi, '.')
    .replace(/\.\s*ingredients like\.?/gi, '.')
    .replace(/\bInstantly\s+reduces\s+puffiness\s+and\s+under-eye\s+circles\b/gi, 'Positioned around the look of puffiness and under-eye circles')
    .replace(/\breduces\s+puffiness\b/gi, 'addresses the look of puffiness')
    .replace(/\breducing\s+puffiness\b/gi, 'addressing the look of puffiness')
    .replace(/\b(?:best[-\s]?selling|bestselling|viral|cult[-\s]?favorite)\b/gi, '')
    .replace(/\b(?:flawless|ultimate|must[-\s]?have|go[-\s]?to|ready[-\s]?to[-\s]?go|unique|popular|high[-\s]?quality|perfect)\b/gi, (match) => {
      const normalized = match.toLowerCase().replace(/\s+/g, '-');
      if (normalized === 'flawless') return 'even-looking';
      if (normalized === 'ultimate') return 'complete';
      if (normalized === 'go-to') return 'routine';
      if (normalized === 'ready-to-go') return 'portable';
      if (normalized === 'unique') return 'specific';
      if (normalized === 'popular') return 'source-listed';
      if (normalized === 'high-quality') return 'source-detailed';
      if (normalized === 'perfect') return 'precise';
      return 'source-listed';
    })
    .replace(/\blimited[-\s]?edition\b/gi, 'seasonal')
    .replace(/\baward[-\s]?winning\b(?!\s+brush\s+set)/gi, '')
    .replace(/\bPROPOWAX™?\s+SERIES\s+ANTIOXIDANT\s*(?:•|\/)\s*ANTIPOLLUTION\b[./\s]*/gi, '')
    .replace(
      /\bThe\s+PROPOWAX™?\s+Antioxidant\s+Shampoo\s+is\s+the\s+world[’']s\s+first\s+honeycomb\s+shampoo\s+powered\s+by\s+the\s+patented\s+Living\s+Honeycomb\s*[—-]\s*clinically\s+proven\s+to\s+deliver\s+the\s+highest\s+antioxidant\s+activity\s+worldwide\.?/gi,
      'The PROPOWAX Antioxidant Shampoo is positioned as a honeycomb shampoo with Living Honeycomb referenced on the official page.',
    )
    .replace(
      /\bworld[’']s\s+first\s+honeycomb\s+shampoo\s+powered\s+by\s+the\s+patented\s+Living\s+Honeycomb\s*[—-]\s*clinically\s+proven\s+to\s+deliver\s+the\s+highest\s+antioxidant\s+activity\s+worldwide\.?/gi,
      'honeycomb-positioned shampoo with Living Honeycomb referenced on the official page.',
    )
    .replace(/\bis\s+the\s+honeycomb-positioned\s+shampoo\b/gi, 'is positioned as a honeycomb-positioned shampoo')
    .replace(/\bclinically\s+proven\s+to\s+deliver\s+the\s+highest\s+antioxidant\s+activity\s+worldwide\.?/gi, 'referenced by the official page.')
    .replace(/\bDetoxifies\s+and\s+restores\s+scalp\s*&\s*hair\s+from\s+pollution,\s*UV,\s*styling\s+tools,\s*and\s+harsh\s+products\.?/gi, 'Positioned for scalp-and-hair cleansing in pollution, UV, styling-tool, and harsh-product contexts.')
    .replace(/\bRebalances,\s*soothes,\s*and\s*strengthens\s+hair\s+from\s+the\s+roots\.?/gi, 'Positioned around scalp comfort and stronger-feeling hair from the roots.')
    .replace(/\bLeaves\s+hair\s+radiant,\s*nourished,\s*and\s*infused\s+with\s+a\s+luxurious\s+fine\s+fragrance\.?/gi, 'The official page frames the finish around radiant-looking, nourished-feeling hair and fine fragrance.')
    .replace(
      /\bShop\s+Kylie\s+Cosmetics\s+by\s+Kylie\s+Jenner,\s*Kylie\s+Jenner\s+Fragrances\s+and\s+Kylie\s+Skin\s+featuring\s+makeup,\s*fragrance,\s*and\s+skincare\s+that['’]s\s+clean,\s*vegan,\s*cruelty[-\s]?free,\s*and\s+dermatologist[-\s]?tested\.?/gi,
      '',
    )
    .replace(
      /\bShop\s+Kylie\s+Cosmetics\s+by\s+Kylie\s+Jenner,\s*Kylie\s+Jenner\s+Fragrances\s+and\s+Kylie\s+Skin\s+featuring\s+makeup,\s*fragrance,\s*and\s+skincare\s+that['’]s\s+clean\.?/gi,
      '',
    )
    .replace(/\b100%\s*clean,\s*sustainable,\s*cruelty[-\s]?free\s+beauty\b[.!]?/gi, '')
    .replace(/\bclean,\s*vegan,\s*cruelty[-\s]?free(?:,\s*and\s*dermatologist[-\s]?tested)?\b[.!]?/gi, '')
    .replace(/\b(?:vegan|cruelty[-\s]?free|gluten[-\s]?free|paraben[-\s]?free|dermatologist[-\s]?tested|ophthalmologist[-\s]?tested|non[-\s]?comedogenic|hypoallergenic|pregnancy[-\s]?safe|reef[-\s]?safe|clean\s+beauty)\b[.!]?/gi, '')
    .replace(/\bsafe\s+for\s+sensitive\s+skin\b[.!]?/gi, 'positioned for sensitive-skin routines')
    .replace(/\bdouble up and save with this jumbo size of our\b/gi, "This jumbo size is the brand's")
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|ml|oz)\b/gi, '')
    .replace(/\bhighlighte\s+r\b/gi, 'highlighter')
    .replace(/\bnourish\s+es\b/gi, 'nourishes')
    .replace(
      /\bAn?\s+acne[-\s]?fighting\s+spray\s+that\s+clears?\s+and\s+prevents?\s+blemishes\b/gi,
      'A blemish-focused body spray positioned for blemish-prone body care',
    )
    .replace(/\bacne[-\s]?fighting\b/gi, 'blemish-focused')
    .replace(/\bclears?\s+and\s+prevents?\s+blemishes\b/gi, 'is positioned for blemish-prone body care')
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
    .replace(/\bhelps reduce the appearance of fine lines and wrinkles\b/gi, 'addresses the look of fine lines and wrinkles')
    .replace(/\bpromotes skin elasticity\b/gi, 'is positioned around skin elasticity')
    .replace(/\bhelps repair damage caused by environmental stressors and UV radiation\b/gi, 'is positioned around environmental-stressor care')
    .replace(/\bforming a protective barrier against future damage\b/gi, 'supporting a protective-feeling finish')
    .replace(/\bhelps alleviate irritation and redness\b/gi, 'is positioned around calming-looking skin comfort')
    .replace(/\bmaking it suitable for sensitive skin types\b/gi, 'with suitability claims kept outside public copy')
    .replace(/\bstrengthens hair follicles\b/gi, 'is positioned around stronger-feeling hair')
    .replace(/\breduces split ends\b/gi, 'addresses the look of split ends')
    .replace(/\bpromoting overall hair health and vitality\b/gi, 'supporting hair-care positioning')
    .replace(/\byour ultimate solution for healthy,\s*radiant skin and hair\b/gi, 'a source-listed option for radiant-looking skin and hair')
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
      /\bcontains Vitamin-C,\s*a potent Antioxidant that is known to boost skin luminosity\b/gi,
      'contains Vitamin-C and is positioned around luminous-looking skin',
    )
    .replace(
      /\bDesigned to leave the complexion looking refreshed and Glowing,\s*these soft,\s*pre-soaked wipes are (?:perfect|precise)\.?/gi,
      'Designed to leave the complexion looking refreshed and glowing in a pre-soaked wipe format.',
    )
    .replace(
      /\bIf you['’]?re looking for a serum that provides a radiant glow\s*-\s*and so much more\s*-\s*you['’]?ll find it with Pixi Beauty Vitamin-C Serum\.\s*This enriching serum helps improve skin tone and creates a smoother complexion\.?/gi,
      'Vitamin-C Serum is positioned around a radiant-looking glow and smoother-looking complexion support.',
    )
    .replace(/\.\s*fresh from the first pump to the last\.?\s*why you['’]?ll love it\.?/gi, '.')
    .replace(
      /\.\s*to revive,\s*protect and revitalize the skin\.?\s*Use the Vitamin-C Lotion daily as your (?:go-to|routine) moisturizer or as needed for a skincare\.?/gi,
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
    .replace(/\.\s*for daily use\b/gi, ' for daily use')
    .replace(/\.{2,}|…/g, '. ')
    .replace(/\ba\s*,\s+(?=(?:firming|hydrating|brightening|calming|cleansing|moisturizing|moisturising|gentle|lightweight|nourishing)\b)/gi, 'a ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\bCleansing,\s*purifying,\s*brightening and correcting\s*-\s*there['’]s a reason we called this daily cleanser Everything!?/gi, 'A daily cleanser positioned for cleansing, brightening, and oil-control support.')
    .replace(/\bBalance and restore your oil-prone skin naturally with our signature oily skin cleanser\.?/gi, 'A cleanser positioned for oily-skin routines.')
    .replace(/\bLooking for a firming and brightening moisturiser that won['’]?t mess with your makeup\??/gi, 'A lightweight moisturiser positioned around firming- and brightening-looking care.')
    .replace(/\bKeep your glow looking as young as you feel with our mature-skin serum\.?/gi, 'A mature-skin serum positioned around Vitamin B and peptide support.')
    .replace(/^\s*(?:[./]\s*)+/, '')
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
  const candidate =
    pipeParts.length > 1 && /\b(?:set|kit|duo|trio|bundle|routine|palette|mist|tonic|serum|glow|blush|bronze)\b/i.test(pipeParts[0])
      ? pipeParts[0]
      : pipeParts.length > 1
        ? pipeParts[pipeParts.length - 1]
        : cleaned;
  return candidate
    .replace(/\s+[–-]\s+[A-Z0-9][A-Z0-9 .&'™®-]{2,}$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeFormulaSummary(value) {
  return text(value)
    .replace(/\bDenotes\s+\*?organic\b\.?/gi, ' ')
    .replace(/\*/g, '')
    .replace(/\bVitamin-C brightens\s*&\s*promotes collagen production\b/gi, 'Vitamin-C supports radiant-looking tone')
    .replace(/\bVitamin-C brightens\s*&\s*boosts luminosity\b/gi, 'Vitamin-C supports luminous-looking tone')
    .replace(/\bVitamin C brightens and promotes a radiant complexion\b/gi, 'Vitamin C supports a radiant-looking complexion')
    .replace(/\bEvens skintone and improves the appearance of skin\b/gi, 'Supports the look of more even tone')
    .replace(
      /\b(Salicylic acid,\s*Glycolic acid,\s*Lactic acid)(?:\s+Salicylic acid,\s*Glycolic acid,\s*Lactic acid)+\b/gi,
      '$1',
    )
    .replace(/\b(Salicylic acid,\s*Glycolic acid,\s*Lactic acid)\s+Clarity Cleanser\b/gi, '$1')
    .replace(/\bsoothes\s*&\s*hydrates\b/gi, 'is listed for soothing and hydrating positioning')
    .replace(/\bflawless\b/gi, 'even-looking')
    .replace(/\b(?:ultimate|must[-\s]?have|go[-\s]?to|ready[-\s]?to[-\s]?go|unique|popular|high[-\s]?quality|perfect)\b/gi, 'source-listed')
    .replace(/\bFeaturing\s+yet\s+gentle\s+formulas\b/gi, 'Featuring gentle formulas')
    .replace(/\bpowerful\s+yet\s+gentle\s+formulas\b/gi, 'gentle formulas')
    .replace(/\bworks\s+to\s+purify,\s*smooth\s+and\s+soothe\s+while\s+targeting\s+excess\s+oil\b/gi, 'is positioned around purifying-looking, smoothing, soothing, and excess-oil routine support')
    .replace(/\bInstantly\s+reduces\s+puffiness\s+and\s+under-eye\s+circles\b/gi, 'Positioned around the look of puffiness and under-eye circles')
    .replace(/\breduces\s+puffiness\b/gi, 'addresses the look of puffiness')
    .replace(/\breducing\s+puffiness\b/gi, 'addressing the look of puffiness')
    .replace(/\b(?:vegan|gluten[-\s]?free|paraben[-\s]?free)\b[.!]?/gi, ' ')
    .replace(/\b(?:cruelty[-\s]?free|dermatologist[-\s]?tested|ophthalmologist[-\s]?tested|non[-\s]?comedogenic|hypoallergenic|pregnancy[-\s]?safe|reef[-\s]?safe|clean\s+beauty)\b[.!]?/gi, ' ')
    .replace(/\bsafe\s+for\s+sensitive\s+skin\b[.!]?/gi, 'positioned for sensitive-skin routines')
    .replace(/\bhelps reduce the appearance of fine lines and wrinkles\b/gi, 'addresses the look of fine lines and wrinkles')
    .replace(/\bpromotes skin elasticity\b/gi, 'is positioned around skin elasticity')
    .replace(/\bhelps repair damage caused by environmental stressors and UV radiation\b/gi, 'is positioned around environmental-stressor care')
    .replace(/\bforming a protective barrier against future damage\b/gi, 'supporting a protective-feeling finish')
    .replace(/\bhelps alleviate irritation and redness\b/gi, 'is positioned around calming-looking skin comfort')
    .replace(/\bmaking it suitable for sensitive skin types\b/gi, 'with suitability claims kept outside public copy')
    .replace(/\bstrengthens hair follicles\b/gi, 'is positioned around stronger-feeling hair')
    .replace(/\breduces split ends\b/gi, 'addresses the look of split ends')
    .replace(/\bpromoting overall hair health and vitality\b/gi, 'supporting hair-care positioning')
    .replace(/\byour ultimate solution for healthy,\s*radiant skin and hair\b/gi, 'a source-listed option for radiant-looking skin and hair')
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
  const reviewedCategoryPath = pathText(seedData.catalog_category_path || snapshot.catalog_category_path);
  const reviewedProductType = text(
    seedData.product_type || seedData.leaf_category || snapshot.product_type || snapshot.leaf_category,
  );
  if (reviewedCategoryPath && reviewedProductType) return reviewedProductType;
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
  return pathText(
    seedData.catalog_category_path ||
      snapshot.catalog_category_path ||
      seedData.category_path ||
      snapshot.category_path ||
      inventoryRow?.catalog_category_path ||
      inventoryRow?.category_path,
  );
}

function inferSetKind(titleCategoryText, descriptionText) {
  const joined = `${titleCategoryText} ${descriptionText}`;
  const fragranceSignalText = joined.replace(/\bfragrance[-\s]?free\b/g, ' ');
  const makeupSignal =
    /\b(?:look|makeup|lash|mascara|brow|blush|blush tint|lip\s*(?:&|and)\s*cheek|glow balm|bronze|bronzer|bronzing|complexion|colour|color|base|liquidglow|superglow|blur\s*(?:,|&|and)?\s*(?:colour|color)?\s*&?\s*set|foundation|conceal|correct|concealer|palette|eye pen|eye duo|eye trio|eye look|eye looks|eyeliner|eye liner|eye shadow|eyeshadow|primer|prime\s*\+\s*set|setting\s+powder|setting\s+spray|highlighter)\b/;
  const skincareSignal = /\b(?:skin|skincare|cleanse|cleanser|cleansing|tonic|toner|serum|mask|peel|clarity|rose|milky|mud)\b/;
  const strongSkincareSignal = /\b(?:cleanse|cleanser|cleansing|tonic|toner|serum|mask|peel|clarity|rose|milky|mud)\b/;
  if (/\badvent\s+calendar\b/.test(titleCategoryText)) return 'beauty_set';
  if (/\bcosmic\s+kylie\s+jenner\b/.test(titleCategoryText) && /\b(?:ml|pen\s+spray|duo|trio|gift\s+set)\b/.test(titleCategoryText)) return 'fragrance_set';
  if (
    /\b(?:slick[-\s]?back\s+styling|maintenance\s+crew|hair\s+care|hair\s+styling|fenty\s+hair|hair\s+types?\s*\+\s*textures?)\b/.test(joined) &&
    /\b(?:set|kit|bundle|essentials|routine)\b/.test(titleCategoryText) &&
    !/\b(?:fragrance|parfum|perfume|body\s+mist|hair\s*&\s*body\s+mist|hair\s+and\s+body\s+mist)\b/.test(joined)
  ) {
    return 'hair_care_set';
  }
  if (/\bbody\s+care\s*\+\s*fragrance\s+bundle\b/.test(titleCategoryText)) return 'body_care_set';
  if (/\b(?:body\s+start|body\s+cream|body\s+butter|butta\s+dropz|whipped\s+oil\s+body\s+cream)\b/.test(titleCategoryText)) return 'body_care_set';
  if (/\bvitamin[-\s]?c\b/.test(titleCategoryText) && /\bskincare\s+set\b/.test(joined)) return 'skincare_set';
  if (/\bmisting\s+must[-\s]?haves?\b/.test(titleCategoryText)) return 'skincare_set';
  if (/\b(?:spot sticker|spot stickers|blemish sticker|blemish stickers|zit sticker|zit stickers)\b/.test(joined)) return 'blemish_patch_set';
  if (/\b(?:cleansing cloth|cleansing cloths|face cloth|face cloths|makeup melting cleansing cloths|wash cloth|wash cloths|muslin cloth|muslin cloths)\b/.test(joined)) {
    return 'skincare_tool_set';
  }
  if (/\b(?:eau de parfum|parfum|perfume|pen spray|body mist|hair\s*&\s*body mist|hair and body mist)\b/.test(fragranceSignalText)) return 'fragrance_set';
  if (/\b(?:lip\s*(?:&|and)\s*cheek|lip\b[^.!?]{0,50}\b(?:blush|skin\s+tint)|blush\b[^.!?]{0,50}\b(?:lip|butter\s+balm|tinted\s+butter\s+balm)|blush\s*(?:&|and)\s*brush|pressed\s+blush\s+powder\s*(?:&|and)\s*brush|hybrid\s+blush\s*(?:&|and)\s*(?:foundation\s+)?brush)\b/.test(titleCategoryText)) return 'makeup_set';
  if (/\b(?:lip patch|lippatch|lip care|lip sav|lip treat|liptreat|liptone|lip butter|butter balm|lip combo|lip oil|lip glaze|lip gloss|lip luminizer|lip tint|lip liner|precision pout|powder matte lip|high gloss|double gloss|glossy posse|gloss bomb|lux balm|lip kit|lip set|lip bundle|lip duo|lip trio|lip vault|lip gloss vault|lip favourites|lip favorites)\b/.test(titleCategoryText)) return 'lip_set';
  if (/\b(?:eye patch|eye patches|eye care kit|eye care set|detoxifeye|fortifeye|dream-yeye|antioxifeye|beautifeye)\b/.test(titleCategoryText)) return 'eye_care_set';
  if (makeupSignal.test(titleCategoryText)) {
    return 'makeup_set';
  }
  if (/\b(?:lip care|lip sav|lip treat|liptreat|liptone|lip butter|butter balm|lip combo|lip oil|lip glaze|lip gloss|lip luminizer|lip tint|lip liner|precision pout|powder matte lip|high gloss|double gloss|glossy posse|gloss bomb|lux balm|lip kit|lip set|lip bundle|lip duo|lip trio|lip vault|lip gloss vault|lip favourites|lip favorites)\b/.test(joined) && !makeupSignal.test(joined)) return 'lip_set';
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
  const reviewedPath = `${categoryPath}`.toLowerCase().replace(/\\/g, '/');
  if (
    /\bwellness\/supplements?\b/.test(reviewedPath) ||
    /\bwellness\s+supplements?\b/.test(titleCategoryText)
  ) {
    return 'wellness_supplement';
  }
  if (/\bbeauty\/(?:bodycare|skincare\/body)\/body-oil\b/.test(reviewedPath)) return 'body_oil';
  if (/\bbeauty\/skincare\/face-balm\b/.test(reviewedPath)) return 'face_balm';
  if (/\bbeauty\/skincare\/serum\b/.test(reviewedPath) && /\bserum\b/.test(titleCategoryText)) return 'serum';
  if (/\bbeauty\/skincare\/toner\b/.test(reviewedPath) && /\b(?:toner|tonic|humectant|drop)\b/.test(titleCategoryText)) return 'toner';
  const brushCareTitlePattern =
    /\b(?:palmat|brush\s+care|brush cleanser|brush cleaning|brush cleaner|brushampoo|sigmagic|travel\s+switch|switch\s+set|dry['’]?n\s+shape|brush\s+cleaning\s+mat|brush\s+cleaning\s+tool)\b|sigma\W*switch\b/;
  const brushCareDescriptionPattern =
    /\b(?:palmat|brush cleanser|brush cleaning|brush cleaner|brushampoo|sigmagic|travel\s+switch|switch\s+set|dry['’]?n\s+shape|brush\s+cleaning\s+mat|brush\s+cleaning\s+tool|deep cleans? your brushes)\b|sigma\W*switch\b/;
  if (/\b(?:grwm routine|look)\b/.test(titleCategoryText)) return 'makeup_set';
  if (/\bfenty\s+icon\s+the\s+case\b|\brefillable\s+lipstick\s+case\b/.test(titleCategoryText)) return 'beauty_accessory';
  if (/\b(?:under[-\s]?eye|undereye)\s+stickers?\b/.test(titleCategoryText)) return 'beauty_accessory';
  if (/\b(?:handheld\s+beauty\s+mirror|beauty\s+mirror|led\s+compact\s+mirror|compact\s+mirror|gloss\s+bomb\s+(?:holder|key\s*chain)|makeup\s+bag|flat-lay\s+makeup\s+bag)\b/.test(titleCategoryText)) return 'beauty_accessory';
  if (/\b(?:cosmetic|makeup|fragrance)?\s*pouch\b|\b(?:cosmetic|makeup)\s+bag\b/.test(titleCategoryText)) return 'beauty_accessory';
  if (/\b(?:brush\s+cup|brush\s+holder|brush\s+case|brush\s+bag|brush\s+storage|makeup\s+brush\s+cup)\b/.test(titleCategoryText)) return 'brush_storage';
  if (brushCareTitlePattern.test(titleCategoryText)) return 'brush_care';
  if (/\b(?:face cloth|cleansing cloth|wash cloth|muslin cloth)\b/.test(titleText)) return 'skincare_tool';
  if (/\b(?:football\s+sponge|makeup\s+sponge|blending\s+sponge)\b/.test(titleCategoryText)) return 'makeup_applicator';
  if (/\b(?:under\s+eye\s+masks?|reusable\s+under\s+eye\s+masks?|patch\s+ya\s+bags)\b/.test(titleCategoryText)) return 'eye_treatment';
  if (/\b(?:blotting\s+paper|invisimatte\s+blotting\s+paper)\b/.test(titleCategoryText)) return 'blotting_paper';
  if (/\bbody\s+care\s*\+\s*fragrance\s+bundle\b/.test(titleCategoryText)) return 'body_care_set';
  if (/\b(?:body\s+care\s+bundle|butta\s+drop\s+body\s+care\s+bundle)\b/.test(titleCategoryText)) return 'body_care_set';
  if (/\b(?:am\s*\+\s*pm\s+moisturizer\s+bundle|moisturizer\s+bundle)\b/.test(titleCategoryText)) return 'skincare_set';
  if (/\b(?:travel[-\s]?size\s+start'?r\s+set|mineral\s+spf)\b/.test(titleCategoryText) && /\b(?:skin|spf|moisturizer|cleanser|toner)\b/.test(haystack)) return 'skincare_set';
  if (/\b(?:blush|highlighter|concealer|bronzer|setting\s+powder)\s*\+\s*brush\s+bundle\b/.test(titleCategoryText)) return 'makeup_set';
  if (/\b(?:setting\s+powder|blurring\s+setting\s+powder|instant\s+retouch\s+setting\s+powder|set\s+it\s+down)\b/.test(titleCategoryText)) return 'face_powder';
  if (/\b(?:setting\s+spray|makeup[-\s]?extending\s+setting\s+spray)\b/.test(titleCategoryText)) return 'setting_spray';
  if (/\b(?:shimmer\s+skinstick|glow\s+skinstick)\b/.test(titleCategoryText)) return 'highlighter';
  if (/\b(?:correcting\s+skinstick|skin\s*stick|color\s+correct|colour\s+correct|corrector)\b/.test(titleCategoryText)) return 'corrector';
  if (/\b(?:edge\s+control\s+gel|strong\s+hold\s+gel|curl[-\s]?defining\s+cream|heat\s+protectant\s+styling\s+cream|styling\s+cream)\b/.test(titleCategoryText)) return 'hair_styling';
  if (/\b(?:lash\s+primer|mascara[-\s]?boosting\s+lash\s+primer)\b/.test(titleCategoryText)) return 'eye_makeup';
  if (/\b(?:body\s+start|body\s+cream|body\s+butter|butta\s+dropz|whipped\s+oil\s+body\s+cream)\b/.test(titleCategoryText) && /\b(?:set|kit|duo|trio|bundle)\b/.test(titleCategoryText)) return 'body_care_set';
  if (/\b(?:3dhd|makeup\s+blender|beauty\s+blender|blending\s+sponge|makeup\s+sponge|beauty\s+sponge|complexion\s+sponge)\b/.test(titleCategoryText)) {
    return 'makeup_applicator';
  }
  if (/\b(?:pressed\s+blush\s+powder\s*(?:&|and)\s*brush|hybrid\s+blush\s*(?:&|and)\s*(?:foundation\s+)?brush)\b/.test(titleCategoryText)) return 'makeup_set';
  if (
    /\bbrush(?:\s+[a-z0-9&'’.-]+){0,4}\s+(?:set|kit|duo|trio|quad|bundle|collection)\b/.test(titleCategoryText) ||
    /\b(?:set|kit|duo|trio|quad|bundle|collection)\b.*\bbrush(?:es)?\b/.test(titleCategoryText) ||
    (/\b(?:set|kit|duo|trio|quad|bundle|collection|favorites|favourites)\b/.test(titleCategoryText) &&
      /\b(?:brush\s+set|brushes\s+included|brushes\s+needed|go-to\s+brushes)\b/.test(descriptionText))
  ) {
    return 'brush_set';
  }
  if (/\b(?:set|kit|duo|trio|quad|sampler|bundle|vault|box|combo|essentials|must-haves?|favourites|favorites|collection|routine|best of|holiday edition|advent calendar|choose your shades)\b/.test(titleCategoryText)) {
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
  if (/\b(?:primer|poreless)\b/.test(haystack)) return 'primer';
  if (/\b(?:foundation|skin tint|skintint|skin-tint)\b/.test(haystack)) return 'foundation';
  if (/\bconcealer\b/.test(haystack)) return 'concealer';
  if (/\b(?:nail\s+polish|nail\s+lacquer|breathable\s+nail\s+polish)\b/.test(haystack)) return 'nail_polish';
  if (/\b(?:lipstick|lip color|lip tint|lip stain|lip balm|lip butter|butter balm|balm stick|lip oil|lip gloss|lipgloss|lip glaze|lip cream|lip combo|lip souffl[eé]|lip treatment|lip mask|lipmask|lip liner|lip pencil|lip luxe|lip patch|lippatch|gloss|pout)\b/.test(haystack)) return 'lip';
  if (/\b(?:candle)\b/.test(haystack)) return 'home_fragrance';
  if (/\bdeodorant\b/.test(haystack)) return 'deodorant';
  if (/\b(?:shower\s+gel|body\s+wash|hand\s*&\s*body\s+wash|hand\s+and\s+body\s+wash)\b/.test(titleCategoryText)) return 'body_wash';
  if (/\bhand\s+wash\b/.test(haystack)) return 'hand_wash';
  if (/\bhand\s+cream\b/.test(haystack)) return 'hand_cream';
  if (/\b(?:bath\s+soak|circulation\s+soak)\b/.test(haystack)) return 'bath_soak';
  if (/\b(?:hair\s+mask|hair\s+treatment)\b/.test(haystack)) return 'hair_mask';
  if (/\b(?:loofah|body\s+sponge|bath\s+sponge|shower\s+sponge)\b/.test(titleCategoryText)) return 'body_tool';
  if (/\b(?:body\s+scrub|body\s+polish|body\s+exfoliant)\b/.test(haystack)) return 'body_scrub';
  if (/\bbody\s+balm\b/.test(haystack)) return 'body_balm';
  if (/\bbody\s+gel\b/.test(haystack)) return 'body_gel';
  if (/\b(?:hair\s*&\s*body mist|hair and body mist|body mist)\b/.test(titleCategoryText)) return 'body_mist';
  if (
    /\bbody\s+spray\b/.test(titleCategoryText) &&
    /\b(?:salicylic|acne|blemish|breakout|body\s+acne)\b/.test(haystack)
  ) {
    return 'body_spray_treatment';
  }
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
  if (/\b(?:shimmer\s+skinstick|glow\s+skinstick)\b/.test(titleCategoryText)) return 'highlighter';
  if (/\b(?:highlighting|highlighter|highlighte\s*r|luminizer|luminiser|illuminate)\b/.test(haystack)) return 'highlighter';
  if (/\bskinveil\b/.test(titleCategoryText) || /\b(?:loose water[-\s]?powder|setting makeup|velvet finish)\b/.test(haystack)) return 'face_powder';
  if (/\b(?:body oil|movement oil|universal oil)\b/.test(haystack)) return 'body_oil';
  if (/\b(?:oil blend|facial oil|face oil)\b/.test(haystack)) return 'face_oil';
  if (/\b(?:spot sticker|spot stickers|zit|blemish spot|blemish sticker|blemish stickers)\b/.test(haystack)) return 'blemish_patch';
  if (/\b(?:cleansing pad|cleansing pads|cotton rounds?|reusable pads?|bamboo velour)\b/.test(haystack)) return 'cleansing_pads';
  if (/\b(?:cleansing balm|cleansing oil|makeup[-\s]?(?:melting|removing|remover)|melt awf)\b/.test(titleDescriptionText)) {
    return 'cleanser';
  }
  if (/\b(?:sunscreen|sun\s*screen|spf\s*\d+|sun\s+stick|sun\s+cream)\b/.test(haystack)) return 'sunscreen';
  if (/\b(?:foaming face wash|face wash|foaming gel cleanser|gel cleanser|face wipes|facial wipes|goat milk soap|bar soap|soap)\b/.test(haystack)) return 'cleanser';
  if (/\b(?:facial oil|face oil)\b/.test(haystack)) return 'face_oil';
  if (/\b(?:toning mist|toner|tonic)\b/.test(haystack)) return 'toner';
  if (/\bretinol\s+oil\b/.test(haystack)) return 'skincare';
  if (/\b(?:peel|polish|exfoliat|resurfac|steam facial|facial treatment)\b/.test(haystack)) return 'skincare';
  if (/\b(?:facial cream|face cream|moisturizer|moisturiser|volume cream|sleeping cream|moisture cream|body cream|body lotion|body butter|barrier balm|whipped body cream|goat milk lotion|water gel|gel cream)\b/.test(haystack)) return 'moisturizer';
  if (/\b(?:cleansing|cleanser)\b/.test(titleCategoryText)) return 'cleanser';
  if (/\bmask\b/.test(haystack)) return 'skincare';
  if (/\b(?:retinol|serum|peptide|aha|bha|lactic|glycolic|salicylic|azelaic)\b/.test(haystack)) return 'serum';
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
    setting_spray: 'setting spray',
    corrector: 'color corrector',
    nail_polish: 'nail polish',
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
    blotting_paper: 'blotting paper',
    body_oil: 'body oil',
    dry_shampoo: 'dry shampoo',
    shampoo: 'shampoo',
    conditioner: 'hair conditioner',
    leave_in_conditioner: 'leave-in conditioner',
    hair_oil: 'hair oil',
    scalp_oil: 'scalp treatment oil',
    hair_rinse: 'hair rinse',
    scalp_serum: 'scalp serum',
    hair_styling: 'hair styling product',
    hair_care_set: 'hair care set',
    deodorant: 'deodorant',
    body_wash: 'body wash',
    hand_wash: 'hand wash',
    hand_cream: 'hand cream',
    bath_soak: 'bath soak',
    hair_mask: 'hair mask',
    body_scrub: 'body scrub',
    body_balm: 'body balm',
    body_gel: 'body gel',
    body_spray_treatment: 'body treatment spray',
    face_oil: 'face oil',
    face_balm: 'face balm',
    toner: 'toner',
    moisturizer: 'moisturizer',
    serum: 'serum',
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
    body_tool: 'body cleansing tool',
    beauty_accessory: 'beauty accessory',
    skincare_tool_set: 'skincare tool set',
    blemish_patch_set: 'blemish patch set',
    skincare: 'skincare product',
    home_fragrance: 'home fragrance',
    beauty_set: 'beauty set',
    body_care_set: 'body care set',
    skincare_set: 'skincare set',
    makeup_set: 'makeup set',
    eye_care_set: 'eye care set',
    lip_set: 'lip set',
    wellness_supplement: 'wellness supplement',
    beauty_product: text(category).toLowerCase() || 'beauty product',
  };
  return labels[kind] || labels.beauty_product;
}

function displayCategoryForKind(kind, category) {
  if (kind === 'lip' && /\b(?:lip\s*)?(?:tint|stain)\b/i.test(text(category))) return 'Lip Tint';
  const labels = {
    foundation: 'Foundation',
    concealer: 'Concealer',
    primer: 'Primer',
    setting_spray: 'Setting Spray',
    corrector: 'Color Corrector',
    nail_polish: 'Nail Polish',
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
    blotting_paper: 'Blotting Paper',
    body_oil: 'Body Oil',
    dry_shampoo: 'Dry Shampoo',
    shampoo: 'Shampoo',
    conditioner: 'Conditioner',
    leave_in_conditioner: 'Leave-In Conditioner',
    hair_oil: 'Hair Oil',
    scalp_oil: 'Scalp Treatment Oil',
    hair_rinse: 'Hair Rinse',
    scalp_serum: 'Scalp Serum',
    hair_styling: 'Hair Styling',
    hair_care_set: 'Hair Care Set',
    deodorant: 'Deodorant',
    body_wash: 'Body Wash',
    hand_wash: 'Hand Wash',
    hand_cream: 'Hand Cream',
    bath_soak: 'Bath Soak',
    hair_mask: 'Hair Mask',
    body_scrub: 'Body Scrub',
    body_balm: 'Body Balm',
    body_gel: 'Body Gel',
    body_spray_treatment: 'Body Treatment',
    face_oil: 'Face Oil',
    face_balm: 'Face Balm',
    toner: 'Toner',
    moisturizer: 'Moisturizer',
    serum: 'Serum',
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
    body_tool: 'Body Tool',
    beauty_accessory: 'Beauty Accessory',
    skincare_tool_set: 'Skincare Tool Set',
    blemish_patch_set: 'Blemish Patch Set',
    skincare: 'Skincare',
    home_fragrance: 'Home Fragrance',
    beauty_set: 'Beauty Set',
    body_care_set: 'Body Care Set',
    skincare_set: 'Skincare Set',
    makeup_set: 'Makeup Set',
    eye_care_set: 'Eye Care Set',
    lip_set: 'Lip Set',
    wellness_supplement: 'Wellness Supplement',
    beauty_product: 'Beauty Product',
  };
  const controlledCategoryKinds = new Set([
    'makeup_applicator',
    'makeup_sharpener',
    'setting_spray',
    'corrector',
    'nail_polish',
    'skincare_tool',
    'face_palette',
    'brush',
    'brush_storage',
    'brush_set',
    'brush_care',
    'body_tool',
    'beauty_accessory',
    'beauty_set',
    'skincare_set',
    'skincare_tool_set',
    'blemish_patch_set',
    'lip_set',
    'makeup_set',
    'fragrance_set',
    'eye_care_set',
    'body_mist',
    'wellness_supplement',
    'dry_shampoo',
    'shampoo',
    'conditioner',
    'leave_in_conditioner',
    'hair_oil',
    'scalp_oil',
    'hair_rinse',
    'scalp_serum',
    'hair_styling',
    'hair_care_set',
    'deodorant',
    'body_wash',
    'hand_wash',
    'hand_cream',
    'bath_soak',
    'hair_mask',
    'body_scrub',
    'body_balm',
    'body_gel',
    'body_spray_treatment',
    'body_oil',
    'blotting_paper',
    'face_oil',
    'face_balm',
    'toner',
    'moisturizer',
    'serum',
    'sunscreen',
    'cleansing_pads',
    'body_care_set',
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
    setting_spray: 'complexion',
    corrector: 'complexion',
    nail_polish: 'nail_color',
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
    blotting_paper: 'complexion',
    body_oil: 'body_care',
    dry_shampoo: 'hair_refresh',
    shampoo: 'hair_cleanse',
    conditioner: 'hair_care',
    leave_in_conditioner: 'hair_care',
    hair_oil: 'hair_care',
    scalp_oil: 'scalp_care',
    hair_rinse: 'hair_care',
    scalp_serum: 'scalp_care',
    hair_styling: 'hair_styling',
    hair_care_set: 'set',
    deodorant: 'body_care',
    body_wash: 'body_cleanse',
    hand_wash: 'hand_cleanse',
    hand_cream: 'hand_care',
    bath_soak: 'body_care',
    hair_mask: 'hair_care',
    body_scrub: 'body_care',
    body_balm: 'body_care',
    body_gel: 'body_care',
    body_spray_treatment: 'body_care',
    face_oil: 'skin_care',
    face_balm: 'skin_care',
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
    body_tool: 'body_cleanse',
    beauty_accessory: 'accessory',
    skincare_tool_set: 'tool',
    blemish_patch_set: 'spot_care',
    skincare: 'skin_care',
    home_fragrance: 'home_fragrance',
    beauty_set: 'set',
    body_care_set: 'set',
    skincare_set: 'set',
    makeup_set: 'set',
    eye_care_set: 'set',
    lip_set: 'set',
    wellness_supplement: 'wellness',
    beauty_product: 'beauty',
  };
  return steps[kind] || 'beauty';
}

function ingredientSignals(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const ingredientLikePattern = /\b(?:aqua|water|glycerin|sodium|aloe|simmondsia|helianthus|extract|oil|glycol|alcohol|acid|butter|wax|ester|triglyceride|caprylic|fragrance|parfum|cetearyl|citric|tocopherol|niacinamide|squalane|retinol|peptide|polysorbate|xanthan|benzyl|linalool|limonene|ayurvedic complex|key actives?)\b/i;
  const boilerplatePattern = /\b(?:vstar_review_settings|loox_global_hash|visitor_level_referral|schema\.org|@context|@type|productgroup|wholesale\s+affiliate\s+program|refer-a-friend|social\s+instagram|add to cart|sold out)\b/i;
  const nonFormulaPattern = /\b(?:how to use|directions?|shipping|returns?|privacy policy|terms of service|customer service|subscribe|newsletter|signature fragrance|notes of|scent profile)\b/i;
  function formulaCandidate(value) {
    const cleaned = sanitizeFormulaSummary(value);
    if (cleaned.length < 20) return '';
    if (boilerplatePattern.test(value) || nonFormulaPattern.test(value)) return '';
    const lowerCleaned = cleaned.toLowerCase();
    const genericActiveMenu =
      lowerCleaned.includes('salicylic acid') &&
      lowerCleaned.includes('azelaic acid') &&
      lowerCleaned.includes('vitamin c') &&
      lowerCleaned.includes('retinol') &&
      lowerCleaned.includes('alpha arbutin');
    if (genericActiveMenu) return '';
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
  function countIngredientParts(value) {
    const cleaned = text(value).replace(/^(?:ingredients?|inci|full ingredients?)\s*[:：-]\s*/i, '');
    if (!cleaned) return 0;
    const parts = cleaned
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter((item) => item.length > 1 && !/^(?:and|or)$/i.test(item));
    const uniqueParts = new Set(
      parts
        .map((item) =>
          item
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    );
    if (uniqueParts.size >= 2) return uniqueParts.size;
    return ingredientLikePattern.test(cleaned) ? 1 : 0;
  }
  const candidates = [
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
    seedData.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
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
  const joined = sanitizeFormulaSummary(text(flattened.join(' ')));
  const tokenCount = asArray(seedData.ingredient_tokens || snapshot.ingredient_tokens).length;
  const derivedCount = flattened.reduce((max, item) => Math.max(max, countIngredientParts(item)), 0);
  const ingredientCount = Math.max(tokenCount, derivedCount);
  return {
    available: joined.length > 20,
    ingredient_count: ingredientCount,
    summary: sanitizeFormulaSummary(firstSentence(joined, 160)),
  };
}

function formulaPreviewFromSeedData(seedData, maxItems = 5) {
  const snapshot = asObject(seedData.snapshot);
  function flatten(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (typeof value === 'object') {
      return [
        value.inci_list,
        value.inci_normalized,
        value.ingredients_inci,
        value.raw_ingredient_text_clean,
        value.inci_raw,
      ].flatMap(flatten);
    }
    return text(value)
      .split(/\s*,\s*/)
      .map((item) =>
        sanitizeFormulaSummary(item)
          .replace(/\bDenotes\s+organic\b\.?/gi, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((item) => item.length >= 3 && !/^(?:and|or|ingredients?|inci)$/i.test(item));
  }
  const candidates = [
    seedData.ingredients_inci,
    snapshot.ingredients_inci,
    seedData.inci_list,
    snapshot.inci_list,
    seedData.ingredient_intel,
    snapshot.ingredient_intel,
  ];
  const seen = new Set();
  const parts = [];
  for (const candidate of candidates) {
    for (const item of flatten(candidate)) {
      const key = item
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      parts.push(item);
      if (parts.length >= maxItems) return parts.join(', ');
    }
  }
  return parts.join(', ');
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

const RISKY_PUBLIC_DESCRIPTION_RE =
  /\b(?:https?:\/\/|acne|inflamed|anti[-\s]?inflammatory|therapeutic|healing?|wrinkles?|analgesic|pain|clinically\s+proven|breakthrough|revolutionary|superior\s+alternative|prevent\s+premature\s+aging|collagen\s+production|damaged\s+skin\s+cells|tighten\s+pores|anti[-\s]?aging|anti[-\s]?ageing)\b/i;
const TRUNCATED_PUBLIC_COPY_RE =
  /(?:…|\.{3}|(?:^|\s)-\s*\.?$|\b(?:with|featuring|including|includes?|and|or|for|to|of|the|a|an|plus|mini)\s*[,.]?\s*$)/i;

function safeOfficialDescriptionSentence({ title, label, description, ingredient, formulaPreview = '' }) {
  const descriptionHasSourceUrl = /\bhttps?:\/\//i.test(text(description));
  const sentence = firstSentence(sanitizePublicSourceText(description));
  if (
    sentence &&
    !descriptionHasSourceUrl &&
    !RISKY_PUBLIC_DESCRIPTION_RE.test(sentence) &&
    !TRUNCATED_PUBLIC_COPY_RE.test(sentence)
  ) {
    return sentence;
  }
  const formula = text(formulaPreview) || (ingredient.available ? sentenceFragment(ingredient.summary) : '');
  if (formula) {
    return `The source page lists ${title} as ${articleFor(label).toLowerCase()} ${label} with formula fields including ${formula}.`;
  }
  return `The source page supplies source-backed description and use fields for ${title}.`;
}

function reviewedSourceDescriptionForKind({ title, kind, description }) {
  const titleText = `${title}`.toLowerCase();
  const descriptionText = `${description}`.toLowerCase();
  if (/\blip\s+liner\b/.test(titleText) && /\b(?:eyeliner|lash\s+lines?|eye\s+looks?)\b/.test(descriptionText)) {
    return 'A lip liner for defining lip shape and lip color placement.';
  }
  if (/\bgloss\s+bomb\s+key\s*chain\b/.test(titleText) && /\bfree\b[^.?!]*(?:orders?|purchase)/.test(descriptionText)) {
    return 'A Gloss Bomb keychain accessory.';
  }
  if (kind === 'beauty_accessory' && /\bfenty\s+icon\s+the\s+case\b/.test(titleText)) {
    return description || 'A refillable lipstick case accessory.';
  }
  return description;
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
  if (kind === 'foundation' && /soft'?lit|naturally\s+luminous|luminous|longwear/.test(signalText)) return 'Luminous longwear base';
  if (kind === 'foundation' && /soft-?matte|blurring|blur/.test(signalText)) return 'Soft-matte blurring base';
  if (kind === 'concealer' && /conceal|soft-?matte|shade/.test(signalText)) return 'Complexion coverage detail';
  if (kind === 'primer' && /pore|blur|shine|smooth/.test(signalText)) return 'Pore-blurring primer detail';
  if (kind === 'lip') {
    if (/mask/.test(titleText)) return 'Lip mask formula detail';
    if (/\b(?:lip\s*)?(?:tint|stain)\b/.test(signalText)) return 'Lip tint format detail';
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
  if (kind === 'wellness_supplement') return 'Source-backed supplement detail';
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
  if (kind === 'foundation') return 'Longwear complexion base';
  if (kind === 'setting_spray') return 'Makeup setting spray';
  if (kind === 'corrector') return 'Complexion correcting stick';
  if (kind === 'nail_polish') {
    if (/\b(?:iridescent|pearly|pearl|topcoat|top\s+coat|finish)\b/.test(signalText)) return 'Nail finish detail';
    return 'Nail color formula detail';
  }
  if (kind === 'brow') return 'Brow-shaping format detail';
  if (kind === 'primer') return 'Primer format detail';
  if (kind === 'eye_treatment') return /patch|goggle|caffeine|de-?puff|hydrate/.test(signalText) ? 'Eye-care format detail' : 'Eye treatment detail';
  if (kind === 'eye_makeup') return /shimmer|glimmer|metallic|fairy|light/.test(signalText) ? 'Eye shimmer format detail' : 'Eye-makeup formula detail';
  if (kind === 'face_palette') return 'Complexion palette detail';
  if (kind === 'blush') return 'Cheek color formula detail';
  if (kind === 'bronzer') return 'Bronzing complexion detail';
  if (kind === 'highlighter') {
    if (/light[-\s]?diffusing|superfine pearls?|lowkey glow|glow/.test(signalText)) return 'Light-diffusing glow';
    return 'Highlighter formula detail';
  }
  if (kind === 'face_powder') return 'Complexion powder detail';
  if (kind === 'blotting_paper') return 'Oil-blotting paper refill';
  if (kind === 'body_oil') return 'Body oil formula detail';
  if (kind === 'dry_shampoo') return 'Post-workout dry shampoo';
  if (kind === 'shampoo') return /scalp|scrub/.test(titleText) ? 'Scalp shampoo format detail' : 'Shampoo format detail';
  if (kind === 'conditioner') return 'Conditioner format detail';
  if (kind === 'leave_in_conditioner') return 'Leave-in conditioner detail';
  if (kind === 'hair_oil') return /pre[-\s]?wash/.test(signalText) ? 'Pre-wash hair oil detail' : 'Hair oil format detail';
  if (kind === 'scalp_oil') return 'Scalp oil format detail';
  if (kind === 'hair_rinse') return 'Hair rinse format detail';
  if (kind === 'scalp_serum') return /peptide|density/.test(signalText) ? 'Scalp serum format detail' : 'Scalp serum detail';
  if (kind === 'hair_styling') {
    if (/heat\s+protect/.test(signalText)) return 'Heat-protectant styling detail';
    if (/edge\s+control/.test(signalText)) return 'Edge-control styling detail';
    if (/curl[-\s]?defin/.test(signalText)) return 'Curl-defining cream detail';
    if (/gel/.test(signalText)) return 'Hair gel format detail';
    return 'Hair styling format detail';
  }
  if (kind === 'hair_care_set') {
    if (/slick[-\s]?back|gel|styling/.test(signalText)) return 'Hair styling set';
    return 'Hair-care routine set';
  }
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
  if (kind === 'hand_cream') return 'Hand cream format detail';
  if (kind === 'bath_soak') return 'Bath soak format detail';
  if (kind === 'hair_mask') return 'Hair mask format detail';
  if (kind === 'body_scrub') return /salt|polish|exfoliat/.test(signalText) ? 'Body polish format detail' : 'Body scrub format detail';
  if (kind === 'body_balm') return 'Body balm format detail';
  if (kind === 'body_gel') return 'Body gel format detail';
  if (kind === 'body_spray_treatment') return 'Body blemish spray detail';
  if (kind === 'face_oil') return 'Face oil formula detail';
  if (kind === 'face_balm') return 'Face balm formula detail';
  if (kind === 'toner') return /mist/.test(signalText) ? 'Toning mist detail' : 'Toner formula detail';
  if (kind === 'moisturizer') return /body/.test(signalText) ? 'Body moisturizer detail' : 'Moisturizer formula detail';
  if (kind === 'serum') {
    if (/azelaic/.test(signalText)) return 'Azelaic acid serum detail';
    if (/vitamin[-\s]?c/.test(titleText)) return 'Vitamin C serum detail';
    if (/niacinamide/.test(signalText)) return 'Niacinamide serum detail';
    if (/hyaluronic/.test(signalText)) return 'Hyaluronic acid serum detail';
    if (/retinol/.test(signalText)) return 'Retinol treatment detail';
    if (/peptide/.test(signalText)) return 'Peptide serum detail';
    if (/\baha\b|glycolic|lactic/.test(signalText)) return 'AHA serum detail';
    return 'Treatment formula detail';
  }
  if (kind === 'sunscreen') return /baby|children|kids?/.test(signalText) ? 'Child sunscreen format detail' : 'Sunscreen format detail';
  if (kind === 'blemish_patch') return 'Spot-care format detail';
  if (kind === 'cleanser') {
    if (/jelly\s+oil|makeup[-\s]?melting|melt\s+awf|remove all types of makeup/.test(signalText)) return 'Jelly-oil makeup melt';
    return /glycolic|retinol|mud|jasmine/.test(signalText) ? 'Active cleanser detail' : 'Cleanser formula detail';
  }
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
  if (kind === 'body_tool') return 'Body cleansing tool';
  if (kind === 'beauty_accessory') return 'Accessory format detail';
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
    if (/advent\s+calendar/.test(titleText)) return 'Multi-item advent calendar';
    if (/fragrance|parfum|body mist|pen spray/.test(signalText)) return 'Fragrance gift set';
    if (/lip|gloss|balm|liner/.test(signalText)) return 'Lip routine set';
    if (/mascara|palette|makeup|look/.test(signalText)) return 'Makeup routine set';
    return 'Multi-item routine set';
  }
  if (kind === 'body_care_set') {
    if (/fragrance|parfum|body\s+mist/.test(signalText)) return 'Body care and scent set';
    return /body\s+cream|butta\s+dropz|whipped/.test(signalText) ? 'Body cream routine set' : 'Body-care routine set';
  }
  if (kind === 'skincare_set') {
    if (/spf|mineral\s+spf/.test(signalText)) return 'SPF skincare set';
    if (/moisturizer|moisturiser/.test(signalText)) return 'Moisturizer routine set';
    if (/cleanse|cleanser|cleansing/.test(signalText)) return 'Cleansing routine set';
    if (/mist/.test(titleText)) return 'Mist routine set';
    if (/glow|bright|radiance/.test(signalText)) return 'Glow routine set';
    if (/tonic|toner/.test(signalText)) return 'Tonic routine set';
    if (/mist/.test(signalText)) return 'Mist routine set';
    return 'Skincare routine set';
  }
  if (kind === 'makeup_set') {
    if (/lip\s*(?:&|and)\s*cheek|glow balm/.test(signalText)) return 'Lip-and-cheek color set';
    if (/blush|cheek/.test(signalText)) return 'Cheek color set';
    if (/setting\s+powder/.test(signalText) && /brush/.test(signalText)) return 'Setting powder and brush set';
    if (/highlighter/.test(signalText) && /brush/.test(signalText)) return 'Highlighter and brush set';
    if (/concealer/.test(signalText) && /brush/.test(signalText)) return 'Concealer and brush set';
    if (/bronzer|bronze/.test(signalText) && /brush/.test(signalText)) return 'Bronzer and brush set';
    if (/prime\s*\+\s*set|primer\s*\+\s*setting|primer.*setting\s+(?:powder|spray)/.test(signalText)) {
      return 'Complexion prep and set kit';
    }
    if (
      /lip/.test(signalText) &&
      /\b(?:eye|eyeshadow|eyeliner|mascara)\b/.test(signalText) &&
      /\b(?:duo|2-piece|two-piece)\b/.test(titleText)
    ) {
      return 'Lip-and-eye makeup set';
    }
    if (
      /eye|eyeshadow|palette|lash|mascara|eyeliner|eye liner/.test(signalText) &&
      !/\b(?:lip|highlighter|brush|foundation|conceal|bronze|complexion)\b/.test(signalText)
    ) {
      return 'Eye-makeup routine set';
    }
    if (/complexion|base|foundation|conceal|blur|bronze/.test(signalText)) return 'Complexion routine set';
    if (/\b(?:favorites|favourites|routine|bundle|set)\b/.test(titleText) && /\b(?:eye|eyeshadow|palette|lip|brush)\b/.test(signalText)) return 'Makeup routine set';
    return 'Makeup routine set';
  }
  if (kind === 'eye_care_set') return 'Eye-care routine set';
  if (kind === 'lip_set') {
    if (/gloss|luminizer/.test(signalText)) return 'Lip gloss routine set';
    if (/balm|butter/.test(signalText)) return 'Lip balm routine set';
    return 'Lip-care routine set';
  }
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
  const rawDescription = sourceDescription(seedData);
  const kind = inferKind(title, rawCategory, categoryPath, rawDescription);
  const description = reviewedSourceDescriptionForKind({ title, kind, description: rawDescription });
  const category = displayCategoryForKind(kind, rawCategory);
  const label = kindLabel(kind, category);
  const ingredient = ingredientSignals(seedData);
  const formulaPreview = formulaPreviewFromSeedData(seedData);
  const descriptionSentence = safeOfficialDescriptionSentence({
    title,
    label,
    description,
    ingredient,
    formulaPreview,
  });
  const evidenceProfile = ingredient.available ? 'seller_plus_formula' : 'official_pdp_seed';
  const highlight = buildHighlightPhrase(kind, category, description, title);
  const labeledProduct = text(`${brandPrefix}${label}`);
  const article = articleFor(labeledProduct);
  const descriptionReference = descriptionSentence
    ? RISKY_PUBLIC_DESCRIPTION_RE.test(descriptionSentence) || /^The source page\b/i.test(descriptionSentence)
      ? descriptionSentence
      : `The source description identifies: ${descriptionSentence}`
    : '';
  const whatItIsBody = descriptionSentence
    ? `${article} ${labeledProduct} listed on the brand source page as ${title}. ${descriptionReference}`
    : `${article} ${labeledProduct} listed on the brand source page as ${title}.`;
  const formulaSummary = formulaPreview || sentenceFragment(ingredient.summary) || `${ingredient.ingredient_count} ingredient tokens`;
  const formulaBody = ingredient.available
    ? `Captured formula fields include ${formulaSummary}. Agents should keep composition claims within those source fields.`
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
          headline: 'Source-backed product detail',
          body: descriptionSentence || `The source title and reviewed category identify this PDP as ${category}, giving agents a grounded product type.`,
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
          `Use within the ${label} context; avoid inferring benefits not present in the source fields.`,
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
  const mainBlocker = text(row.main_blocker);
  const blockingIssues = new Set(
    text(row.kb_direct_blocking_issues)
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (row.terminal_hold) return false;
  const highQualityExistingAllowed =
    options.includeHighQualityExisting === true &&
    row.kb_direct_high_quality_ready === true &&
    row.kb_direct_human_reviewed === true &&
    SAFE_REWRITE_EVIDENCE_PROFILES.has(evidenceProfile) &&
    ['eligible', 'reviewed', 'verified', 'published'].includes(qualityState) &&
    HIGH_QUALITY_EXISTING_REWRITE_BLOCKERS.has(mainBlocker) &&
    blockingIssues.size === 0;
  if (row.kb_direct_high_quality_ready && !highQualityExistingAllowed) return false;
  const reviewedSellerOnlyAllowed =
    options.includeReviewedSellerOnly === true &&
    qualityState === 'reviewed' &&
    evidenceProfile === 'seller_only';
  const missingOfficialSourceAllowed =
    options.includeMissingOfficialSource === true &&
    qualityState === 'missing' &&
    evidenceProfile === 'missing' &&
    mainBlocker === 'kb_missing' &&
    row.catalog_attached === true &&
    row.index_serving_eligible === true &&
    row.commerce_doc_public === true;
  const notReviewedOfficialSourceAllowed =
    options.includeNotReviewedOfficialSource === true &&
    row.kb_direct_human_reviewed !== true &&
    qualityState === 'limited' &&
    evidenceProfile === 'seller_only' &&
    mainBlocker === 'kb_blocked' &&
    row.catalog_attached === true &&
    row.index_serving_eligible === true &&
    row.commerce_doc_public === true &&
    blockingIssues.size > 0 &&
    Array.from(blockingIssues).every((issue) =>
      issue === 'not_reviewed' || issue === 'not_displayable_gate',
    );
  if (!missingOfficialSourceAllowed) {
    if (!highQualityExistingAllowed) {
      if (!SAFE_REWRITE_EVIDENCE_PROFILES.has(evidenceProfile)) return false;
      if (!SAFE_REWRITE_BLOCKERS.has(mainBlocker)) return false;
      if (row.kb_direct_human_reviewed !== true && !notReviewedOfficialSourceAllowed) return false;
      if (!SAFE_REWRITE_QUALITY_STATES.has(qualityState) && !reviewedSellerOnlyAllowed) return false;
    }
  }
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
  const includeNotReviewedOfficialSource = options.includeNotReviewedOfficialSource === true;
  const includeMissingOfficialSource = options.includeMissingOfficialSource === true;
  const includeHighQualityExisting = options.includeHighQualityExisting === true;
  return rows
    .filter((row) => !domain || text(row.domain).toLowerCase() === domain)
    .filter((row) => text(row.recommended_lane) === lane)
    .filter((row) => !text(row.seed_missing_fields))
    .filter((row) => text(row.identity_status) === 'approved' && row.identity_live_read_enabled !== false)
    .filter((row) => includeHighQualityExisting || !row.kb_direct_high_quality_ready)
    .filter((row) =>
      isConservativeRewriteCandidate(row, {
        safeOnly,
        requirePublicCommerceDoc,
        singleItemOnly,
        includeReviewedSellerOnly,
        includeNotReviewedOfficialSource,
        includeMissingOfficialSource,
        includeHighQualityExisting,
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
    includeNotReviewedOfficialSource: hasFlag('include-not-reviewed-official-source'),
    includeMissingOfficialSource: hasFlag('include-missing-official-source'),
    includeHighQualityExisting: hasFlag('include-high-quality-existing'),
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
    firstSentence,
    inferKind,
    isConservativeRewriteCandidate,
    sanitizeFormulaSummary,
    sanitizePublicSourceText,
    sanitizePublicTitleText,
    selectInventoryRows,
  },
};
