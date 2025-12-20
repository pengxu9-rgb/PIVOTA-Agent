const { buildProductText } = require('./productTagger');

const TOOL_FIRST_ENABLED =
  process.env.FIND_PRODUCTS_MULTI_TOOL_FIRST_ENABLED !== 'false';

const TOOL_ROLES = {
  FOUNDATION_BRUSH: 'foundation_brush',
  SPONGE: 'sponge',
  POWDER_BRUSH: 'powder_brush',
  POWDER_PUFF: 'powder_puff',
  CONCEALER_BRUSH: 'concealer_brush',
  MULTI_FACE_BRUSH: 'multi_face_brush',
  BLUSH_BRUSH: 'blush_brush',
  CONTOUR_BRUSH: 'contour_brush',
  HIGHLIGHT_BRUSH: 'highlight_brush',
  EYE_BRUSH_SET: 'eye_brush_set',
  EYELASH_CURLER: 'eyelash_curler',
  CLEANER: 'cleaner',
  BRUSH_SET: 'brush_set',
};

function clamp01(n) {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeLower(s) {
  return String(s || '').toLowerCase();
}

function normalizeMatchText(s) {
  return safeLower(s)
    // Normalize common Unicode dashes to ASCII hyphen for regex matching.
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    // Normalize non-breaking spaces.
    .replace(/\u00a0/g, ' ');
}

function collectStringsDeep(value, out, depth = 0) {
  if (depth > 3) return;
  if (value == null) return;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t) out.push(t);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const v of value) collectStringsDeep(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      collectStringsDeep(value[k], out, depth + 1);
    }
  }
}

function extractAttributeBlob(product) {
  const parts = [];
  collectStringsDeep(product?.attributes, parts);
  collectStringsDeep(product?.options, parts);
  collectStringsDeep(product?.variants, parts);
  collectStringsDeep(product?.product_options, parts);
  collectStringsDeep(product?.productOptions, parts);
  return parts.join(' ');
}

function inferToolCategoryLv2(productText) {
  const t = normalizeMatchText(productText);

  // Sets first: can cover many roles.
  if (
    /\b(\d+)\s*(?:pcs|pc|pieces|piece)\b/.test(t) ||
    /\b(brush set|makeup brush set|set of brushes)\b/.test(t) ||
    /刷具套装|化妆刷套装|套装/.test(productText)
  ) {
    return 'brush_set';
  }

  if (/\bfoundation brush\b/.test(t) || /粉底刷/.test(productText)) return 'foundation_brush';
  if (/\bconcealer brush\b/.test(t) || /遮瑕刷/.test(productText)) return 'concealer_brush';
  if (/\b(powder brush|setting brush)\b/.test(t) || /散粉刷/.test(productText)) return 'powder_brush';
  if (/\b(blush brush)\b/.test(t) || /腮红刷/.test(productText)) return 'blush_brush';
  if (/\b(contour brush)\b/.test(t) || /修容刷|鼻影刷/.test(productText)) return 'contour_brush';
  if (/\b(highlight(?:er|ing)? brush|fan brush)\b/.test(t) || /高光刷|扇形刷/.test(productText)) return 'highlight_brush';
  if (/\b(eyeshadow brush|blending brush|shader brush|crease brush)\b/.test(t) || /眼影刷|晕染刷/.test(productText))
    return 'eye_brush';
  // "detail brush" is common for under-eye / concealer.
  if (/\b(under[-\\s]?eye|detail) brush\b/.test(t) || /眼下|细节刷/.test(productText)) return 'concealer_brush';
  if (/\b(eyelash curler)\b/.test(t) || /睫毛夹/.test(productText)) return 'eyelash_curler';
  if (/\b(makeup sponge|beauty blender|sponge)\b/.test(t) || /美妆蛋|海绵蛋|粉扑海绵/.test(productText)) return 'sponge';
  if (/\b(powder puff|cushion puff|puff)\b/.test(t) || /粉扑|气垫扑/.test(productText)) return 'powder_puff';
  if (/\b(brush cleaner|cleaning pad|brush soap)\b/.test(t) || /清洁垫|清洁剂|刷具清洁/.test(productText)) return 'cleaner';

  // Fallback: if it is clearly a brush/tool but not a known specific type,
  // treat as a multi-face brush so we can still assemble reasonable kits.
  if (/\b(makeup brush|brush)\b/.test(t) || /化妆刷|刷具|刷子/.test(productText)) return 'multi_face_brush';

  return null;
}

function inferMaterial(productText, attrBlob) {
  const all = `${productText || ''} ${attrBlob || ''}`;
  const t = safeLower(all);

  if (/\b(latex|rubber)\b/.test(t) || /乳胶/.test(all)) return 'latex';
  if (/\b(synthetic|nylon|fiber)\b/.test(t) || /纤维毛|人造毛|合成毛/.test(all)) return 'synthetic';
  if (/\b(natural hair|goat hair|animal hair)\b/.test(t) || /动物毛|山羊毛|马毛/.test(all)) return 'natural';

  return 'unknown';
}

function inferLatexFlag(productText, attrBlob) {
  const all = `${productText || ''} ${attrBlob || ''}`;
  const t = safeLower(all);
  return /\b(latex)\b/.test(t) || /乳胶/.test(all);
}

function inferSoftness(productText) {
  const t = safeLower(productText);
  if (/\b(ultra soft|very soft|super soft)\b/.test(t) || /很软|超软|柔软/.test(productText)) return 3;
  if (/\b(soft|silky)\b/.test(t) || /柔/.test(productText)) return 2;
  if (/\b(resilient)\b/.test(t)) return 2;
  return 1;
}

function inferDensity(productText) {
  const t = safeLower(productText);
  if (/\b(dense|high density)\b/.test(t) || /高密度/.test(productText)) return 3;
  if (/\b(medium density)\b/.test(t) || /适中/.test(productText)) return 2;
  return 1;
}

function inferUseCases(productText) {
  const t = safeLower(productText);
  const out = new Set();
  if (/\b(liquid|liquids)\b/.test(t) || /粉底液/.test(productText)) out.add('liquid');
  if (/\b(cream|creams)\b/.test(t) || /膏/.test(productText)) out.add('cream');
  if (/\b(powder|powders)\b/.test(t) || /散粉|粉/.test(productText)) out.add('powder');
  if (/\bfoundation\b/.test(t) || /粉底/.test(productText)) out.add('foundation');
  if (/\bconcealer\b/.test(t) || /遮瑕/.test(productText)) out.add('concealer');
  if (/\bblush\b/.test(t) || /腮红/.test(productText)) out.add('blush');
  if (/\bcontour\b/.test(t) || /修容/.test(productText)) out.add('contour');
  if (/\beyeshadow\b/.test(t) || /眼影/.test(productText)) out.add('eyeshadow');
  return Array.from(out);
}

function isRoleCompatible(tool, role) {
  const lv2 = tool?.tool_category_lv2;
  if (!lv2 || !role) return false;

  // For non-brush accessories, require strict matching (avoid a brush being selected as a sponge).
  if (role === TOOL_ROLES.SPONGE) return lv2 === 'sponge';
  if (role === TOOL_ROLES.POWDER_PUFF) return lv2 === 'powder_puff';
  if (role === TOOL_ROLES.CLEANER) return lv2 === 'cleaner';
  if (role === TOOL_ROLES.EYELASH_CURLER) return lv2 === 'eyelash_curler';

  // Eye brushes can be a specific eye brush or a brush set.
  if (role === TOOL_ROLES.EYE_BRUSH_SET) return lv2 === 'eye_brush' || lv2 === 'brush_set';

  // Brush set is strict.
  if (role === TOOL_ROLES.BRUSH_SET) return lv2 === 'brush_set';

  // For brush roles, allow exact, brush sets, or a generic multi-face brush as a compatible fallback.
  const brushRoles = new Set([
    TOOL_ROLES.FOUNDATION_BRUSH,
    TOOL_ROLES.POWDER_BRUSH,
    TOOL_ROLES.BLUSH_BRUSH,
    TOOL_ROLES.CONTOUR_BRUSH,
    TOOL_ROLES.HIGHLIGHT_BRUSH,
    TOOL_ROLES.CONCEALER_BRUSH,
    TOOL_ROLES.MULTI_FACE_BRUSH,
  ]);
  if (brushRoles.has(role)) {
    if (lv2 === 'brush_set') return true;
    if (lv2 === role) return true;
    if (lv2 === 'multi_face_brush') return true;
    // Some products are eye brushes but could serve as concealer/detail brush; keep strict here.
    return false;
  }

  return lv2 === role;
}

function mapRawProductToToolProduct(raw) {
  const productText = buildProductText(raw) || `${raw?.title || ''} ${raw?.description || ''}`;
  const attrBlob = extractAttributeBlob(raw);
  const lv2 = inferToolCategoryLv2(`${productText} ${attrBlob}`);
  if (!lv2) return null;

  const price = Number(raw?.price ?? raw?.price_amount ?? raw?.priceAmount ?? null);
  const currency = raw?.currency || null;
  const inventory = Number(raw?.inventory_quantity ?? raw?.inventoryQuantity ?? raw?.quantity ?? null);

  return {
    raw,
    id: String(raw?.id || raw?.product_id || raw?.productId || ''),
    title: String(raw?.title || raw?.name || ''),
    tool_category_lv1: 'beauty_tools',
    tool_category_lv2: lv2,
    material: inferMaterial(productText, attrBlob),
    latex_flag: inferLatexFlag(productText, attrBlob),
    softness: inferSoftness(productText),
    density: inferDensity(productText),
    use_cases: inferUseCases(productText),
    price: Number.isFinite(price) ? price : null,
    currency,
    inventory_quantity: Number.isFinite(inventory) ? inventory : null,
  };
}

function inferUserProfile(rawQuery, intent) {
  const q = String(rawQuery || '');
  const lower = safeLower(q);

  const goal =
    /持妆|控油|longwear|oil control|stay\b/.test(q)
      ? 'longwear_oil_control'
      : /遮瑕|full coverage|high coverage|cover\b/.test(q)
        ? 'full_coverage'
        : /服帖|不卡粉|起皮|cakey|flaky/.test(q)
          ? 'smooth_base'
          : /新手|beginner|手残/.test(q)
            ? 'beginner_safe'
            : /眼影|晕染|eyeshadow|blend/.test(q)
              ? 'eye_makeup_clean'
              : 'general';

  const baseProductType =
    /粉底液|liquid foundation/.test(q)
      ? 'liquid_foundation'
      : /粉霜|cream foundation/.test(q)
        ? 'cream_foundation'
        : /气垫|cushion/.test(q)
          ? 'cushion'
          : /粉饼|powder foundation/.test(q)
            ? 'powder_foundation'
            : 'unknown';

  const skinType =
    /油皮|oily/.test(q)
      ? 'oily'
      : /干皮|dry/.test(q)
        ? 'dry'
        : /混合|combo/.test(q)
          ? 'combo'
          : /敏感|sensitive/.test(q)
            ? 'sensitive'
            : 'unknown';

  const skillLevel = /新手|beginner|手残/.test(q) ? 'beginner' : 'unknown';

  const latexFree = /无乳胶|latex[-\\s]?free/.test(lower);
  const price = intent?.hard_constraints?.price || null;

  return {
    goal,
    base_product_type: baseProductType,
    skin_type: skinType,
    skill_level: skillLevel,
    preferences: { latex_free: latexFree },
    budget: price && (price.max != null || price.min != null) ? price : null,
  };
}

function toolCoversRoles(tool) {
  const lv2 = tool?.tool_category_lv2;
  if (!lv2) return [];
  if (lv2 === 'brush_set') {
    return [
      TOOL_ROLES.BRUSH_SET,
      TOOL_ROLES.FOUNDATION_BRUSH,
      TOOL_ROLES.POWDER_BRUSH,
      TOOL_ROLES.BLUSH_BRUSH,
      TOOL_ROLES.CONTOUR_BRUSH,
      TOOL_ROLES.HIGHLIGHT_BRUSH,
      TOOL_ROLES.CONCEALER_BRUSH,
      TOOL_ROLES.EYE_BRUSH_SET,
      TOOL_ROLES.MULTI_FACE_BRUSH,
    ];
  }
  if (lv2 === 'eye_brush') return [TOOL_ROLES.EYE_BRUSH_SET];
  if (lv2 === 'sponge') return [TOOL_ROLES.SPONGE];
  if (lv2 === 'powder_puff') return [TOOL_ROLES.POWDER_PUFF];
  if (lv2 === 'cleaner') return [TOOL_ROLES.CLEANER];
  if (lv2 === 'multi_face_brush') {
    // Compatible coverage for common face roles (weakly).
    return [
      TOOL_ROLES.MULTI_FACE_BRUSH,
      TOOL_ROLES.FOUNDATION_BRUSH,
      TOOL_ROLES.POWDER_BRUSH,
      TOOL_ROLES.BLUSH_BRUSH,
      TOOL_ROLES.CONTOUR_BRUSH,
      TOOL_ROLES.HIGHLIGHT_BRUSH,
    ];
  }

  // direct mapping for our lv2 strings
  return [lv2];
}

function isInStock(tool) {
  const qty = tool?.inventory_quantity;
  if (qty == null) return true;
  return Number.isFinite(qty) ? qty > 0 : true;
}

function withinBudget(tool, budget) {
  if (!budget) return true;
  const price = tool?.price;
  if (!Number.isFinite(price)) return true;
  const max = budget?.max;
  const min = budget?.min;
  if (max != null && Number.isFinite(max) && price > max) return false;
  if (min != null && Number.isFinite(min) && price < min) return false;
  return true;
}

function scoreToolForRole(tool, role, user) {
  const lv2 = tool?.tool_category_lv2;
  if (!isRoleCompatible(tool, role)) return 0;
  const covers = new Set(toolCoversRoles(tool));
  const exact =
    lv2 === role ||
    (lv2 === 'eye_brush' && role === TOOL_ROLES.EYE_BRUSH_SET) ||
    (lv2 === 'brush_set' && role === TOOL_ROLES.BRUSH_SET) ||
    (lv2 === 'sponge' && role === TOOL_ROLES.SPONGE) ||
    (lv2 === 'powder_puff' && role === TOOL_ROLES.POWDER_PUFF) ||
    (lv2 === 'cleaner' && role === TOOL_ROLES.CLEANER);
  const viaSet = covers.has(TOOL_ROLES.BRUSH_SET) && role !== TOOL_ROLES.BRUSH_SET;
  const compatible = !exact && !viaSet && covers.has(role);

  let score = 0;
  if (exact) score += 0.8;
  else if (viaSet) score += 0.65;
  else if (compatible) score += 0.45;
  else score += 0.05;

  // Beginner-friendly nudges:
  if (user?.skill_level === 'beginner') {
    if (role === TOOL_ROLES.SPONGE) score += 0.1;
    if (role === TOOL_ROLES.FOUNDATION_BRUSH && tool?.density >= 3) score -= 0.05;
  }

  // Latex-free preference.
  if (user?.preferences?.latex_free && tool?.latex_flag) score = 0;

  // Softness preference for sensitive/dry.
  if (user?.skin_type === 'sensitive' || user?.skin_type === 'dry') {
    score += clamp01((tool?.softness || 1) / 3) * 0.08;
  }

  return clamp01(score);
}

function pickBestForRole(tools, role, user, usedIds) {
  let best = null;
  let bestScore = -1;
  for (const t of tools) {
    if (!t || !t.id) continue;
    if (usedIds.has(t.id)) continue;
    const s = scoreToolForRole(t, role, user);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return bestScore > 0.1 ? { tool: best, score: bestScore } : null;
}

function assembleKit({ name, roles }, tools, user) {
  const used = new Set();
  const filledRoles = new Set();
  const items = [];

  // Prefer a brush set for kits that need multiple brush roles.
  if (roles.includes(TOOL_ROLES.EYE_BRUSH_SET) || roles.includes(TOOL_ROLES.MULTI_FACE_BRUSH)) {
    const brushSet = tools.find((t) => toolCoversRoles(t).includes(TOOL_ROLES.BRUSH_SET));
    if (brushSet && !used.has(brushSet.id)) {
      used.add(brushSet.id);
      items.push({
        role: TOOL_ROLES.BRUSH_SET,
        product_id: brushSet.id,
        title: brushSet.title,
      });
      for (const r of roles) {
        if (toolCoversRoles(brushSet).includes(r)) filledRoles.add(r);
      }
    }
  }

  for (const role of roles) {
    if (filledRoles.has(role)) continue;
    const picked = pickBestForRole(tools, role, user, used);
    if (!picked) continue;
    used.add(picked.tool.id);
    filledRoles.add(role);
    items.push({
      role,
      product_id: picked.tool.id,
      title: picked.tool.title,
    });
  }

  const missing = roles.filter((r) => !filledRoles.has(r));
  const completeness = roles.length > 0 ? 1 - missing.length / roles.length : 0;

  return {
    kit_name: name,
    items,
    filled_roles: roles.filter((r) => filledRoles.has(r)),
    missing_roles: missing,
    completeness: clamp01(completeness),
  };
}

function buildHowToUse(user) {
  const lines = [];
  lines.push('底妆：少量多次；刷/海绵上完后，用轻拍方式把边缘收干净更服帖。');
  if (user?.skin_type === 'combo' || user?.skin_type === 'oily') {
    lines.push('定妆：T 区更建议粉扑按压增强持妆，两颊用散粉刷轻扫。');
  } else if (user?.skin_type === 'dry') {
    lines.push('定妆：更建议散粉刷轻扫，粉扑按压要控制用量，避免卡粉。');
  } else {
    lines.push('定妆：粉扑按压更持妆；散粉刷更轻薄，按你偏好选择。');
  }
  lines.push('清洁：海绵/粉扑更易藏污纳垢，清洗后务必完全晾干再收纳。');
  return lines;
}

function buildWhyThisWorks(user) {
  const lines = [];
  if (user?.skill_level === 'beginner') {
    lines.push('优先选择容错更高的工具组合，减少“刷痕/结块/边界脏”。');
  }
  if (user?.goal === 'longwear_oil_control') {
    lines.push('粉扑按压 + 分区定妆能明显提升持妆，尤其是 T 区。');
  }
  if (user?.goal === 'smooth_base') {
    lines.push('少量多次 + 轻拍收边更容易做出服帖、细腻的底妆。');
  }
  lines.push('加入清洁工具能降低闷痘/异味风险，减少投诉。');
  return lines;
}

function buildFollowUps(user) {
  const qs = [];
  if (user?.goal === 'general') qs.push('你主要想解决什么：底妆服帖 / 持妆控油 / 遮瑕 / 新手不翻车 / 眼妆更干净？');
  if (user?.base_product_type === 'unknown') qs.push('你常用底妆是：粉底液/粉霜/气垫/粉饼？（不知道也没关系）');
  if (user?.skin_type === 'unknown') qs.push('你的肤质更接近：油皮 / 干皮 / 混合皮 / 敏感肌？');
  if (!user?.budget || (user?.budget?.max == null && user?.budget?.min == null)) qs.push('预算大概在什么区间？我可以按预算给你分 A/B/C 三档。');
  return qs.slice(0, 3);
}

function computeToolRequestStats(kits) {
  const best = Array.isArray(kits) ? kits.reduce((a, b) => (a.completeness >= b.completeness ? a : b), kits[0]) : null;
  const completeness = best ? best.completeness : 0;
  const hasGood = completeness >= 0.7 && (best?.items?.length || 0) >= 3;
  const tier = hasGood
    ? completeness >= 0.9
      ? 'strong'
      : 'medium'
    : completeness >= 0.35
      ? 'weak'
      : 'none';
  const matchConfidence = clamp01(completeness);
  return { has_good_match: hasGood, match_tier: tier, match_confidence: matchConfidence };
}

function recommendToolKits({ rawQuery, intent, products }) {
  if (!TOOL_FIRST_ENABLED) return null;
  const scenario = String(intent?.scenario?.name || '');
  const domain = String(intent?.primary_domain || '');
  if (domain !== 'beauty' || scenario !== 'beauty_tools') return null;

  const user = inferUserProfile(rawQuery, intent);
  const mapped = (Array.isArray(products) ? products : [])
    .map(mapRawProductToToolProduct)
    .filter(Boolean);

  // Hard filters.
  const filtered = mapped
    .filter(isInStock)
    .filter((t) => withinBudget(t, user.budget))
    .filter((t) => !(user?.preferences?.latex_free && t.latex_flag));

  // Templates (A/B/C).
  const templates = [
    {
      name: 'A 新手极简：底妆更干净',
      roles: [TOOL_ROLES.SPONGE, TOOL_ROLES.POWDER_BRUSH, TOOL_ROLES.MULTI_FACE_BRUSH, TOOL_ROLES.CLEANER],
    },
    {
      name: 'B 通勤完整：全脸覆盖更省心',
      roles: [
        TOOL_ROLES.FOUNDATION_BRUSH,
        TOOL_ROLES.SPONGE,
        TOOL_ROLES.CONCEALER_BRUSH,
        TOOL_ROLES.POWDER_PUFF,
        TOOL_ROLES.POWDER_BRUSH,
        TOOL_ROLES.MULTI_FACE_BRUSH,
        TOOL_ROLES.EYE_BRUSH_SET,
        TOOL_ROLES.EYELASH_CURLER,
        TOOL_ROLES.CLEANER,
      ],
    },
    {
      name: 'C 进阶妆效：更细节更专业',
      roles: [
        TOOL_ROLES.FOUNDATION_BRUSH,
        TOOL_ROLES.SPONGE,
        TOOL_ROLES.CONCEALER_BRUSH,
        TOOL_ROLES.POWDER_PUFF,
        TOOL_ROLES.POWDER_BRUSH,
        TOOL_ROLES.BLUSH_BRUSH,
        TOOL_ROLES.CONTOUR_BRUSH,
        TOOL_ROLES.HIGHLIGHT_BRUSH,
        TOOL_ROLES.EYE_BRUSH_SET,
        TOOL_ROLES.EYELASH_CURLER,
        TOOL_ROLES.CLEANER,
      ],
    },
  ];

  let kits = templates.map((tpl) => assembleKit(tpl, filtered, user));

  // If a kit is empty or too sparse, pad it with the best available tool-like items
  // so the UI can still show something useful while we ask clarifying questions.
  const buildUniqueTools = () => {
    const priority = [
      'brush_set',
      'foundation_brush',
      'powder_brush',
      'sponge',
      'powder_puff',
      'concealer_brush',
      'blush_brush',
      'contour_brush',
      'highlight_brush',
      'eye_brush',
      'eyelash_curler',
      'cleaner',
      'multi_face_brush',
    ];
    const byPri = new Map(priority.map((k, i) => [k, i]));
    const sorted = [...filtered].sort((a, b) => {
      const ai = byPri.has(a.tool_category_lv2) ? byPri.get(a.tool_category_lv2) : 999;
      const bi = byPri.has(b.tool_category_lv2) ? byPri.get(b.tool_category_lv2) : 999;
      return ai - bi;
    });
    const unique = [];
    const seen = new Set();
    for (const t of sorted) {
      if (!t?.id) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
      if (unique.length >= 16) break;
    }
    return unique;
  };

  const uniqueTools = buildUniqueTools();
  const padCounts = [3, 4, 5];
  kits = kits.map((k, idx) => {
    const desired = padCounts[idx] || 4;
    const items = Array.isArray(k?.items) ? [...k.items] : [];
    const usedIds = new Set(items.map((it) => String(it.product_id || '')).filter(Boolean));
    const usedRoles = new Set(items.map((it) => String(it.role || '')).filter(Boolean));
    const usedTitleNorm = new Set(
      items
        .map((it) => normalizeMatchText(it?.title || ''))
        .filter(Boolean),
    );
    for (const t of uniqueTools) {
      if (items.length >= desired) break;
      if (!t?.id) continue;
      if (usedIds.has(t.id)) continue;
      const role =
        t.tool_category_lv2 === 'eye_brush' ? TOOL_ROLES.EYE_BRUSH_SET : t.tool_category_lv2;
      if (!role) continue;
      // Prefer diversity: at most 1 item per role unless we have no other choice.
      if (usedRoles.has(role)) continue;
      const titleNorm = normalizeMatchText(t.title || '');
      if (titleNorm && usedTitleNorm.has(titleNorm)) continue;

      usedIds.add(t.id);
      usedRoles.add(role);
      if (titleNorm) usedTitleNorm.add(titleNorm);

      items.push({
        role,
        product_id: t.id,
        title: t.title,
      });
    }
    return { ...k, items };
  });

  // If none of the templates can be filled (catalog may have only a subset of tools),
  // fall back to showing the best available tool-like items while asking clarifiers.
  const anyKitHasItems = kits.some((k) => Array.isArray(k?.items) && k.items.length > 0);
  let usedFallback = false;
  if (!anyKitHasItems && filtered.length > 0) {
    usedFallback = true;
    const unique = uniqueTools.slice(0, 12);

    const counts = [4, 6, 8];
    kits = kits.map((k, idx) => {
      const take = counts[idx] || 6;
      return {
        ...k,
        items: unique.slice(0, take).map((t) => ({
          role: t.tool_category_lv2 === 'eye_brush' ? TOOL_ROLES.EYE_BRUSH_SET : t.tool_category_lv2,
          product_id: t.id,
          title: t.title,
        })),
      };
    });
  }

  let stats = computeToolRequestStats(kits);
  if (usedFallback) {
    stats = { has_good_match: false, match_tier: 'weak', match_confidence: 0.4 };
  }
  const followUps = buildFollowUps(user);

  const orderedIds = [];
  const seen = new Set();
  for (const k of kits) {
    for (const it of k.items || []) {
      const pid = String(it.product_id || '');
      if (!pid) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      orderedIds.push(pid);
    }
  }

  const toolKits = kits.map((k) => ({
    kit_name: k.kit_name,
    items: k.items,
    how_to_use: buildHowToUse(user),
    why_this_works: buildWhyThisWorks(user),
    cautions: user?.preferences?.latex_free ? ['已按“无乳胶/latex-free”偏好优先筛选；如果你不确定是否过敏，可以先从无乳胶开始。'] : [],
    alternatives: [],
    completeness: k.completeness,
    missing_roles: k.missing_roles,
  }));

  return {
    user_summary: user,
    tool_kits: toolKits,
    ordered_product_ids: orderedIds,
    follow_up_questions: followUps,
    stats,
  };
}

module.exports = {
  recommendToolKits,
  // exported for unit tests
  _debug: {
    mapRawProductToToolProduct,
    inferToolCategoryLv2,
    inferUserProfile,
    assembleKit,
  },
};
