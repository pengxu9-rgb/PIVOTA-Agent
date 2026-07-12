'use strict';

// shop.find_products — grounded product/brand lookup for /v1/chat.
//
// Unlike reco.step_based (a routine recommender that LLM-generates candidates and
// can substitute a different brand), this skill calls the catalog lane directly
// (find_products_multi) and returns ONLY what the catalog actually has. On an empty
// result it returns an honest no-result message — it never substitutes another
// brand. That grounding is the whole reason this is a separate skill.

const BaseSkill = require('./BaseSkill');
const shopGatewayClient = require('../clients/shopGatewayClient');

function firstTrimmed(...vals) {
  for (const v of vals) {
    const s = v == null ? '' : String(v).trim();
    if (s) return s;
  }
  return '';
}

function firstImage(product) {
  const direct = firstTrimmed(product.image_url, product.imageUrl, product.image);
  if (direct) return direct;
  const imgs = Array.isArray(product.images) ? product.images : Array.isArray(product.image_refs) ? product.image_refs : [];
  for (const im of imgs) {
    const u = typeof im === 'string' ? im : firstTrimmed(im && (im.url || im.src || im.image_url));
    if (u) return u;
  }
  return null;
}

// Map a find_products_multi product to the `recommendations` card row shape
// (mirrors usecases/recoHybridResolveCandidates row output so the existing
// renderer works with no change).
function toRecommendationRow(product) {
  if (!product || typeof product !== 'object') return null;
  const brand = firstTrimmed(product.brand, product.brand_name, product.vendor) || null;
  const name = firstTrimmed(product.title, product.name, product.product_name, product.display_name);
  const productId = firstTrimmed(product.product_id, product.productId, product.id);
  const merchantId = firstTrimmed(product.merchant_id, product.merchantId);
  if (!name && !productId) return null;
  return {
    product_id: productId || '',
    merchant_id: merchantId || '',
    brand,
    name: name || '',
    display_name: name || '',
    category: firstTrimmed(product.category) || null,
    product_type: firstTrimmed(product.product_type, product.productType) || null,
    category_path: Array.isArray(product.category_path) ? product.category_path : null,
    image_url: firstImage(product),
    pdp_url: firstTrimmed(product.pdp_url, product.url, product.redirect_url, product.buy_url) || null,
    source: 'catalog_search',
    retrieval_source: 'find_products_multi',
  };
}

const NO_RESULT = {
  en: (q) => `I couldn't find "${q}" in the catalog right now. Try the exact brand or product name, or tell me a category and I can look again.`,
  zh: (q) => `目前在商品库里没有找到“${q}”。可以试试确切的品牌或产品名，或告诉我一个品类，我再帮你找。`,
};

class ShopFindProductsSkill extends BaseSkill {
  constructor(deps = {}) {
    super('shop.find_products', '1.0.0');
    // Injectable for tests; defaults to the real client.
    this._client = deps.client || shopGatewayClient;
  }

  _resolveQuery(request) {
    const p = request && request.params ? request.params : {};
    return firstTrimmed(
      p.find_products_query,
      p.query,
      p.user_message,
      p.message,
      p.text,
    );
  }

  async execute(request /* , llmGateway */) {
    const query = this._resolveQuery(request);
    const lang = firstTrimmed(request && request.context && request.context.locale).toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en';

    const nextActions = [
      { action_type: 'show_chip', label: { en: 'Refine my search', zh: '优化搜索' } },
    ];

    if (!query) {
      return {
        cards: [{
          card_type: 'text_response',
          sections: [{
            type: 'text_answer',
            text_en: 'What product or brand are you looking for?',
            text_zh: '你想找哪个产品或品牌？',
          }],
        }],
        ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
        next_actions: nextActions,
        _taskMode: 'shop',
      };
    }

    const result = await this._client.findProductsMulti({ query, limit: 8, inStockOnly: false });
    const rows = (Array.isArray(result && result.products) ? result.products : [])
      .map(toRecommendationRow)
      .filter(Boolean);

    if (rows.length > 0) {
      return {
        cards: [{
          card_type: 'recommendations',
          metadata: {
            recommendations: rows,
            recommendation_meta: {
              source_mode: 'catalog_search',
              query,
              result_count: rows.length,
              grounding_status: 'catalog_only',
            },
            source_mode: 'catalog_search',
            query_count: 1,
          },
        }],
        ops: {
          thread_ops: [],
          profile_patch: {},
          routine_patch: {},
          experiment_events: [{ event: 'find_products_shown', result_count: rows.length, grounding_status: 'catalog_only' }],
        },
        next_actions: [
          { action_type: 'navigate_skill', target_skill_id: 'product.analyze', label: { en: 'Check if one fits me', zh: '看看哪款适合我' } },
          { action_type: 'show_chip', label: { en: 'Refine my search', zh: '优化搜索' } },
        ],
        _taskMode: 'shop',
        _meta: { source_mode: 'catalog_search', result_count: rows.length, backend_reason: (result && result.reason) || null },
      };
    }

    // Honest no-result — NEVER substitute a different brand.
    return {
      cards: [{
        card_type: 'text_response',
        sections: [{
          type: 'text_answer',
          text_en: NO_RESULT.en(query),
          text_zh: NO_RESULT.zh(query),
        }],
      }],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [{ event: 'find_products_empty', grounding_status: 'catalog_only', backend_reason: (result && result.reason) || null }],
      },
      next_actions: nextActions,
      _taskMode: 'shop',
      _meta: { source_mode: 'catalog_search', result_count: 0, backend_reason: (result && result.reason) || null },
    };
  }
}

module.exports = ShopFindProductsSkill;
module.exports.toRecommendationRow = toRecommendationRow;
