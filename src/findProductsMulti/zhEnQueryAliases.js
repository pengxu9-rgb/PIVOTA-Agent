/**
 * Curated ZH→EN aliases for the find_products_multi entry.
 *
 * The catalog and Aurora index are English-tokenized. Bare-noun ZH queries
 * like "口红" / "卫衣" / "蓝牙耳机" return zero candidates because no
 * indexed product has those tokens. Probe v1 (May 2026) confirmed
 * 12/13 ZH queries → EMPTY (only "防晒霜" passed, because that exact string
 * exists in catalog backfill).
 *
 * Strategy: when the query contains any ZH key in this dict, append the EN
 * alias as additional tokens (the original query is preserved so brand /
 * descriptor terms still match if the user mixed scripts). Curation is
 * conservative — only category nouns with clear 1:1 EN mappings.
 *
 * Add new entries here as they show up in probe failures.
 */

const ZH_EN_ALIASES = Object.freeze({
  // Lip
  口红: 'lipstick',
  唇釉: 'lip gloss',
  唇彩: 'lip gloss',
  唇膏: 'lip balm',
  // Face base
  粉底: 'foundation',
  粉底液: 'foundation',
  气垫: 'cushion foundation',
  气垫粉底: 'cushion foundation',
  遮瑕: 'concealer',
  遮瑕膏: 'concealer',
  散粉: 'setting powder',
  定妆喷雾: 'setting spray',
  腮红: 'blush',
  修容: 'contour',
  高光: 'highlighter',
  // Eye
  眼影: 'eyeshadow',
  眼影盘: 'eyeshadow palette',
  眼线笔: 'eyeliner',
  眼线液: 'liquid eyeliner',
  眉笔: 'eyebrow pencil',
  眉粉: 'eyebrow powder',
  睫毛膏: 'mascara',
  // Skincare
  精华: 'serum',
  精华液: 'serum',
  面霜: 'face cream moisturizer',
  乳液: 'lotion moisturizer',
  爽肤水: 'toner',
  化妆水: 'toner',
  洗面奶: 'cleanser face wash',
  洁面: 'cleanser face wash',
  防晒霜: 'sunscreen',
  防晒: 'sunscreen',
  眼霜: 'eye cream',
  面膜: 'face mask sheet mask',
  // Fragrance
  香水: 'perfume fragrance',
  淡香水: 'eau de toilette perfume',
  浓香水: 'eau de parfum',
  木质香水: 'woody perfume fragrance',
  花香香水: 'floral perfume',
  柑橘香水: 'citrus perfume',
  // Fashion top
  卫衣: 'hoodie sweatshirt',
  连帽衫: 'hoodie',
  T恤: 'tshirt',
  衬衫: 'shirt',
  毛衣: 'sweater',
  外套: 'jacket',
  // Fashion bottom + dress
  连衣裙: 'dress',
  亚麻连衣裙: 'linen dress',
  半身裙: 'skirt',
  牛仔裤: 'jeans',
  // Shoes
  跑鞋: 'running shoes',
  运动鞋: 'sneakers',
  靴子: 'boots',
  皮鞋: 'leather shoes',
  // Accessories
  手提包: 'handbag',
  双肩包: 'backpack',
  手表: 'watch',
  // Electronics
  蓝牙耳机: 'bluetooth earbuds wireless headphones',
  耳机: 'headphones earbuds',
  电子阅读器: 'e-reader ereader kindle',
  键盘: 'keyboard',
  鼠标: 'mouse',
  显示器: 'monitor',
  音响: 'speaker bluetooth speaker',
  // Home
  加湿器: 'humidifier',
  保温杯: 'insulated water bottle thermos',
  水杯: 'water bottle',
  扫地机器人: 'robot vacuum',
  空气净化器: 'air purifier',
  香薰: 'aroma diffuser',
});

const ZH_KEYS_BY_LENGTH = Object.keys(ZH_EN_ALIASES).sort((a, b) => b.length - a.length);

const HAS_CJK_REGEX = /[㐀-鿿]/;

function hasCjkChars(text) {
  return HAS_CJK_REGEX.test(String(text || ''));
}

/**
 * Returns { query, aliases_applied, alias_terms } where:
 *   - query: the original query, with EN aliases appended as additional tokens.
 *            Empty input or no ZH match returns { query: <input>, aliases_applied: false }.
 *   - aliases_applied: true if any alias was matched.
 *   - alias_terms: array of {zh, en} pairs that were applied (for telemetry).
 *
 * Original query string is preserved so brand / descriptor / numeric terms
 * still match. Aliases are appended once each (deduped) regardless of how
 * many times the ZH term appears.
 */
function expandQueryWithZhAlias(rawQuery) {
  const text = String(rawQuery || '').trim();
  if (!text) return { query: '', aliases_applied: false, alias_terms: [] };
  if (!hasCjkChars(text)) return { query: text, aliases_applied: false, alias_terms: [] };

  // Walk longest-key first and "consume" matched character positions so a
  // shorter ZH term that overlaps a longer match doesn't fire twice
  // (e.g. 气垫 inside 气垫粉底 must not double-match).
  const consumed = new Array(text.length).fill(false);
  const matches = [];

  for (const zh of ZH_KEYS_BY_LENGTH) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(zh, from);
      if (idx < 0) break;
      let overlaps = false;
      for (let i = idx; i < idx + zh.length; i += 1) {
        if (consumed[i]) { overlaps = true; break; }
      }
      if (!overlaps) {
        for (let i = idx; i < idx + zh.length; i += 1) consumed[i] = true;
        const en = ZH_EN_ALIASES[zh];
        if (en && !matches.some((m) => m.en === en)) {
          matches.push({ zh, en });
        }
      }
      from = idx + zh.length;
    }
  }

  if (matches.length === 0) return { query: text, aliases_applied: false, alias_terms: [] };

  const enTokens = matches.map((m) => m.en).join(' ');
  return {
    query: `${text} ${enTokens}`,
    aliases_applied: true,
    alias_terms: matches,
  };
}

module.exports = {
  ZH_EN_ALIASES,
  expandQueryWithZhAlias,
};
