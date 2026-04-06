function createFindProductsSearchSemanticsRuntime(deps = {}) {
  const {
    isBeautyDiscoverySemanticContract,
    beautyDiscoveryMainlineOwner,
    buildFallbackCandidateText,
  } = deps;

  function isSemanticOwnerControlledSearch({
    operation = '',
    semanticContract = null,
    semanticRewriteResult = null,
    queryClass = null,
  } = {}) {
    if (String(operation || '').trim().toLowerCase() !== 'find_products_multi') return false;
    const contract =
      semanticContract && typeof semanticContract === 'object' && !Array.isArray(semanticContract)
        ? semanticContract
        : null;
    const rewrite =
      semanticRewriteResult && typeof semanticRewriteResult === 'object' && !Array.isArray(semanticRewriteResult)
        ? semanticRewriteResult
        : null;
    if (!contract || !rewrite) return false;
    if (!isBeautyDiscoverySemanticContract(contract)) return false;
    return rewrite.applied === true && String(rewrite.owner || '').trim() === beautyDiscoveryMainlineOwner;
  }

  function classifyBeautyMixBucket(product) {
    const text = buildFallbackCandidateText(product);
    if (!text) return 'other';
    if (
      /\b(foundation|concealer|primer|powder|cushion|bb cream|cc cream)\b/i.test(text) ||
      /(粉底|遮瑕|妆前|妝前|定妆|定妝|气垫|氣墊)/.test(text)
    ) {
      return 'base_makeup';
    }
    if (
      /\b(eyeshadow|eye shadow|eyeliner|mascara|brow|eyebrow)\b/i.test(text) ||
      /(眼影|眼线|眼線|睫毛膏|眉笔|眉筆|眉粉)/.test(text)
    ) {
      return 'eye_makeup';
    }
    if (
      /\b(lipstick|lip gloss|lip tint|lip balm|lip liner)\b/i.test(text) ||
      /(口红|口紅|唇釉|唇膏|唇蜜|唇线|唇線)/.test(text)
    ) {
      return 'lip_makeup';
    }
    if (
      /\b(brush|brush set|puff|sponge|applicator|curler|tweezer|tool|tools)\b/i.test(text) ||
      /(化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|睫毛夹|睫毛夾|工具)/.test(text)
    ) {
      return 'tools';
    }
    if (
      /\b(toner|serum|essence|lotion|moisturizer|sunscreen|cleanser|cream)\b/i.test(text) ||
      /(化妆水|化妝水|精华|精華|乳液|面霜|防晒|防曬|洁面|潔面|面膜)/.test(text)
    ) {
      return 'skincare';
    }
    return 'other';
  }

  function buildCategoryMixTopN(products, topN = 10) {
    const list = Array.isArray(products) ? products.slice(0, Math.max(1, Number(topN) || 10)) : [];
    const buckets = {};
    for (const product of list) {
      const bucket = classifyBeautyMixBucket(product);
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    }
    return buckets;
  }

  function buildSearchRelevanceDebug({ intent, products, diversityPenaltyApplied = false }) {
    const domain = String(intent?.primary_domain || '');
    if (!domain) return null;
    const out = {
      intent_domain: intent?.primary_domain || null,
      intent_scenario: intent?.scenario?.name || null,
      diversity_penalty_applied: Boolean(diversityPenaltyApplied),
    };
    if (domain === 'beauty') {
      out.category_mix_topN = buildCategoryMixTopN(products, 10);
    } else {
      out.category_mix_topN = null;
    }
    return out;
  }

  return {
    isSemanticOwnerControlledSearch,
    buildSearchRelevanceDebug,
  };
}

module.exports = {
  createFindProductsSearchSemanticsRuntime,
};
