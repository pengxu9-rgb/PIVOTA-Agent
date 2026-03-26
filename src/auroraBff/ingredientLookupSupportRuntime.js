function fallbackPickFirstTrimmed(...values) {
  for (const raw of values) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) return text;
  }
  return '';
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createIngredientLookupSupportRuntime(options = {}) {
  const {
    getBestIngredientReferenceMatch = async () => null,
    getBestIngredientSignalMatch = async () => null,
    extractKnownActivesFromText = () => [],
    matchIngredientOntology = () => [],
    pickFirstTrimmed = fallbackPickFirstTrimmed,
  } = options;

  const pickFirstTrimmedFn = typeof pickFirstTrimmed === 'function'
    ? pickFirstTrimmed
    : fallbackPickFirstTrimmed;

  let getBestIngredientReferenceMatchImpl = getBestIngredientReferenceMatch;
  let getBestIngredientSignalMatchImpl = getBestIngredientSignalMatch;

  const INGREDIENT_ENTITY_DICT = Object.freeze([
    { key: 'niacinamide', canonical_en: 'niacinamide', canonical_cn: '烟酰胺', family: 'vitamin', aliases: ['nicotinamide', 'vitamin b3', '维生素b3', '维b3'] },
    { key: 'retinol', canonical_en: 'retinol', canonical_cn: 'A醇/维A类', family: 'retinoid', aliases: ['retinoid', 'vitamin a', '视黄醇', 'a醇', '维a', '维甲醇'] },
    { key: 'tretinoin', canonical_en: 'tretinoin', canonical_cn: '维A酸', family: 'retinoid', aliases: ['retinoic acid', 'retin-a', '维甲酸'] },
    { key: 'adapalene', canonical_en: 'adapalene', canonical_cn: '阿达帕林', family: 'retinoid', aliases: ['differin'] },
    { key: 'azelaic_acid', canonical_en: 'azelaic acid', canonical_cn: '壬二酸', family: 'exfoliant', aliases: ['azelaic', 'azelic acid'] },
    { key: 'salicylic_acid', canonical_en: 'salicylic acid', canonical_cn: '水杨酸', family: 'bha', aliases: ['bha', 'beta hydroxy acid'] },
    { key: 'glycolic_acid', canonical_en: 'glycolic acid', canonical_cn: '果酸', family: 'aha', aliases: ['aha', 'alpha hydroxy acid', '甘醇酸'] },
    { key: 'lactic_acid', canonical_en: 'lactic acid', canonical_cn: '乳酸', family: 'aha', aliases: [] },
    { key: 'mandelic_acid', canonical_en: 'mandelic acid', canonical_cn: '杏仁酸', family: 'aha', aliases: [] },
    { key: 'vitamin_c', canonical_en: 'vitamin c', canonical_cn: '维生素C', family: 'antioxidant', aliases: ['ascorbic acid', 'ascorbic', 'vc', '维c', '抗坏血酸'] },
    { key: 'benzoyl_peroxide', canonical_en: 'benzoyl peroxide', canonical_cn: '过氧化苯甲酰', family: 'acne_active', aliases: ['bpo', 'bp'] },
    { key: 'glycerin', canonical_en: 'glycerin', canonical_cn: '甘油', family: 'humectant', aliases: ['glycerol', '丙三醇'] },
    { key: 'hyaluronic_acid', canonical_en: 'hyaluronic acid', canonical_cn: '透明质酸', family: 'humectant', aliases: ['ha', 'sodium hyaluronate', '玻尿酸'] },
    { key: 'panthenol', canonical_en: 'panthenol', canonical_cn: '泛醇', family: 'humectant', aliases: ['provitamin b5', 'dexpanthenol', '维生素b5'] },
    { key: 'ceramide_np', canonical_en: 'ceramide np', canonical_cn: '神经酰胺NP', family: 'ceramide', aliases: ['ceramide', 'ceramides', '神经酰胺'] },
    { key: 'squalane', canonical_en: 'squalane', canonical_cn: '角鲨烷', family: 'oil_emollient', aliases: ['squalene'] },
    { key: 'dimethicone', canonical_en: 'dimethicone', canonical_cn: '聚二甲基硅氧烷', family: 'silicone', aliases: ['dimethicone', '硅油'] },
    { key: 'behenyl_alcohol', canonical_en: 'behenyl alcohol', canonical_cn: '山嵛醇', family: 'fatty_alcohol', aliases: ['docosanol'] },
    { key: 'cetyl_alcohol', canonical_en: 'cetyl alcohol', canonical_cn: '鲸蜡醇', family: 'fatty_alcohol', aliases: ['cetanol'] },
    { key: 'stearyl_alcohol', canonical_en: 'stearyl alcohol', canonical_cn: '硬脂醇', family: 'fatty_alcohol', aliases: [] },
    { key: 'cetearyl_alcohol', canonical_en: 'cetearyl alcohol', canonical_cn: '鲸蜡硬脂醇', family: 'fatty_alcohol', aliases: [] },
    { key: 'zinc_oxide', canonical_en: 'zinc oxide', canonical_cn: '氧化锌', family: 'mineral_filter', aliases: ['zno'] },
    { key: 'titanium_dioxide', canonical_en: 'titanium dioxide', canonical_cn: '二氧化钛', family: 'mineral_filter', aliases: ['tio2'] },
    { key: 'avobenzone', canonical_en: 'avobenzone', canonical_cn: '阿伏苯宗', family: 'uv_filter', aliases: ['butyl methoxydibenzoylmethane', 'parsol 1789'] },
    { key: 'octocrylene', canonical_en: 'octocrylene', canonical_cn: '奥克立林', family: 'uv_filter', aliases: ['octocrileno'] },
    { key: 'octisalate', canonical_en: 'octisalate', canonical_cn: '水杨酸乙基己酯', family: 'uv_filter', aliases: ['ethylhexyl salicylate'] },
    { key: 'homosalate', canonical_en: 'homosalate', canonical_cn: '胡莫柳酯', family: 'uv_filter', aliases: [] },
    { key: 'butyloctyl_salicylate', canonical_en: 'butyloctyl salicylate', canonical_cn: '辛基水杨酸丁酯', family: 'uv_filter', aliases: [] },
    { key: 'phenoxyethanol', canonical_en: 'phenoxyethanol', canonical_cn: '苯氧乙醇', family: 'preservative', aliases: [] },
    { key: 'ethylhexylglycerin', canonical_en: 'ethylhexylglycerin', canonical_cn: '乙基己基甘油', family: 'preservative', aliases: [] },
    { key: 'tranexamic_acid', canonical_en: 'tranexamic acid', canonical_cn: '传明酸', family: 'brightening', aliases: ['tranexamic', '氨甲环酸'] },
    { key: 'arbutin', canonical_en: 'arbutin', canonical_cn: '熊果苷', family: 'brightening', aliases: ['alpha arbutin', 'α-熊果苷'] },
    { key: 'allantoin', canonical_en: 'allantoin', canonical_cn: '尿囊素', family: 'humectant', aliases: [] },
  ]);

  function ingredient_query_normalize(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[’‘`´]/g, "'")
      .replace(/[-–—_]/g, ' ')
      .replace(/[()[\]{}:,;.!?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function ingredientEntityDisplayName(entityKey, language = 'EN') {
    const lang = language === 'CN' ? 'CN' : 'EN';
    const row = INGREDIENT_ENTITY_DICT.find((entry) => entry && entry.key === entityKey);
    if (!row) return '';
    return lang === 'CN' ? String(row.canonical_cn || '').trim() : String(row.canonical_en || '').trim();
  }

  function ingredientAliasTokenMatches(normalized, token) {
    const haystack = String(normalized || '').trim();
    const needle = String(token || '').trim();
    if (!haystack || !needle) return false;
    if (!/[a-z0-9]/i.test(needle)) return haystack.includes(needle);
    if (needle.length <= 3) {
      const boundaryRegex = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}($|[^a-z0-9])`, 'i');
      return boundaryRegex.test(haystack);
    }
    return haystack.includes(needle);
  }

  function ingredientEntityMatchFromText(raw, language = 'EN') {
    const normalized = ingredient_query_normalize(raw);
    if (!normalized) {
      return {
        normalized_query: '',
        entity_key: '',
        entity_match_type: 'none',
        entity_confidence: 0,
      };
    }
    for (const row of INGREDIENT_ENTITY_DICT) {
      const exactSet = [
        ingredient_query_normalize(row.canonical_en),
        ingredient_query_normalize(row.canonical_cn),
        ...((Array.isArray(row.aliases) ? row.aliases : []).map((alias) => ingredient_query_normalize(alias))),
      ].filter(Boolean);
      if (exactSet.includes(normalized)) {
        return {
          normalized_query: normalized,
          entity_key: row.key,
          entity_match_type: 'exact',
          entity_confidence: 1,
        };
      }
    }
    for (const row of INGREDIENT_ENTITY_DICT) {
      const aliasSet = [
        ingredient_query_normalize(row.canonical_en),
        ingredient_query_normalize(row.canonical_cn),
        ...((Array.isArray(row.aliases) ? row.aliases : []).map((alias) => ingredient_query_normalize(alias))),
      ].filter(Boolean);
      if (aliasSet.some((token) => ingredientAliasTokenMatches(normalized, token))) {
        return {
          normalized_query: normalized,
          entity_key: row.key,
          entity_match_type: 'alias',
          entity_confidence: 0.88,
        };
      }
    }
    for (const row of INGREDIENT_ENTITY_DICT) {
      const fuzzyTokens = [
        ingredient_query_normalize(row.canonical_en),
        ingredient_query_normalize(row.canonical_cn),
        ...((Array.isArray(row.aliases) ? row.aliases : []).map((alias) => ingredient_query_normalize(alias))),
      ]
        .map((token) => token.replace(/\s+/g, ''))
        .filter((token) => token.length >= 5);
      const compact = normalized.replace(/\s+/g, '');
      if (fuzzyTokens.some((token) => compact.includes(token) || token.includes(compact))) {
        return {
          normalized_query: normalized,
          entity_key: row.key,
          entity_match_type: 'fuzzy',
          entity_confidence: 0.7,
        };
      }
    }
    return {
      normalized_query: normalized,
      entity_key: '',
      entity_match_type: 'none',
      entity_confidence: 0,
    };
  }

  function normalizeIngredientLookupToken(raw) {
    const match = ingredientEntityMatchFromText(raw);
    return match.entity_key || '';
  }

  function mapIngredientLookupTokenToQuery(token, language = 'EN') {
    return ingredientEntityDisplayName(String(token || '').trim().toLowerCase(), language);
  }

  function mapRoutineActiveTokenToIngredientQuery(token, language = 'EN') {
    const key = String(token || '').trim().toLowerCase();
    if (!key) return '';
    if (key === 'retinoid') return mapIngredientLookupTokenToQuery('retinol', language);
    if (key === 'niacinamide') return mapIngredientLookupTokenToQuery('niacinamide', language);
    if (key === 'azelaic_acid') return mapIngredientLookupTokenToQuery('azelaic_acid', language);
    if (key === 'vitamin_c') return mapIngredientLookupTokenToQuery('vitamin_c', language);
    return '';
  }

  function sanitizeIngredientReferenceRuntimeMatch(reference) {
    if (!reference || typeof reference !== 'object') return null;
    const takeList = (value, max = 12) =>
      Array.isArray(value)
        ? value
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, max)
        : [];
    return {
      record_id: String(reference.record_id || '').trim() || null,
      normalized_key: String(reference.normalized_key || '').trim() || null,
      canonical_inci_name: String(reference.canonical_inci_name || '').trim() || null,
      canonical_display_name: String(reference.canonical_display_name || '').trim() || null,
      ingredient_family: String(reference.ingredient_family || '').trim() || null,
      primary_bucket: String(reference.primary_bucket || '').trim() || null,
      us_label_name: String(reference.us_label_name || '').trim() || null,
      eu_label_name: String(reference.eu_label_name || '').trim() || null,
      alias_quality: String(reference.alias_quality || '').trim() || null,
      notes_for_parser: String(reference.notes_for_parser || '').trim() || null,
      confidence: String(reference.confidence || '').trim() || null,
      aliases_common_list: takeList(reference.aliases_common_list),
      parser_variants_list: takeList(reference.parser_variants_list),
      deprecated_aliases_list: takeList(reference.deprecated_aliases_list),
      all_buckets_list: takeList(reference.all_buckets_list),
      function_tags_list: takeList(reference.function_tags_list),
      benefit_tags_list: takeList(reference.benefit_tags_list),
      risk_flags_list: takeList(reference.risk_flags_list),
      flags:
        reference.flags && typeof reference.flags === 'object' && !Array.isArray(reference.flags)
          ? {
            is_humectant: reference.flags.is_humectant === true,
            is_barrier_support: reference.flags.is_barrier_support === true,
            is_retinoid: reference.flags.is_retinoid === true,
            is_exfoliant: reference.flags.is_exfoliant === true,
            is_uv_filter: reference.flags.is_uv_filter === true,
            is_preservative: reference.flags.is_preservative === true,
            is_surfactant: reference.flags.is_surfactant === true,
            is_fragrance_or_eo: reference.flags.is_fragrance_or_eo === true,
          }
          : null,
    };
  }

  async function resolveIngredientReferenceRuntimeMatch(input, language = 'EN') {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const reference = sanitizeIngredientReferenceRuntimeMatch(await getBestIngredientReferenceMatchImpl(raw));
      if (!reference) return null;
      const canonicalQuery = pickFirstTrimmedFn(
        reference.canonical_display_name,
        reference.canonical_inci_name,
        reference.us_label_name,
        reference.eu_label_name,
      ) || raw;
      return {
        canonical_query: String(canonicalQuery).slice(0, 120),
        language: language === 'CN' ? 'CN' : 'EN',
        reference,
      };
    } catch {
      return null;
    }
  }

  function sanitizeIngredientSignalRuntimeMatch(signal) {
    if (!signal || typeof signal !== 'object') return null;
    const takeList = (value, max = 12) =>
      Array.isArray(value)
        ? value
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, max)
        : [];
    return {
      signal_bucket: String(signal.signal_bucket || '').trim() || null,
      signal_key: String(signal.signal_key || '').trim() || null,
      display_signal_name: String(signal.display_signal_name || '').trim() || null,
      raw_token_variants_list: takeList(signal.raw_token_variants_list),
      normalized_token_variants_list: takeList(signal.normalized_token_variants_list),
      source_packets_list: takeList(signal.source_packets_list),
      source_decisions_list: takeList(signal.source_decisions_list),
      confidence_levels_list: takeList(signal.confidence_levels_list),
      top_categories_list: takeList(signal.top_categories_list),
      example_brands_list: takeList(signal.example_brands_list),
      example_products_list: takeList(signal.example_products_list),
      example_urls_list: takeList(signal.example_urls_list),
      resolution_rationales_list: takeList(signal.resolution_rationales_list),
      row_count: Number.isFinite(Number(signal.row_count)) ? Number(signal.row_count) : 0,
      total_sku_row_count: Number.isFinite(Number(signal.total_sku_row_count)) ? Number(signal.total_sku_row_count) : 0,
    };
  }

  async function resolveIngredientSignalRuntimeMatch(input, language = 'EN') {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const signal = sanitizeIngredientSignalRuntimeMatch(await getBestIngredientSignalMatchImpl(raw));
      if (!signal) return null;
      const canonicalQuery = pickFirstTrimmedFn(signal.display_signal_name, raw) || raw;
      return {
        canonical_query: String(canonicalQuery).slice(0, 120),
        language: language === 'CN' ? 'CN' : 'EN',
        signal,
      };
    } catch {
      return null;
    }
  }

  function shouldPreferSignalRuntimeMatch(signalMatch, entityMatch, referenceMatch) {
    if (!signalMatch || !signalMatch.signal || (referenceMatch && referenceMatch.reference)) return false;
    const signalBucket = String(signalMatch.signal.signal_bucket || '').trim().toLowerCase();
    if (
      signalBucket === 'acid_family_signal' ||
      signalBucket === 'ingredient_family_signal' ||
      signalBucket === 'marketing_or_blend_signal' ||
      signalBucket === 'strength_claim_signal' ||
      signalBucket === 'claim_phrase_signal'
    ) {
      return true;
    }
    const entityType = String(entityMatch && entityMatch.entity_match_type ? entityMatch.entity_match_type : '')
      .trim()
      .toLowerCase();
    return entityType === '' || entityType === 'none' || entityType === 'alias' || entityType === 'fuzzy';
  }

  function formatIngredientReferenceFacet(token, language = 'EN') {
    const lang = language === 'CN' ? 'CN' : 'EN';
    const key = String(token || '').trim().toLowerCase();
    if (!key) return '';
    const labels = {
      hydration: { EN: 'Hydration support', CN: '保湿支持' },
      repair: { EN: 'Barrier repair support', CN: '屏障修护支持' },
      'anti-aging': { EN: 'Anti-aging support', CN: '抗老支持' },
      'anti-acne': { EN: 'Acne support', CN: '抗痘支持' },
      exfoliant: { EN: 'Exfoliant', CN: '去角质活性' },
      sunscreen: { EN: 'Sunscreen support', CN: '防晒支持' },
      preservative: { EN: 'Preservative system', CN: '防腐体系' },
      surfactant: { EN: 'Surfactant', CN: '表活体系' },
      'fragrance/essential oil': { EN: 'Fragrance / essential oil', CN: '香精/精油' },
      humectant: { EN: 'Humectant', CN: '吸湿保湿剂' },
      emollient: { EN: 'Emollient', CN: '柔润剂' },
      occlusive: { EN: 'Occlusive', CN: '封闭保湿剂' },
      ceramide: { EN: 'Ceramide', CN: '神经酰胺类' },
      peptide: { EN: 'Peptide', CN: '多肽类' },
      retinoid: { EN: 'Retinoid', CN: '维A类' },
      acid_exfoliant: { EN: 'Acid exfoliant', CN: '酸类去角质活性' },
      uv_filter: { EN: 'UV filter', CN: '防晒滤剂' },
      fragrance: { EN: 'Fragrance', CN: '香精类' },
      plant_extract: { EN: 'Plant extract', CN: '植物提取物' },
      solvent: { EN: 'Solvent', CN: '溶剂' },
      vitamin: { EN: 'Vitamin active', CN: '维生素类活性' },
      other: { EN: 'Ingredient reference', CN: '成分参考' },
    };
    if (labels[key]) return labels[key][lang];
    return key
      .split(/[_/]+/)
      .filter(Boolean)
      .map((part) => {
        if (part === 'uv') return 'UV';
        if (part === 'eo') return 'EO';
        return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      })
      .join(' / ');
  }

  function buildIngredientReferenceAliases(reference) {
    if (!reference || typeof reference !== 'object') return [];
    const seen = new Set();
    const out = [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };
    push(reference.canonical_display_name);
    push(reference.canonical_inci_name);
    push(reference.us_label_name);
    push(reference.eu_label_name);
    for (const item of Array.isArray(reference.aliases_common_list) ? reference.aliases_common_list : []) push(item);
    for (const item of Array.isArray(reference.deprecated_aliases_list) ? reference.deprecated_aliases_list : []) push(item);
    return out.slice(0, 12);
  }

  function buildIngredientReferenceCategory(reference, language = 'EN') {
    const family = formatIngredientReferenceFacet(reference && reference.ingredient_family, language);
    const bucket = formatIngredientReferenceFacet(reference && reference.primary_bucket, language);
    if (family && bucket && family.toLowerCase() !== bucket.toLowerCase()) return `${family} / ${bucket}`;
    return family || bucket || (language === 'CN' ? '成分参考' : 'Ingredient reference');
  }

  function buildIngredientReferenceBenefits(reference, language = 'EN') {
    if (!reference || typeof reference !== 'object') return [];
    const lang = language === 'CN' ? 'CN' : 'EN';
    const rawTokens = [
      ...(Array.isArray(reference.benefit_tags_list) ? reference.benefit_tags_list : []),
      ...(Array.isArray(reference.function_tags_list) ? reference.function_tags_list : []),
      reference.primary_bucket || '',
    ];
    const seen = new Set();
    const tokens = [];
    for (const item of rawTokens) {
      const text = String(item || '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(text);
    }
    return tokens.slice(0, 3).map((token) => {
      const label = formatIngredientReferenceFacet(token, lang);
      const concern = String(token || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'ingredient-benefit';
      return {
        concern,
        strength: 2,
        what_it_means:
          lang === 'CN'
            ? `${label} 是 reviewed ingredient reference 中标记的主要作用方向。`
            : `${label} is one of the reviewed roles captured in the ingredient reference seed.`,
      };
    });
  }

  function buildIngredientReferenceWatchouts(reference, language = 'EN') {
    if (!reference || typeof reference !== 'object') return [];
    const lang = language === 'CN' ? 'CN' : 'EN';
    const directFlags = (Array.isArray(reference.risk_flags_list) ? reference.risk_flags_list : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((token) => ({
        issue: formatIngredientReferenceFacet(token, lang) || token,
        likelihood: 'uncommon',
        what_to_do:
          lang === 'CN'
            ? '结合肤质与配方整体刺激性观察耐受。'
            : 'Check tolerance against your skin profile and the full formula context.',
      }));
    if (directFlags.length) return directFlags;
    const flags = reference.flags && typeof reference.flags === 'object' ? reference.flags : {};
    if (flags.is_retinoid) {
      return [
        {
          issue: lang === 'CN' ? '维A类耐受建立' : 'Retinoid tolerance ramp-up',
          likelihood: 'common',
          what_to_do: lang === 'CN' ? '从低频开始，并配合保湿与日间防晒。' : 'Start low-frequency and pair with moisturizer plus daytime SPF.',
        },
      ];
    }
    if (flags.is_exfoliant) {
      return [
        {
          issue: lang === 'CN' ? '过度去角质风险' : 'Over-exfoliation risk',
          likelihood: 'common',
          what_to_do: lang === 'CN' ? '避免和其他强活性同晚叠加，先低频起步。' : 'Avoid stacking with other strong actives on the same night; start slowly.',
        },
      ];
    }
    if (flags.is_fragrance_or_eo) {
      return [
        {
          issue: lang === 'CN' ? '香精/精油敏感风险' : 'Fragrance sensitivity risk',
          likelihood: 'uncommon',
          what_to_do: lang === 'CN' ? '敏感肌或屏障受损时先做局部试用。' : 'Patch test first if you are sensitive or currently barrier-compromised.',
        },
      ];
    }
    return [];
  }

  function buildIngredientReferenceFallback(reference, language = 'EN', inputName = '') {
    if (!reference || typeof reference !== 'object') return null;
    const lang = language === 'CN' ? 'CN' : 'EN';
    const displayName = pickFirstTrimmedFn(reference.canonical_display_name, reference.canonical_inci_name, inputName) || inputName;
    const category = buildIngredientReferenceCategory(reference, lang);
    return {
      inci: pickFirstTrimmedFn(reference.canonical_inci_name, displayName, inputName),
      display_name: displayName,
      aliases: buildIngredientReferenceAliases(reference),
      category,
      one_liner:
        lang === 'CN'
          ? `${displayName} 已在 reviewed ingredient reference 中登记，当前归类为 ${category}。`
          : `${displayName} is tracked in the reviewed ingredient reference seed and currently classified as ${category}.`,
      benefits: buildIngredientReferenceBenefits(reference, lang),
      watchouts: buildIngredientReferenceWatchouts(reference, lang),
      pair_well: [],
      separate: [],
    };
  }

  function formatIngredientSignalBucket(bucket, language = 'EN') {
    const lang = language === 'CN' ? 'CN' : 'EN';
    const key = String(bucket || '').trim().toLowerCase();
    const labels = {
      ingredient_family_signal: { EN: 'Ingredient family signal', CN: '成分家族信号' },
      acid_family_signal: { EN: 'Acid family signal', CN: '酸类家族信号' },
      marketing_or_blend_signal: { EN: 'Marketing / blend signal', CN: '营销/复配信号' },
      strength_claim_signal: { EN: 'Strength claim signal', CN: '浓度/强度信号' },
      botanical_or_material_signal: { EN: 'Botanical / material signal', CN: '植物/材料信号' },
      claim_phrase_signal: { EN: 'Claim phrase signal', CN: '功效表述信号' },
      named_active_signal: { EN: 'Named active signal', CN: '命名活性信号' },
    };
    if (labels[key]) return labels[key][lang];
    return lang === 'CN' ? '成分信号' : 'Ingredient signal';
  }

  function buildIngredientSignalAliases(signal) {
    if (!signal || typeof signal !== 'object') return [];
    const seen = new Set();
    const out = [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };
    push(signal.display_signal_name);
    push(signal.signal_key);
    for (const item of Array.isArray(signal.raw_token_variants_list) ? signal.raw_token_variants_list : []) push(item);
    return out.slice(0, 12);
  }

  function buildIngredientSignalBenefits(signal, language = 'EN') {
    if (!signal || typeof signal !== 'object') return [];
    const lang = language === 'CN' ? 'CN' : 'EN';
    const bucket = String(signal.signal_bucket || '').trim().toLowerCase();
    const map = {
      ingredient_family_signal: {
        concern: 'ingredient-family',
        EN: 'This label maps to an ingredient family umbrella, not one exact INCI row.',
        CN: '这个标签更像成分家族总称，不是单一 INCI 行。',
      },
      acid_family_signal: {
        concern: 'acid-family',
        EN: 'This term captures an acid-family shorthand used on labels and marketing copy.',
        CN: '这个词更像标签/营销中的酸类家族简称。',
      },
      marketing_or_blend_signal: {
        concern: 'marketing-blend',
        EN: 'This is a reviewed blend or trade-name signal worth preserving for product interpretation.',
        CN: '这是一个已审核的复配/商标信号，适合保留用于解读产品文案。',
      },
      strength_claim_signal: {
        concern: 'strength-claim',
        EN: 'This captures a declared strength or SPF-style signal from product labeling.',
        CN: '这个词捕捉的是产品标签里的浓度或 SPF 类强度信号。',
      },
      botanical_or_material_signal: {
        concern: 'botanical-material',
        EN: 'This points to a reviewed botanical or material callout commonly surfaced as a hero signal.',
        CN: '这个词更像已审核的植物/材料型 hero signal。',
      },
      claim_phrase_signal: {
        concern: 'claim-phrase',
        EN: 'This phrase groups multiple actives or benefits into one product-level signal.',
        CN: '这个短语通常把多个活性或功效打包成一个产品级信号。',
      },
      named_active_signal: {
        concern: 'named-active',
        EN: 'This is a reviewed named-active signal that should be preserved even when it is not a canonical INCI.',
        CN: '这是一个已审核的命名活性信号，即使它不是 canonical INCI 也值得保留。',
      },
    };
    const entry = map[bucket];
    if (!entry) return [];
    return [
      {
        concern: entry.concern,
        strength: 2,
        what_it_means: entry[lang],
      },
    ];
  }

  function buildIngredientSignalWatchouts(signal, language = 'EN') {
    if (!signal || typeof signal !== 'object') return [];
    const lang = language === 'CN' ? 'CN' : 'EN';
    const bucket = String(signal.signal_bucket || '').trim().toLowerCase();
    const map = {
      ingredient_family_signal: {
        issue: lang === 'CN' ? '家族词不等于具体成分' : 'Family term is not one exact ingredient',
        what_to_do:
          lang === 'CN'
            ? '仍需结合完整 INCI 判断具体是哪一类成员和实际占比。'
            : 'Use the full INCI list to confirm which member of the family is actually present.',
      },
      acid_family_signal: {
        issue: lang === 'CN' ? '酸类总称不代表具体酸型和浓度' : 'Acid umbrella term hides the exact acid and strength',
        what_to_do:
          lang === 'CN'
            ? '需要结合具体酸型、浓度和频率来判断刺激风险。'
            : 'Check the exact acid type, strength, and usage frequency before estimating irritation risk.',
      },
      marketing_or_blend_signal: {
        issue: lang === 'CN' ? '商标/复配名可能覆盖多个原料' : 'Trade or blend name can hide multiple ingredients',
        what_to_do:
          lang === 'CN'
            ? '把它当成配方信号，而不是单一 INCI；具体成分仍以完整列表为准。'
            : 'Treat it as a formulation signal rather than a single INCI; confirm the underlying actives separately.',
      },
      strength_claim_signal: {
        issue: lang === 'CN' ? '强度标签不等于完整适配结论' : 'Strength claim alone is not a full fit verdict',
        what_to_do:
          lang === 'CN'
            ? '还要结合剂型、体系和耐受度来判断是否适合。'
            : 'Interpret it together with the vehicle, supporting actives, and your tolerance profile.',
      },
      botanical_or_material_signal: {
        issue: lang === 'CN' ? 'hero 材料词不等于高占比' : 'Hero material callout does not guarantee high concentration',
        what_to_do:
          lang === 'CN'
            ? '它更适合做配方信号，仍需回看完整 INCI 与排位。'
            : 'Use it as a formulation signal and verify the actual INCI placement.',
      },
      claim_phrase_signal: {
        issue: lang === 'CN' ? '功效短语通常打包了多项东西' : 'Claim phrase often bundles several actives together',
        what_to_do:
          lang === 'CN'
            ? '不要把这类短语直接当作单一成分；需要拆回具体活性。'
            : 'Do not treat it as one standalone ingredient; unpack it into specific actives where possible.',
      },
      named_active_signal: {
        issue: lang === 'CN' ? '命名活性可能是专有词或单一活性' : 'Named active can be proprietary or context-dependent',
        what_to_do:
          lang === 'CN'
            ? '保留它作为信号词，但具体机制仍要结合品牌说明与 INCI。'
            : 'Preserve it as a signal term, then validate the underlying mechanism against brand docs and INCI.',
      },
    };
    const entry = map[bucket];
    if (!entry) return [];
    return [
      {
        issue: entry.issue,
        likelihood: 'common',
        what_to_do: entry.what_to_do,
      },
    ];
  }

  function buildIngredientSignalFallback(signal, language = 'EN', inputName = '') {
    if (!signal || typeof signal !== 'object') return null;
    const lang = language === 'CN' ? 'CN' : 'EN';
    const displayName = pickFirstTrimmedFn(signal.display_signal_name, inputName) || inputName;
    const category = formatIngredientSignalBucket(signal.signal_bucket, lang);
    return {
      inci: displayName,
      display_name: displayName,
      aliases: buildIngredientSignalAliases(signal),
      category,
      what_it_is:
        lang === 'CN'
          ? `${displayName} 是 reviewed signal dictionary 中登记的信号词，不一定对应单一 canonical INCI。`
          : `${displayName} is a reviewed signal-dictionary term and may not correspond to one single canonical INCI row.`,
      one_liner:
        lang === 'CN'
          ? `${displayName} 已在 reviewed signal dictionary 中登记，当前按 ${category} 处理。`
          : `${displayName} is tracked in the reviewed signal dictionary and is currently treated as ${category}.`,
      benefits: buildIngredientSignalBenefits(signal, lang),
      watchouts: buildIngredientSignalWatchouts(signal, lang),
      pair_well: [],
      separate: [],
    };
  }

  function looksLikeFreeTextIngredientName(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;
    if (!/^[A-Za-z][A-Za-z0-9'()+\-\s]{3,120}$/.test(text)) return false;
    const lower = text.toLowerCase();
    const tokens = lower.split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 5) return false;

    if (
      /\b(start|diagnosis|analysis|routine|recommend|recommendation|product|products|skin|profile|help|please|can|should|need|want|send|link|url|evaluate|check)\b/.test(
        lower,
      )
    ) {
      return false;
    }

    if (
      /(acid|amide|retinol|niacinamide|ceramide|peptide|salicylate|glycol|ascorb|benzoyl|tretinoin|adapalene|azelaic|tocopherol|panthenol|hyaluron|squalane|glycerin|alcohol|extract|oxide|sulfate|phosphate|siloxane|butyl|ethyl|methyl|propyl)/.test(
        lower,
      )
    ) {
      return true;
    }

    const originalTokens = text.split(/\s+/).filter(Boolean);
    const titleCaseLike = originalTokens.every((token) => /^[A-Z][a-z0-9()+\-']+$/.test(token));
    if (titleCaseLike && originalTokens.length <= 3 && originalTokens.join('').length >= 12) {
      return true;
    }

    return false;
  }

  async function extractIngredientLookupTargetFromText(message, language = 'EN') {
    const raw = String(message || '').trim();
    if (!raw) return '';
    const lang = language === 'CN' ? 'CN' : 'EN';
    const entityMatch = ingredientEntityMatchFromText(raw, lang);
    const referenceMatch = await resolveIngredientReferenceRuntimeMatch(raw, lang);
    if (referenceMatch && referenceMatch.canonical_query) {
      return String(referenceMatch.canonical_query).slice(0, 120);
    }
    const signalMatch = await resolveIngredientSignalRuntimeMatch(raw, lang);
    if (shouldPreferSignalRuntimeMatch(signalMatch, entityMatch, referenceMatch) && signalMatch.canonical_query) {
      return String(signalMatch.canonical_query).slice(0, 120);
    }

    const knownActivesRaw = extractKnownActivesFromText(raw, lang);
    const knownActives = Array.isArray(knownActivesRaw) ? knownActivesRaw : [];
    for (const token of knownActives) {
      const mapped = mapRoutineActiveTokenToIngredientQuery(token, lang);
      if (mapped) return String(mapped).slice(0, 120);
    }

    const ontologyHitsRaw = matchIngredientOntology({ text: raw, language: lang, max: 8 });
    const ontologyHits = Array.isArray(ontologyHitsRaw) ? ontologyHitsRaw : [];
    const ontologyPreferred = pickFirstTrimmedFn(
      ...ontologyHits
        .map((row) => (row && typeof row === 'object' ? row.matched_text : ''))
        .filter((value) => normalizeIngredientLookupToken(value)),
    );
    if (ontologyPreferred) return String(ontologyPreferred).slice(0, 120);

    const normalized = String(entityMatch.entity_key || '').trim();
    const normalizedQuery = mapIngredientLookupTokenToQuery(normalized, lang);
    if (normalizedQuery) return String(normalizedQuery).slice(0, 120);

    const ontologyAny = pickFirstTrimmedFn(
      ...ontologyHits
        .map((row) => (row && typeof row === 'object' ? row.matched_text : ''))
        .filter(Boolean),
    );
    if (ontologyAny) return String(ontologyAny).slice(0, 120);

    if (looksLikeFreeTextIngredientName(raw)) return raw.slice(0, 120);
    return '';
  }

  function normalizeIngredientResearchKey(raw) {
    return ingredient_query_normalize(raw)
      .replace(/[^a-z0-9\u4e00-\u9fff+\s']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function __setGetBestIngredientReferenceMatchForTest(fn) {
    getBestIngredientReferenceMatchImpl = typeof fn === 'function' ? fn : getBestIngredientReferenceMatch;
  }

  function __resetGetBestIngredientReferenceMatchForTest() {
    getBestIngredientReferenceMatchImpl = getBestIngredientReferenceMatch;
  }

  function __setGetBestIngredientSignalMatchForTest(fn) {
    getBestIngredientSignalMatchImpl = typeof fn === 'function' ? fn : getBestIngredientSignalMatch;
  }

  function __resetGetBestIngredientSignalMatchForTest() {
    getBestIngredientSignalMatchImpl = getBestIngredientSignalMatch;
  }

  return {
    INGREDIENT_ENTITY_DICT,
    ingredient_query_normalize,
    ingredientEntityMatchFromText,
    normalizeIngredientLookupToken,
    resolveIngredientReferenceRuntimeMatch,
    resolveIngredientSignalRuntimeMatch,
    shouldPreferSignalRuntimeMatch,
    extractIngredientLookupTargetFromText,
    normalizeIngredientResearchKey,
    buildIngredientReferenceAliases,
    buildIngredientReferenceCategory,
    buildIngredientReferenceFallback,
    buildIngredientSignalAliases,
    buildIngredientSignalFallback,
    __setGetBestIngredientReferenceMatchForTest,
    __resetGetBestIngredientReferenceMatchForTest,
    __setGetBestIngredientSignalMatchForTest,
    __resetGetBestIngredientSignalMatchForTest,
  };
}

module.exports = {
  createIngredientLookupSupportRuntime,
};
