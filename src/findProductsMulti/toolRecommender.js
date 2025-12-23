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

function wantsTieredKits(rawQuery) {
  const q = String(rawQuery || '');
  const lower = safeLower(q);
  return (
    /A\s*新手|B\s*通勤|C\s*进阶|A→B→C|三档|分\s*[A-C]|分档|分成/.test(q) ||
    /一套|套装|全套|全脸|入门.*套|通勤完整|进阶妆效/.test(q) ||
    /\b(a\/b\/c|tiers?|kit|kits|set|full\s*face|starter)\b/.test(lower)
  );
}

function wantsCelebritySame(rawQuery) {
  const q = String(rawQuery || '');
  return /明星同款|同款|仿妆|同じメイク|メイク.*同じ|celebrity|same.*look/i.test(q);
}

function parseFocusedRoles(rawQuery) {
  const q = String(rawQuery || '');
  const lower = safeLower(q);
  const only = /只需要|只要|仅需要|只想要/.test(q);

  const wantsConcealer = /遮瑕|concealer/.test(q) || /\bconceal(er|ing)\b/.test(lower);
  const wantsPowderFoundation = /粉饼|powder foundation/.test(q) || /\bpowder\s+foundation\b/.test(lower);
  const wantsLoosePowder = /散粉|setting powder|loose powder/.test(q) || /\b(loose|setting)\s+powder\b/.test(lower);
  const wantsCushion = /气垫|cushion/.test(q) || /\bcushion\b/.test(lower);
  const wantsQuick = /快捷|更快|省时|quick|fast/.test(q) || /\b(quick|fast|speed)\b/.test(lower);
  const wantsSeamless = /服帖|贴服|不卡粉|smooth|seamless|streak[-\s]?free/.test(q) || /\b(smooth|seamless|streak)\b/.test(lower);

  const roles = [];

  if (wantsConcealer) roles.push(TOOL_ROLES.CONCEALER_BRUSH);
  if (wantsPowderFoundation || wantsLoosePowder || wantsCushion) roles.push(TOOL_ROLES.POWDER_PUFF);
  if (!only && (wantsQuick || wantsSeamless)) roles.push(TOOL_ROLES.SPONGE);
  if (!only && (wantsLoosePowder || /定妆|set\b/.test(lower))) roles.push(TOOL_ROLES.POWDER_BRUSH);

  // If user explicitly said "only", keep the list strictly to what they asked for.
  if (only) {
    const dedup = Array.from(new Set(roles));
    return dedup.length ? dedup : [];
  }

  // Default minimal base combo when user asks for "faster / more seamless" without specifics.
  if (!roles.length && (wantsQuick || wantsSeamless)) {
    roles.push(TOOL_ROLES.SPONGE, TOOL_ROLES.POWDER_PUFF, TOOL_ROLES.CONCEALER_BRUSH);
  }

  return Array.from(new Set(roles));
}

function buildCelebrityClarifiers(lang) {
  const t = (dict) => dict[lang] || dict.en;
  return [
    t({
      zh: '你说的“明星同款”是指哪位明星/哪张参考图（或妆容关键词）？',
      ja: '「同じメイク」は誰のどの参考（画像/キーワード）？',
      fr: 'De quelle célébrité / quelle référence (photo ou mots-clés) parles-tu ?',
      es: '¿De qué celebridad / qué referencia (foto o palabras clave) hablas?',
      en: 'Which celebrity and which reference (photo/keywords) are you following?',
    }),
    t({
      zh: '你想复刻的是：全脸刷具，还是只要眼妆/底妆/遮瑕/定妆其中一部分？',
      ja: '全顔のブラシ？それとも目元/ベース/遮瑕/セットの一部だけ？',
      fr: 'Tu veux un set visage complet, ou seulement yeux/teint/anti-cernes/fixation ?',
      es: '¿Set completo o solo ojos/base/corrector/sellado?',
      en: 'Do you want a full-face set, or only eyes/base/concealer/setting?',
    }),
  ];
}

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
  const lang = String(user?.language || 'en');
  const t = (dict) => dict[lang] || dict.en;

  const lines = [];
  lines.push(
    t({
      zh: '底妆：少量多次；刷/海绵上完后，用轻拍方式把边缘收干净更服帖。',
      ja: 'ベース：少量ずつ。ブラシ/スポンジの後は軽く叩いて境目をなじませると密着。',
      fr: 'Teint : applique en petites quantités; tapote légèrement les bords pour fondre et fixer.',
      es: 'Base: aplica en capas finas; da golpecitos suaves en los bordes para difuminar y fijar.',
      en: 'Base: use thin layers; tap the edges to blend for a smoother finish.',
    }),
  );

  if (user?.skin_type === 'combo' || user?.skin_type === 'oily') {
    lines.push(
      t({
        zh: '定妆：T 区更建议粉扑按压增强持妆，两颊用散粉刷轻扫。',
        ja: 'セット：Tゾーンはパフで押さえると崩れにくい。頬はパウダーブラシでふんわり。',
        fr: "Fixation : presse la poudre au houppette sur la zone T, et balaie léger sur les joues.",
        es: 'Sellado: en la zona T presiona con borla; en mejillas, pasa la brocha suavemente.',
        en: 'Set: press with a puff on the T-zone; lightly sweep with a powder brush on cheeks.',
      }),
    );
  } else if (user?.skin_type === 'dry') {
    lines.push(
      t({
        zh: '定妆：更建议散粉刷轻扫，粉扑按压要控制用量，避免卡粉。',
        ja: 'セット：乾燥肌はブラシで軽く。パフで押さえるなら量を控えて粉浮きを回避。',
        fr: "Fixation : préfère un voile au pinceau; si houppette, mets très peu pour éviter l'effet plâtre.",
        es: 'Sellado: mejor un velo con brocha; si usas borla, poca cantidad para evitar efecto acartonado.',
        en: 'Set: prefer a light brush veil; if using a puff, use less to avoid cakiness.',
      }),
    );
  } else {
    lines.push(
      t({
        zh: '定妆：粉扑按压更持妆；散粉刷更轻薄，按你偏好选择。',
        ja: 'セット：パフは持ちが良く、ブラシは軽い仕上がり。好みで選んでOK。',
        fr: "Fixation : houppette = plus de tenue; pinceau = plus léger. Choisis selon ta préférence.",
        es: 'Sellado: borla = más duración; brocha = más ligero. Elige según tu preferencia.',
        en: 'Set: puff = longer wear; brush = lighter finish. Choose based on your preference.',
      }),
    );
  }

  lines.push(
    t({
      zh: '清洁：海绵/粉扑更易藏污纳垢，清洗后务必完全晾干再收纳。',
      ja: '洗浄：スポンジ/パフは汚れが残りやすいので、洗ったら完全に乾かしてから保管。',
      fr: "Nettoyage : éponge/houppette retiennent vite les impuretés; sèche totalement avant de ranger.",
      es: 'Limpieza: esponja/borla acumulan suciedad; sécalas por completo antes de guardar.',
      en: 'Cleaning: sponges/puffs trap buildup; fully dry them before storing.',
    }),
  );

  return lines;
}

function buildWhyThisWorks(user) {
  const lang = String(user?.language || 'en');
  const t = (dict) => dict[lang] || dict.en;

  const lines = [];
  if (user?.skill_level === 'beginner') {
    lines.push(
      t({
        zh: '优先选择容错更高的工具组合，减少“刷痕/结块/边界脏”。',
        ja: '失敗しにくい組み合わせを優先して、ムラ・ダマ・境目の汚れを減らす。',
        fr: "Priorise des outils tolérants pour réduire les traces, paquets et bords sales.",
        es: 'Prioriza herramientas más fáciles para reducir marcas, grumos y bordes sucios.',
        en: 'Choose forgiving tools to reduce streaks, clumps, and messy edges.',
      }),
    );
  }
  if (user?.goal === 'longwear_oil_control') {
    lines.push(
      t({
        zh: '粉扑按压 + 分区定妆能明显提升持妆，尤其是 T 区。',
        ja: 'パフで押さえて部分的にセットすると、特にTゾーンの持ちが上がる。',
        fr: "Presser avec la houppette + fixation par zones améliore nettement la tenue, surtout la zone T.",
        es: 'Presionar con borla + sellar por zonas mejora mucho la duración, sobre todo en la zona T.',
        en: 'Pressing with a puff + zone-setting improves wear, especially on the T-zone.',
      }),
    );
  }
  if (user?.goal === 'smooth_base') {
    lines.push(
      t({
        zh: '少量多次 + 轻拍收边更容易做出服帖、细腻的底妆。',
        ja: '少量ずつ＋叩いてなじませると、密着したきれいなベースになりやすい。',
        fr: 'Couches fines + tapotements = base plus fondue et plus lisse.',
        es: 'Capas finas + golpecitos = base más uniforme y suave.',
        en: 'Thin layers + tapping edges helps achieve a smoother base.',
      }),
    );
  }
  lines.push(
    t({
      zh: '加入清洁工具能降低闷痘/异味风险，减少投诉。',
      ja: 'クリーニング用品を入れると、ニキビ・臭いのリスクを下げられる。',
      fr: "Ajouter un outil de nettoyage réduit les risques d'irritations/odeurs.",
      es: 'Incluir herramientas de limpieza reduce el riesgo de brotes y olores.',
      en: 'Adding cleaning tools reduces the risk of breakouts/odor buildup.',
    }),
  );
  return lines;
}

function buildFollowUps(user) {
  const qs = [];
  const lang = String(user?.language || 'en');

  const t = (dict) => dict[lang] || dict.en;

  if (user?.goal === 'general') {
    qs.push(
      t({
        zh: '你主要想解决什么：底妆服帖 / 持妆控油 / 遮瑕 / 新手不翻车 / 眼妆更干净？',
        ja: '一番重視したいのはどれ？：ベース密着 / 皮脂崩れ防止 / 遮瑕 / 初心者でも失敗しにくい / 目元をきれいに',
        fr: "Quel est ton objectif principal : base bien fondue / tenue & anti-sébum / anti-cernes / débutant sans ratés / yeux plus nets ?",
        es: '¿Qué quieres resolver principalmente: base más adherente / larga duración y control de sebo / corrector / principiante sin fallos / ojos más limpios?',
        en: 'What’s your main goal: smoother base / longwear oil control / better coverage / beginner-safe / cleaner eye makeup?',
      }),
    );
  }
  if (user?.base_product_type === 'unknown') {
    qs.push(
      t({
        zh: '你常用底妆是：粉底液/粉霜/气垫/粉饼？（不知道也没关系）',
        ja: '普段のベースは？：リキッド/クリーム/クッション/パウダーファンデ（不明でもOK）',
        fr: 'Quel type de base utilises-tu : liquide / crème / cushion / poudre ? (si tu ne sais pas, pas grave)',
        es: '¿Qué base usas normalmente: líquida / crema / cushion / polvo? (si no lo sabes, no pasa nada)',
        en: 'What base do you usually use: liquid / cream / cushion / powder foundation? (unknown is fine)',
      }),
    );
  }
  if (user?.skin_type === 'unknown') {
    qs.push(
      t({
        zh: '你的肤质更接近：油皮 / 干皮 / 混合皮 / 敏感肌？',
        ja: '肌質はどれに近い？：脂性 / 乾燥 / 混合 / 敏感',
        fr: 'Ta peau est plutôt : grasse / sèche / mixte / sensible ?',
        es: 'Tu tipo de piel: grasa / seca / mixta / sensible?',
        en: 'Your skin type: oily / dry / combination / sensitive?',
      }),
    );
  }
  if (!user?.budget || (user?.budget?.max == null && user?.budget?.min == null)) {
    qs.push(
      t({
        zh: '预算大概在什么区间？我可以按预算给你分 A/B/C 三档。',
        ja: '予算感はどれくらい？予算に合わせて A/B/C で分けられるよ。',
        fr: 'Tu as quel budget ? Je peux te proposer 3 niveaux A/B/C selon le budget.',
        es: '¿Qué presupuesto tienes? Puedo dividirlo en 3 niveles A/B/C según el presupuesto.',
        en: 'What’s your budget? I can split recommendations into A/B/C tiers.',
      }),
    );
  }

  return qs.slice(0, 3);
}

function buildFocusedFollowUps({ lang, rawQuery, roles }) {
  const q = String(rawQuery || '');
  const lower = safeLower(q);
  const t = (dict) => dict[lang] || dict.en;

  const qs = [];

  const only = /只需要|只要|仅需要|只想要/.test(q);
  if (only) {
    // Keep follow-ups minimal when the user is explicit about scope.
    if (roles.includes(TOOL_ROLES.CONCEALER_BRUSH)) {
      qs.push(
        t({
          zh: '遮瑕你更常用在：黑眼圈（大面积）还是痘印点涂？',
          ja: '遮瑕は主に：クマ（広め）？それともニキビ跡の点置き？',
          fr: 'Anti-cernes : cernes (zone large) ou imperfections (point par point) ?',
          es: 'Corrector: ¿ojeras (zona amplia) o granitos/puntos?',
          en: 'Concealer: under-eyes (larger area) or spot concealing?',
        }),
      );
    }
    if (roles.includes(TOOL_ROLES.POWDER_PUFF) && /粉饼|powder foundation|cushion|气垫/.test(q) === false) {
      qs.push(
        t({
          zh: '你说的“粉饼”是定妆粉饼还是粉饼粉底？',
          ja: '「パウダー」は仕上げ用？それともパウダーファンデ？',
          fr: 'Ton “poudre” est plutôt une poudre de finition ou un fond de teint poudre ?',
          es: '¿Polvo para sellar o base en polvo?',
          en: 'Is that a setting powder, or powder foundation?',
        }),
      );
    }
    return qs.slice(0, 2);
  }

  if (/\b(quick|fast)\b/.test(lower) || /快捷|省时/.test(q)) {
    qs.push(
      t({
        zh: '你常用底妆是：气垫/粉饼/粉底液？（影响“更快更服帖”的工具选择）',
        ja: '普段のベースは？クッション/パウダー/リキッド？',
        fr: 'Ta base est plutôt cushion / poudre / liquide ?',
        es: '¿Tu base es cushion / polvo / líquida?',
        en: 'What base do you use most: cushion / powder / liquid?',
      }),
    );
  }

  if (roles.includes(TOOL_ROLES.POWDER_PUFF)) {
    qs.push(
      t({
        zh: '你更喜欢“轻薄自然”还是“更持妆、更遮瑕”的粉感？',
        ja: '仕上がりは薄めナチュラル？それとも持ち重視？',
        fr: 'Tu préfères léger/naturel ou plus tenue/couvrant ?',
        es: '¿Ligero/natural o más duradero/cubriente?',
        en: 'Do you prefer a light-natural finish or longer-wear/coverage?',
      }),
    );
  }

  return qs.slice(0, 2);
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
  user.language = String(intent?.language || 'en');
  const mapped = (Array.isArray(products) ? products : [])
    .map(mapRawProductToToolProduct)
    .filter(Boolean);

  // Hard filters.
  const filtered = mapped
    .filter(isInStock)
    .filter((t) => withinBudget(t, user.budget))
    .filter((t) => !(user?.preferences?.latex_free && t.latex_flag));

  const lang = user.language || 'en';

  // If the user asks for "celebrity same" brushes, don't jump into generic A/B/C kits.
  if (wantsCelebritySame(rawQuery) && !wantsTieredKits(rawQuery)) {
    const qs = buildCelebrityClarifiers(lang);
    const header = (lang === 'zh'
      ? '为了帮你配到“明星同款”的刷具，我先确认 1–2 个关键信息：'
      : lang === 'ja'
        ? '「同じメイク」の刷を合わせるために、まず1〜2点だけ確認させて：'
        : lang === 'fr'
          ? 'Pour te proposer des pinceaux “comme la célébrité”, je dois d’abord confirmer 1–2 infos :'
          : lang === 'es'
            ? 'Para recomendar “como la celebridad”, primero confirmo 1–2 cosas:'
            : 'To match a celebrity look, I need 1–2 quick details:');

    return {
      mode: 'clarify',
      reply_override: [header, ...qs.map((q) => `- ${q}`)].join('\n'),
      tool_kits: [],
      ordered_product_ids: [],
      follow_up_questions: qs,
      stats: { has_good_match: false, match_tier: 'none', match_confidence: 0, tool_candidates_count: filtered.length },
      user_summary: user,
    };
  }

  const tiered = wantsTieredKits(rawQuery);

  const tierNames = {
    zh: {
      A: 'A 新手极简：底妆更干净',
      B: 'B 通勤完整：全脸覆盖更省心',
      C: 'C 进阶妆效：更细节更专业',
    },
    ja: {
      A: 'A 初心者ミニマル：ベースをきれいに',
      B: 'B 通勤フル：全顔を手早く',
      C: 'C 上級仕上げ：より細かくプロっぽく',
    },
    fr: {
      A: 'A Débutant minimal : teint plus net',
      B: 'B Bureau complet : visage complet, plus simple',
      C: 'C Avancé : plus de détails, plus pro',
    },
    es: {
      A: 'A Principiante minimal: base más limpia',
      B: 'B Diario completo: rostro completo, más fácil',
      C: 'C Avanzado: más detalle, más pro',
    },
    en: {
      A: 'A Beginner Minimal: cleaner base',
      B: 'B Everyday Complete: full face made easy',
      C: 'C Advanced Finish: more detail, more pro',
    },
  };
  const names = tierNames[lang] || tierNames.en;

  const templates = tiered
    ? [
        {
          name: names.A,
          roles: [TOOL_ROLES.SPONGE, TOOL_ROLES.POWDER_BRUSH, TOOL_ROLES.MULTI_FACE_BRUSH, TOOL_ROLES.CLEANER],
        },
        {
          name: names.B,
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
          name: names.C,
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
      ]
    : [
        {
          name:
            lang === 'zh'
              ? '精简清单：按你当前需求'
              : lang === 'ja'
                ? 'ミニマル：いまの要件に合わせて'
                : lang === 'fr'
                  ? 'Minimal : selon ton besoin'
                  : lang === 'es'
                    ? 'Minimal: según tu necesidad'
                    : 'Focused: based on your needs',
          roles: parseFocusedRoles(rawQuery),
        },
      ];

  let kits = templates.map((tpl) => assembleKit(tpl, filtered, user));

  // If we found no tool candidates at all, return "skeleton" kits (roles only, no products)
  // so we can still guide the user without recommending unrelated items.
  let stats = computeToolRequestStats(kits);
  if (filtered.length === 0) {
    kits = templates.map((tpl) => ({
      kit_name: tpl.name,
      items: [],
      completeness: 0,
      missing_roles: tpl.roles,
    }));
    stats = { has_good_match: false, match_tier: 'none', match_confidence: 0 };
  }
  stats = { ...stats, tool_candidates_count: filtered.length };

  const followUps = tiered
    ? buildFollowUps(user)
    : buildFocusedFollowUps({ lang, rawQuery, roles: templates[0].roles });

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
    cautions: user?.preferences?.latex_free
      ? [
          (user.language === 'zh'
            ? '已按“无乳胶”偏好优先筛选；如果你不确定是否过敏，可以先从无乳胶开始。'
            : user.language === 'ja'
              ? 'ラテックスフリーを優先しています。アレルギーが不安なら、まずはラテックスフリーから。'
            : user.language === 'fr'
                ? 'Préférence latex-free appliquée. Si tu n’es pas sûr(e), commence par du latex-free.'
              : user.language === 'es'
                  ? 'Se priorizó “sin látex”. Si no estás seguro/a, empieza por opciones sin látex.'
                  : 'Latex-free preference applied. If unsure, start with latex-free.')
        ]
      : [],
    alternatives: [],
    completeness: k.completeness,
    missing_roles: k.missing_roles,
  }));

  return {
    mode: tiered ? 'tiered' : 'focused',
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
