'use strict';

// Pair evidence shared by retrieval, inference and serving. Product-line ids are
// deliberately not variant ids: an emulsion and an eye cream can share a line.
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function title(snapshot = {}) { return text(snapshot.title || snapshot.name || snapshot.display_name || snapshot.product_name); }
function brand(snapshot = {}) {
  const raw = snapshot.brand || snapshot.brand_name || snapshot.vendor || snapshot.brand_id;
  return text(typeof raw === 'object' ? raw.name : raw).toLowerCase();
}
function normalizedTitle(snapshot = {}) {
  return title(snapshot).normalize('NFKC')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ').trim();
}
const COSMETIC_ROLES = [
  ['bb_cream', /\bbb\s*cream\b/], ['cc_cream', /\bcc\s*cream\b/],
  ['mascara', /\bmascara\b/], ['eyeliner', /\beye\s*liner\b/], ['eyeshadow', /\beye\s*shadow\b/],
  ['highlighter', /\bhighlighter\b/], ['primer', /\bprimer\b/], ['brow', /\b(?:brow|eyebrow)\s*(?:pencil|gel|pomade|powder)\b/],
  ['foundation', /\b(?:powder\s*)?foundation\b/], ['concealer', /\bconcealer\b/],
  ['blush', /\b(?:cream\s*)?blush(?:er)?(?:\s*powder)?\b/], ['bronzer', /\bbronzer\b/],
  ['contour', /\bcontour(?:\s*powder)?\b/], ['lipstick', /\blipstick\b/],
  ['lip_gloss', /\blip\s*gloss\b/], ['lip_balm', /\blip\s*balm\b/],
  ['lip_tint', /\blip\s*(?:tint|stain)\b/], ['lip_oil', /\blip\s*oil\b/], ['lip_liner', /\blip\s*liner\b/],
  ['perfume', /\b(?:perfume|eau de parfum|eau de toilette)\b/],
  // Powder is a form, not a shared job: specific complexion jobs take priority.
  ['setting_powder', /\b(?:setting|finishing)\s*powder\b/],
  ['powder', /\b(?:face\s*)?powder\b/],
];
function optionRole(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const category = text(snapshot.category || snapshot.product_type).toLowerCase().replace(/[_-]+/g, ' ');
  // Application tools can name the cosmetic they apply. The actual tool job
  // precedes that target noun, while keeping foundation/blush/eye tools distinct.
  for (const source of [value, category]) {
    const tool = source.match(/\b(brush(?:es)?|sponge(?:s)?|applicator(?:s)?|puffs?|curlers?|tweezers?)\b/);
    if (!tool) continue;
    const kind = ['brush','sponge','applicator','puff','curler','tweezer'].find((name) => tool[1].startsWith(name));
    const cosmeticTarget = COSMETIC_ROLES.find(([, pattern]) => pattern.test(value)) ||
      COSMETIC_ROLES.find(([, pattern]) => pattern.test(category));
    const areaTarget = value.match(/\b(eye|lip|face|body|brow|lash)\b/) || category.match(/\b(eye|lip|face|body|brow|lash)\b/);
    const target = cosmeticTarget?.[0] || areaTarget?.[1];
    return target ? `${target}_${kind}` : kind;
  }
  // Product words can occur after punctuation; those tails are roles, not options.
  if (/\b(?:eyelashes|false[ -]?lashes?|(?:strip|individual|cluster)[ -]?lashes?|lash[ -]?(?:clusters|extensions))\b/.test(value)) return 'lashes';
  if (/\b(?:press[ -]?on nails|fake.*nails)\b/.test(value)) return 'nails';
  if (/\blash(?:es)?\b/.test(value) && /\b(?:glue|adhesive)\b/.test(value) && /\bremover\b/.test(value)) return 'lash_glue_remover';
  // Cleansing is a routine job, while cream is a form: a cleansing cream is not
  // the same step as a moisturizer merely because both names contain 'cream'.
  if (/\b(?:cleanser|cleansing|face wash|makeup remover)\b/.test(value) || /\b(?:cleanser|cleansing|face wash)\b/.test(category)) return 'cleanser';
  if (/\beye\b/.test(value) && /\b(?:cream|moisturi[sz]er)\b/.test(value)) return 'eye_cream';
  if (/\blip\b/.test(value) && /\b(?:sleeping )?mask\b/.test(value)) return 'lip_mask';
  // Specific cosmetic roles precede generic cream/serum words. An explicit leaf
  // category also identifies colour products whose titles omit the form noun.
  // Distinct jobs must remain distinct even under a shared collection head. The
  // supplied title wins over category fallback when both identify a product role.
  for (const source of [value, category]) {
    const matched = COSMETIC_ROLES.find(([, pattern]) => pattern.test(source));
    if (matched) return matched[0];
  }
  // 'Fragrance free' in a cream title is a formula trait, never a perfume job.
  if (/\bfragrance\b/.test(category)) return 'perfume';
  if (/\bmoisturi[sz]er\b/.test(value) || /\bmoisturi[sz]er\b/.test(category)) return 'cream';
  for (const role of ['emulsion', 'ampoule', 'essence', 'toner', 'cleanser', 'serum', 'cream', 'shampoo', 'conditioner']) {
    if (new RegExp(`\\b${role}\\b`).test(value)) return role;
  }
  return '';
}
const FORM_OR_FORMULA = /\b(?:liquid|powder|cream|gel|balm|stick|mousse|cushion|pencil|pen|oil|mist|spray|solid|loose|pressed|hydrating|long[ -]?wear|radiant|radiance|intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b|\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+/;
function variantCore(snapshot = {}) {
  const value = normalizedTitle(snapshot)
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|ml|oz|grams?|g|litres?|liters?)\b/g, ' ')
    .replace(/\s*#[^#]*$/, '').replace(/\s+/g, ' ').trim();
  const parts = value.split(/\s+-\s*|\s*[,|]\s*/);
  const role = optionRole(snapshot);
  const productPart = (part) => {
    const partRole = optionRole({title:part});
    // Decorative lash/nail option names can also be cosmetic shade nouns such
    // as 'Blush'. Only their actual product job makes such a segment substantive.
    if (['lashes','nails'].includes(role)) return partRole === role;
    return Boolean(partRole) || FORM_OR_FORMULA.test(part);
  };
  // A generic collection head is not a product identity. Retain substantive
  // tails rather than treating different products/formulas as collection options.
  // In lash/nail listings, descriptive option segments can surround the shared
  // product noun, so compare the head plus all product-bearing segments.
  const productParts = parts.slice(1).filter(productPart);
  if (!productPart(parts[0]) && !productParts.length && /[,|]/.test(value) &&
      !/^(?:shade|colou?r|style|scent|flavou?r)\s*:/i.test(text(snapshot.variant_title || snapshot.variant_detail_label))) return value;
  return [parts[0], ...productParts].join(' | ').replace(/\s+/g, ' ').trim();
}
function decorativeStructure(snapshot = {}) {
  const role = optionRole(snapshot);
  if (!['lashes','nails'].includes(role)) return {markers:[],unresolved:false};
  let remaining = normalizedTitle(snapshot);
  const markers = [];
  const consume = (pattern, marker) => {
    remaining = remaining.replace(pattern, (match) => {
      const values = typeof marker === 'function' ? marker(match) : [marker];
      markers.push(...values);
      return ' ';
    });
  };
  // Resolve negatives before positives, so 'non-magnetic' is not magnetic and
  // 'no glue required' cannot simultaneously require glue. Synonyms share modes.
  consume(/\b(?:non[ -]?magnetic|(?:not|no)[ -]?magnetic|without[ -]?magnets?)\b/g,'attachment:non_magnetic');
  consume(/\b(?:magnetic|magnets?)\b/g,'attachment:magnetic');
  consume(/\b(?:no[ -]?glue(?:[ -]?(?:is[ -]?)?(?:required|needed|necessary))?|(?:does[ -]?not|doesn['’]?t|not)[ -]?(?:require|need)[ -]?(?:(?:lash|nail)[ -]?)?glue|without[ -]?(?:(?:lash|nail)[ -]?)?glue|glue[ -]?(?:is[ -]?)?not[ -]?(?:required|needed|necessary)|glue[ -]?free|glueless|self[ -]?adhesive|pre[ -]?glued|pre[ -]?applied[ -]?adhesive|adhesive[ -]?tabs|stick[ -]?on)\b/g,'attachment:self_adhesive');
  consume(/\b(?:glue[ -]?(?:on|required|needed)|requires?[ -]?(?:(?:nail|lash)[ -]?)?glue|with[ -]?(?:(?:nail|lash)[ -]?)?glue)\b/g,'attachment:glue_required');
  consume(/\badhesive\b/g,'attachment:adhesive_unspecified');
  if (role === 'lashes') {
    consume(/\b(?:no|non|not|without)[ -]?(?:strip|individual|cluster)(?:[ -]?lashes?)?\b/g, (match) => [`construction:non_${match.match(/strip|individual|cluster/)[0]}`]);
    consume(/\b(?:(?:no|non|not|without)[ -]?(?:human[ -]?hair|mink|silk|synthetic(?:[ -]?fib(?:er|re)s?)?)|(?:human[ -]?hair|mink|silk|synthetic(?:[ -]?fib(?:er|re)s?)?)[ -]?free)\b/g, (match) => [`material:excluded_${match.match(/human[ -]?hair|mink|silk|synthetic/)[0].replace(/[ -]/g,'_')}`]);
    for (const [kind,pattern] of [
      ['strip',/\bstrip(?:[ -]?lashes?)?\b/g],
      ['individual',/\bindividual(?:[ -]?lashes?)?\b/g],
      ['cluster',/\b(?:cluster(?:[ -]?lashes?)?|lash[ -]?clusters?)\b/g],
      ['extension',/\bextensions?\b/g],
    ]) consume(pattern,`construction:${kind}`);
    consume(/\b(?:synthetic(?:[ -]?fib(?:er|re)s?)?|artificial(?:[ -]?fib(?:er|re)s?)?|faux[ -]?(?:mink|silk))\b/g,'material:synthetic');
    consume(/\bhuman[ -]?hair\b/g,'material:human_hair');
    consume(/\bmink\b/g,'material:mink');
    consume(/\bsilk\b/g,'material:silk');
  }
  if (role === 'nails') {
    consume(/\b(?:no[ -]?(?:(?:uv|led)[ -]?)?(?:lamp|light|cur(?:e|ing))(?:[ -]?(?:is[ -]?)?(?:required|needed|necessary))?|(?:does[ -]?not|doesn['’]?t|not)[ -]?(?:need|require)[ -]?(?:(?:uv|led)[ -]?)?(?:lamp|light|cur(?:e|ing))|(?:lamp|light)[ -]?free|air[ -]?dry(?:ing)?)\b/g,'curing:no_light');
    consume(/\b(?:(?:(?:uv|led)[ -]?)?cur(?:e|ing)[ -]?(?:required|needed)|(?:uv|led)[ -]?(?:lamp|light)(?:[ -]?(?:required|needed))?|(?:requires?|needs?)[ -]?(?:(?:uv|led)[ -]?)?(?:lamp|light|cur(?:e|ing)))\b/g, (match) => {
      const light = match.match(/uv|led/)?.[0];
      return light ? ['curing:light_required',`curing_light:${light}`] : ['curing:required_unspecified'];
    });
  }
  // Unknown functional declarations must not vanish into the ornamental tail.
  // Fail variant identity closed until that constraint can be classified.
  const unresolved = /\b(?:attachment|application|adhesion|adhesive|glue|magnetic|fib(?:er|re)s?|material|hair|synthetic|mink|silk|strip|individual|cluster|curing|cure|lamp|uv|led|requires?|required|needed|technology|system)\b/.test(remaining);
  return {markers:[...new Set(markers)].sort(),unresolved};
}
function formulaMarkers(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const markers = value.match(/\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+|\b(?:intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b/g) || [];
  // Attachment is a shopper constraint, independently of decorative style names.
  markers.push(...decorativeStructure(snapshot).markers);
  // Finish is meaningful for complexion/lip products. A lash collection's named
  // 'Glow Up' style remains an option, not a different cosmetic formulation.
  if (['powder', 'setting_powder', 'foundation', 'blush', 'bronzer', 'contour', 'lipstick', 'lip_gloss'].includes(optionRole(snapshot))) {
    markers.push(...(value.match(/\b(?:matte|glow|dewy|satin|shimmer|luminous)\b/g) || []));
  }
  return markers.sort().join('|');
}
function hasExplicitVariant(snapshot = {}) {
  if (/#/.test(normalizedTitle(snapshot))) return true;
  const role = optionRole(snapshot);
  // In these product roles a named shade, lash/nail style or lip-mask flavour is
  // an option. Other separator tails need structured option evidence.
  if (['lashes', 'nails', 'lip_mask', ...COSMETIC_ROLES.map(([name]) => name)].includes(role)) return /\s+-\s*|[,|]/.test(normalizedTitle(snapshot));
  return /^(?:shade|colou?r|style|scent|flavou?r)\s*:/i.test(text(snapshot.variant_title || snapshot.variant_detail_label));
}
function isSameFamilyVariant(anchor = {}, candidate = {}) {
  const aBrand = brand(anchor);
  if (!aBrand || aBrand !== brand(candidate)) return false;
  const aTitle = normalizedTitle(anchor);
  const bTitle = normalizedTitle(candidate);
  if (!aTitle || !bTitle || title(anchor) === title(candidate)) return false;
  const aRole = optionRole(anchor); const bRole = optionRole(candidate);
  // An option marker or shared line cannot establish variant identity when the
  // actual product jobs are unresolved. Unknown/unknown is not a matching job.
  if (!aRole || !bRole || aRole !== bRole) return false;
  if (decorativeStructure(anchor).unresolved || decorativeStructure(candidate).unresolved) return false;
  if (formulaMarkers(anchor) !== formulaMarkers(candidate)) return false;
  const aCore = variantCore(anchor);
  const bCore = variantCore(candidate);
  // An explicit shared variant parent is useful only with the same product core;
  // a parent/line identifier alone must never suppress routine complements.
  return Boolean(aCore && aCore === bCore && aCore.split(/\s+/).length >= 2 &&
    (hasExplicitVariant(anchor) || hasExplicitVariant(candidate)));
}
function sharedSpecificNameWords(anchor = {}, candidate = {}) {
  const stop = new Set(['the', 'and', 'for', 'with', ...brand(anchor).split(/\W+/), ...brand(candidate).split(/\W+/)]);
  const words = (snapshot) => new Set(normalizedTitle(snapshot).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !stop.has(word)));
  const a = words(anchor); const b = words(candidate);
  return [...a].filter((word) => b.has(word));
}

module.exports = { isSameFamilyVariant, variantCore, brand, title, sharedSpecificNameWords, optionRole, decorativeStructure };
