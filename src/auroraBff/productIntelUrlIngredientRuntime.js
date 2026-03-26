function createProductIntelUrlIngredientRuntime(options = {}) {
  const {
    PRODUCT_URL_INGREDIENT_ANALYSIS_TIMEOUT_MS = 0,
    PRODUCT_INTEL_INCIDECODER_ENABLED = false,
    PRODUCT_INTEL_INCIDECODER_TIMEOUT_MS = 0,
    PRODUCT_INTEL_RETAIL_FALLBACK_ENABLED = false,
    PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT = 2,
    AURORA_BFF_RECO_BLOCKS_BUDGET_MS = 0,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES = 6,
    fetchProductHtmlWithFallback = async () => ({ ok: false, html: '' }),
    extractInciListFromHtml = () => [],
    extractKeyIngredientsFromHtml = () => [],
    fetchDailyMedRegulatorySupplement = async () => null,
    fetchIncidecoderIngredientSupplement = async () => null,
    fetchRetailIngredientSupplement = async () => null,
    buildIngredientConsensus = () => ({ merged: [], stats: {}, confidence_tier: 'none', has_conflict: false }),
    canonicalizeIngredientCandidates = () => [],
    buildInciStatus = () => null,
    deriveKeyIngredientsForAnalysis = () => [],
    normalizeInciIngredientName = (value) => String(value || '').trim(),
    deriveIngredientMechanisms = () => [],
    deriveIngredientRiskNotes = () => [],
    extractRealtimeSocialSignalsFromHtml = () => ({
      has_signal: false,
      platform_scores: {},
      typical_positive: [],
      typical_negative: [],
      risk_for_groups: [],
      notes: [],
    }),
    uniqCaseInsensitiveStrings = (items = [], max = 80) => {
      const seen = new Set();
      const out = [];
      for (const raw of Array.isArray(items) ? items : []) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    extractPageTitleFromHtml = () => '',
    extractProductPriceFromHtml = () => null,
    pickFirstTrimmed = (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    joinBrandAndName = (...values) => values.map((value) => String(value || '').trim()).filter(Boolean).join(' '),
    extractConcentrationSignals = () => [],
    selectAssessmentSummary = ({ summary = '', reasons = [], fallbacks = [] } = {}) => {
      return String(summary || '').trim() || reasons.find((item) => String(item || '').trim()) || fallbacks.find((item) => String(item || '').trim()) || '';
    },
    normalizePriceObject = () => null,
    initCandidateFilterStats = () => ({
      competitors_dropped_non_skincare: 0,
      related_dropped_non_skincare: 0,
      dupes_dropped_non_skincare: 0,
    }),
    runRecoBlocksForUrl = async () => null,
    sanitizeCompetitorCandidates = (items) => (Array.isArray(items) ? items : []),
    collectRouterReasonCodeTokens = () => [],
    summarizeRouterReasonCodes = () => [],
    buildRealtimeCompetitorCandidates = async () => ({ candidates: [] }),
    buildOnPageCompetitorCandidates = () => [],
    routeCompetitorCandidatePools = () => ({ compPool: [], relPool: [], dupePool: [], routed: null }),
    hasCandidateFilterDropStats = () => false,
    inferRecoPriceBand = (value) => String(value || '').trim(),
    buildProfileSkinTags = () => [],
    buildCompetitorSnapshotKey = () => '',
    writeCompetitorSnapshot = () => {},
    normalizeProductAnalysis = (value) => ({ payload: value, field_missing: [] }),
    getProductAnalysisInternalMissingCodes = () => [],
    reconcileProductAnalysisConsistency = (value) => value,
    applyProductAnalysisGapContract = (value) => value,
  } = options;

  async function buildProductAnalysisFromUrlIngredients({
    productUrl,
    lang = 'EN',
    profileSummary = null,
    parsedProduct = null,
    logger,
  } = {}) {
    const urlText = String(productUrl || '').trim();
    if (!/^https?:\/\//i.test(urlText)) return null;

    let parsedUrl = null;
    try {
      parsedUrl = new URL(urlText);
    } catch {
      return null;
    }

    const parsedProductObj = parsedProduct && typeof parsedProduct === 'object' && !Array.isArray(parsedProduct) ? parsedProduct : null;
    const fetchOut = await fetchProductHtmlWithFallback({
      productUrl: parsedUrl.toString(),
      timeoutMs: PRODUCT_URL_INGREDIENT_ANALYSIS_TIMEOUT_MS,
      allowHostVariant: true,
      logger,
    });
    if (!fetchOut.ok) {
      logger?.warn?.(
        {
          url: parsedUrl.toString(),
          failure_code: fetchOut.failure_code,
          attempts: fetchOut.attempts,
        },
        'aurora bff: product URL ingredient extraction failed',
      );
    }
    const html = fetchOut.ok ? String(fetchOut.html || '') : '';
    const urlFetchRecoveredWithFallback =
      fetchOut.ok === true &&
      String(fetchOut.final_strategy || '').trim().toLowerCase() &&
      String(fetchOut.final_strategy || '').trim().toLowerCase() !== 'axios_default';
    const urlFetchFailureCode = String(fetchOut?.failure_code || '').trim().toLowerCase();
    const urlFetchChallengeBlocked =
      urlFetchFailureCode === 'url_fetch_challenge_cloudflare' || urlFetchFailureCode === 'url_fetch_access_denied';

    const inciList = extractInciListFromHtml(html);
    const keyHints = extractKeyIngredientsFromHtml(html);

    let regulatorySupplement = null;
    let incidecoderSupplement = null;
    let retailSupplement = null;
    if (!html || !inciList.length) {
      try {
        regulatorySupplement = await fetchDailyMedRegulatorySupplement({
          parsedProduct: parsedProductObj,
          productUrl: parsedUrl.toString(),
          lang,
          logger,
        });
      } catch (err) {
        logger?.warn?.(
          {
            url: parsedUrl.toString(),
            err: err?.message || String(err),
          },
          'aurora bff: regulatory supplement lookup failed',
        );
        regulatorySupplement = null;
      }
    }

    if (PRODUCT_INTEL_INCIDECODER_ENABLED && (!html || !inciList.length)) {
      try {
        incidecoderSupplement = await fetchIncidecoderIngredientSupplement({
          parsedProduct: parsedProductObj,
          productUrl: parsedUrl.toString(),
          timeoutMs: PRODUCT_INTEL_INCIDECODER_TIMEOUT_MS,
          logger,
        });
      } catch (err) {
        logger?.warn?.(
          {
            url: parsedUrl.toString(),
            err: err?.message || String(err),
          },
          'aurora bff: inci decoder supplement lookup failed',
        );
        incidecoderSupplement = {
          ok: false,
          query: '',
          reason: 'incidecoder_fetch_failed',
        };
      }
    }
    if (PRODUCT_INTEL_RETAIL_FALLBACK_ENABLED && (!html || !inciList.length)) {
      try {
        retailSupplement = await fetchRetailIngredientSupplement({
          parsedProduct: parsedProductObj,
          productUrl: parsedUrl.toString(),
          timeoutMs: Math.max(2200, Math.min(8000, PRODUCT_URL_INGREDIENT_ANALYSIS_TIMEOUT_MS + 2800)),
          logger,
        });
      } catch (err) {
        logger?.warn?.(
          {
            url: parsedUrl.toString(),
            err: err?.message || String(err),
          },
          'aurora bff: retail supplement lookup failed',
        );
        retailSupplement = {
          ok: false,
          query: '',
          reason: 'retail_source_no_match',
        };
      }
    }

    const regulatoryActiveInci =
      regulatorySupplement && regulatorySupplement.ok && Array.isArray(regulatorySupplement.active_ingredients)
        ? regulatorySupplement.active_ingredients
        : [];
    const retailInci =
      retailSupplement && retailSupplement.ok && Array.isArray(retailSupplement.ingredients)
        ? retailSupplement.ingredients
        : [];
    const incidecoderInci =
      incidecoderSupplement && incidecoderSupplement.ok && Array.isArray(incidecoderSupplement.ingredients)
        ? incidecoderSupplement.ingredients
        : [];
    const ingredientConsensus = buildIngredientConsensus({
      official: inciList,
      regulatory: regulatoryActiveInci,
      retail: retailInci,
      inciDecoder: incidecoderInci,
    });
    const normalizedInci = ingredientConsensus.merged;
    const officialInciNormalized = canonicalizeIngredientCandidates([...inciList, ...regulatoryActiveInci], { max: 140 });
    const incidecoderOverlapCount = Number(ingredientConsensus?.stats?.overlap_inci_official || 0);
    const ingredientConfidenceTier = String(ingredientConsensus?.confidence_tier || 'none').toLowerCase();
    const inciStatusGapCodes = [
      ...(!html && !fetchOut.ok ? ['on_page_fetch_blocked'] : []),
      ...(regulatorySupplement && regulatorySupplement.ok ? ['regulatory_source_used'] : []),
      ...(retailSupplement && retailSupplement.ok ? ['retail_source_used'] : []),
      ...(incidecoderSupplement && incidecoderSupplement.ok ? ['incidecoder_source_used'] : []),
      ...(!normalizedInci.length ? ['evidence_missing'] : []),
    ];
    const inciStatusSources = [
      ...(html
        ? [{
          type: 'official_page',
          url: parsedUrl.toString(),
          confidence: 0.78,
          ingredient_count: canonicalizeIngredientCandidates(inciList, { max: 260 }).length,
        }]
        : []),
      ...(regulatorySupplement && regulatorySupplement.ok
        ? [{
          type: 'regulatory',
          url: String(regulatorySupplement.source?.url || regulatorySupplement.source_url || ''),
          confidence: 0.72,
          ingredient_count: canonicalizeIngredientCandidates(regulatoryActiveInci, { max: 220 }).length,
        }]
        : []),
      ...(retailSupplement && retailSupplement.ok
        ? [{
          type: 'retail_page',
          url: String(retailSupplement.source?.url || retailSupplement.source_url || ''),
          confidence: Number(retailSupplement.source?.confidence || 0.58),
          ingredient_count: canonicalizeIngredientCandidates(retailInci, { max: 220 }).length,
        }]
        : []),
      ...(incidecoderSupplement && incidecoderSupplement.ok
        ? [{
          type: 'inci_decoder',
          url: String(incidecoderSupplement.source?.url || incidecoderSupplement.source_url || ''),
          confidence: Number(incidecoderSupplement.source?.confidence || 0.55),
          ingredient_count: canonicalizeIngredientCandidates(incidecoderInci, { max: 220 }).length,
        }]
        : []),
    ];
    const inciStatus = buildInciStatus({
      gapCodes: inciStatusGapCodes,
      consensusResult: ingredientConsensus,
      sources: inciStatusSources,
    });
    const keyIngredients = deriveKeyIngredientsForAnalysis(
      normalizedInci,
      keyHints.map((item) => normalizeInciIngredientName(item)),
    );
    const mechanisms = deriveIngredientMechanisms(keyIngredients, lang);
    const riskNotes = uniqCaseInsensitiveStrings(
      [
        ...deriveIngredientRiskNotes(normalizedInci, profileSummary || {}, lang, inciStatus),
        ...(regulatorySupplement && regulatorySupplement.ok && Array.isArray(regulatorySupplement.risk_notes)
          ? regulatorySupplement.risk_notes
          : []),
      ],
      6,
    );
    const socialSignals = html
      ? extractRealtimeSocialSignalsFromHtml(html, { lang, riskNotes })
      : {
        has_signal: false,
        platform_scores: {},
        typical_positive: [],
        typical_negative: [],
        risk_for_groups: [],
        notes: [],
      };

    const isCn = String(lang || '').toUpperCase() === 'CN';
    const skinType = String(profileSummary?.skinType || '').trim().toLowerCase();
    const sensitivity = String(profileSummary?.sensitivity || '').trim().toLowerCase();
    const barrier = String(profileSummary?.barrierStatus || '').trim().toLowerCase();
    const highSensitivity = sensitivity === 'high' || barrier === 'impaired';
    const mediumSensitivity = sensitivity === 'medium';
    const lowerInci = normalizedInci.join(' | ').toLowerCase();
    const hasAcidLike = /\b(aha|bha|pha|glycolic|lactic|mandelic|salicylic|retinol|retinal|adapalene|tretinoin)\b/.test(lowerInci);
    const hasFragranceLike = /\b(fragrance|parfum|linalool|limonene|citral|geraniol)\b/.test(lowerInci);
    const hasCommonSunscreenIrritants = /\b(oxybenzone|octocrylene)\b/.test(lowerInci);
    const hasAnyIngredientSignals = normalizedInci.length > 0 || keyIngredients.length > 0;

    const verdict =
      !hasAnyIngredientSignals
        ? isCn
          ? '未知'
          : 'Unknown'
        : highSensitivity && (hasAcidLike || hasFragranceLike || hasCommonSunscreenIrritants)
        ? isCn
          ? '谨慎'
          : 'Caution'
        : mediumSensitivity && (hasAcidLike || hasCommonSunscreenIrritants)
          ? isCn
            ? '谨慎'
            : 'Caution'
          : isCn
            ? '较适配'
            : 'Likely Suitable';

    const fitNotes = uniqCaseInsensitiveStrings([
      skinType === 'oily'
        ? (isCn ? '油皮场景通常更关注控油与不闷闭口。' : 'Oily-skin context generally prioritizes oil control and low-clog load.')
        : '',
      skinType === 'dry'
        ? (isCn ? '干皮场景通常更关注保湿与屏障支持。' : 'Dry-skin context generally prioritizes hydration and barrier support.')
        : '',
      (sensitivity === 'medium' || sensitivity === 'high' || barrier === 'impaired') && (hasAcidLike || hasFragranceLike || hasCommonSunscreenIrritants)
        ? (isCn ? '敏感/屏障不稳时建议低频起步并减少同晚叠加强活性。' : 'For sensitive or impaired-barrier days, start low-frequency and avoid same-night stacking of strong actives.')
        : '',
      ingredientConfidenceTier === 'low' || ingredientConfidenceTier === 'none'
        ? (isCn ? '成分证据一致度偏低，建议继续核对包装 INCI。' : 'Ingredient-source consistency is limited; cross-check with package INCI.')
        : '',
    ], 4);

    const hostName = String(parsedUrl.hostname || '').replace(/^www\./i, '');
    const pageTitle = extractPageTitleFromHtml(html);
    const extractedPrice = extractProductPriceFromHtml(html);
    const anchorBrand = pickFirstTrimmed(
      parsedProductObj?.brand,
      pageTitle.includes('|') ? pageTitle.split('|').slice(-1)[0] : '',
    );
    const anchorName = pickFirstTrimmed(
      parsedProductObj?.name,
      pageTitle.includes('|') ? pageTitle.split('|')[0] : pageTitle,
      parsedProductObj?.display_name,
    );
    const anchorDisplayName = pickFirstTrimmed(
      parsedProductObj?.display_name,
      joinBrandAndName(anchorBrand, anchorName),
      anchorName,
    );
    const concentrationSignals = extractConcentrationSignals({
      pageTitle,
      anchorName,
      anchorDisplayName,
      keyIngredients,
    });
    const reasons = uniqCaseInsensitiveStrings(
      [
        html && inciList.length
          ? isCn
            ? `已从产品页解析到 INCI 成分表（共 ${normalizedInci.length} 项），用于本次评估。`
            : `I extracted the INCI list directly from the product page (${normalizedInci.length} entries) for this assessment.`
          : regulatorySupplement && regulatorySupplement.ok
            ? isCn
              ? `官网成分抓取受限，已改用监管源（DailyMed）补充活性信息（${regulatoryActiveInci.length} 项）。`
              : `Official-page INCI extraction was blocked; a regulatory source (DailyMed) was used as backup (${regulatoryActiveInci.length} active entries).`
            : retailSupplement && retailSupplement.ok
              ? isCn
                ? `官网成分抓取受限，已改用主流零售页补充成分线索（${retailInci.length} 项，需与包装 INCI 复核）。`
                : `Official-page INCI extraction was blocked; a retail PDP was used as supplemental evidence (${retailInci.length} entries, package INCI cross-check required).`
            : incidecoderSupplement && incidecoderSupplement.ok
              ? isCn
                ? `官网成分抓取受限，已改用 INCIDecoder 补充成分线索（${incidecoderInci.length} 项，需与包装 INCI 复核）。`
                : `Official-page INCI extraction was blocked; INCIDecoder was used as a supplemental source (${incidecoderInci.length} entries, package INCI cross-check required).`
            : isCn
              ? '当前未能稳定抓取到官网 INCI 成分表，证据有限。'
              : 'The official product page could not be parsed reliably, so evidence is currently limited.',
        keyIngredients.length
          ? isCn
            ? `识别到的关键成分：${keyIngredients.slice(0, 5).join('、')}。`
            : `Detected key ingredients: ${keyIngredients.slice(0, 5).join(', ')}.`
          : '',
        riskNotes.length ? riskNotes[0] : '',
        socialSignals.typical_positive.length
          ? isCn
            ? `页面舆情信号偏正向：${socialSignals.typical_positive.slice(0, 2).join('、')}。`
            : `On-page sentiment leans positive: ${socialSignals.typical_positive.slice(0, 2).join(', ')}.`
          : '',
        concentrationSignals.length
          ? isCn
            ? `页面已识别浓度信号：${concentrationSignals.slice(0, 2).join('、')}（仅作参考）。`
            : `Detected concentration signal on page: ${concentrationSignals.slice(0, 2).join(', ')} (reference only).`
          : isCn
            ? '边界说明：成分浓度与批次差异不可见，建议先做局部测试并从低频开始。'
            : 'Boundary: concentration and batch variance are unknown; patch test first and start at low frequency.',
        !html && !regulatorySupplement?.ok && !retailSupplement?.ok
          ? isCn
            ? urlFetchChallengeBlocked
              ? '目标站点启用了反爬挑战页。请上传包装 INCI 图、粘贴成分表，或提供可访问的零售 PDP 链接后重试。'
              : '请粘贴包装上的完整 INCI，或换一个可公开访问的官方商品页链接后重试。'
            : urlFetchChallengeBlocked
              ? 'The target site is blocked by anti-bot challenge. Upload package INCI, paste ingredients, or share an accessible retail PDP URL to retry.'
              : 'Please paste the full INCI from your package or share another publicly accessible official page URL and retry.'
          : '',
        regulatorySupplement && regulatorySupplement.ok
          ? isCn
            ? '监管源可用，但不同地区/批次配方可能不同；建议继续核对实物包装。'
            : 'Regulatory evidence is available, but market/batch formulas can differ; verify against your actual package.'
          : '',
        retailSupplement && retailSupplement.ok
          ? isCn
            ? '零售页成分仅作补充证据，请继续以官方/监管信息与实物包装 INCI 交叉验证。'
            : 'Retail PDP ingredients are supplemental evidence only; cross-check with official/regulatory info and package INCI.'
          : '',
        incidecoderSupplement && incidecoderSupplement.ok
          ? isCn
            ? 'INCIDecoder 为补充证据源，不作为单一权威来源；建议与官方/监管信息交叉验证。'
            : 'INCIDecoder is a supplemental source and should be cross-validated with official/regulatory evidence.'
          : '',
      ],
      6,
    );
    const parsedPrice = normalizePriceObject(
      parsedProductObj?.price ??
        parsedProductObj?.price_amount ??
        parsedProductObj?.priceAmount ??
        parsedProductObj?.offer_price ??
        parsedProductObj?.price_usd ??
        parsedProductObj?.priceUsd ??
        parsedProductObj?.price_cny ??
        parsedProductObj?.priceCny,
    );
    const anchorPrice = (() => {
      const nowIso = new Date().toISOString();
      if (parsedPrice) {
        return {
          ...parsedPrice,
          source: 'parsed_anchor_price',
          captured_at: nowIso,
        };
      }
      const extractedNormalized = normalizePriceObject(extractedPrice);
      if (!extractedNormalized) return null;
      const sourceToken = pickFirstTrimmed(extractedPrice?.source, 'page_price_signal');
      return {
        ...extractedNormalized,
        ...(sourceToken ? { source: sourceToken } : {}),
        captured_at: nowIso,
      };
    })();
    const anchorProduct = {
      ...(parsedProductObj?.product_id ? { product_id: String(parsedProductObj.product_id).trim() } : {}),
      ...(parsedProductObj?.sku_id ? { sku_id: String(parsedProductObj.sku_id).trim() } : {}),
      ...(anchorBrand ? { brand: anchorBrand } : {}),
      ...(anchorName ? { name: anchorName } : {}),
      ...(anchorDisplayName ? { display_name: anchorDisplayName } : {}),
      ...(anchorPrice ? { price: anchorPrice } : {}),
      url: parsedUrl.toString(),
    };

    let competitorOut = { candidates: [], queries: [], reason: 'dag_not_used' };
    let competitorSource = 'catalog';
    let competitorReason = null;
    let routedPools = { compPool: [], relPool: [], dupePool: [], routed: { internal_reason_codes: [] } };
    let dagDiagnostics = null;
    let dagReasonCodes = [];
    let dagConfidencePatch = null;
    let dagProvenancePatch = null;
    let dagTracking = null;
    let competitorSnapshotMeta = null;
    let candidateFilterStats = initCandidateFilterStats();
    const htmlForReco = html || (!fetchOut.ok ? '<!--on_page_fetch_blocked-->' : '');

    const dagOut = await runRecoBlocksForUrl({
      productUrl: parsedUrl.toString(),
      anchorProduct,
      parsedProduct: parsedProductObj,
      keyIngredients,
      profileSummary,
      lang,
      mode: 'main_path',
      logger,
      html: htmlForReco,
      budgetMs: AURORA_BFF_RECO_BLOCKS_BUDGET_MS,
      maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    });

    if (dagOut && typeof dagOut === 'object') {
      const dagFilterStats = initCandidateFilterStats();
      const compPool = sanitizeCompetitorCandidates(
        dagOut?.competitors?.candidates,
        PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        {
          enforceSkincare: true,
          pool: 'competitors',
          stats: dagFilterStats,
        },
      );
      const relPool = sanitizeCompetitorCandidates(
        dagOut?.related_products?.candidates,
        PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        {
          enforceSkincare: true,
          pool: 'related_products',
          stats: dagFilterStats,
        },
      );
      const dupePool = sanitizeCompetitorCandidates(
        dagOut?.dupes?.candidates,
        PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        {
          enforceSkincare: true,
          pool: 'dupes',
          stats: dagFilterStats,
        },
      );
      candidateFilterStats = dagFilterStats;
      routedPools = {
        compPool,
        relPool,
        dupePool,
        routed: {
          internal_reason_codes: Array.isArray(dagOut.internal_reason_codes) ? dagOut.internal_reason_codes : [],
        },
        routeReasonCodesRaw: collectRouterReasonCodeTokens({
          internal_reason_codes: Array.isArray(dagOut.internal_reason_codes) ? dagOut.internal_reason_codes : [],
        }),
        candidateFilterStats: dagFilterStats,
      };
      competitorOut = {
        candidates: compPool,
        queries: Array.isArray(dagOut.catalog_queries) ? dagOut.catalog_queries : [],
        reason: null,
      };
      dagDiagnostics = dagOut.diagnostics || null;
      dagConfidencePatch =
        dagOut.confidence_patch && typeof dagOut.confidence_patch === 'object' && !Array.isArray(dagOut.confidence_patch)
          ? dagOut.confidence_patch
          : null;
      dagProvenancePatch =
        dagOut.provenance_patch && typeof dagOut.provenance_patch === 'object' && !Array.isArray(dagOut.provenance_patch)
          ? dagOut.provenance_patch
          : null;
      dagTracking =
        dagOut.tracking && typeof dagOut.tracking === 'object' && !Array.isArray(dagOut.tracking)
          ? dagOut.tracking
          : null;
      competitorSnapshotMeta =
        dagOut.snapshot_meta && typeof dagOut.snapshot_meta === 'object' && !Array.isArray(dagOut.snapshot_meta)
          ? dagOut.snapshot_meta
          : null;
      competitorSource = 'reco_blocks_dag';
      if (competitorSnapshotMeta && compPool.length) {
        competitorSource = 'snapshot';
      }
      dagReasonCodes = summarizeRouterReasonCodes(routedPools.routed);
      if (!compPool.length) {
        const fallbackUsed = Array.isArray(dagDiagnostics?.fallbacks_used) ? dagDiagnostics.fallbacks_used : [];
        const timedOut = Array.isArray(dagDiagnostics?.timed_out_blocks) ? dagDiagnostics.timed_out_blocks : [];
        const onPageReasonCounts =
          dagDiagnostics &&
          dagDiagnostics.blocks &&
          dagDiagnostics.blocks.on_page_related &&
          typeof dagDiagnostics.blocks.on_page_related === 'object' &&
          dagDiagnostics.blocks.on_page_related.reason_counts &&
          typeof dagDiagnostics.blocks.on_page_related.reason_counts === 'object'
            ? dagDiagnostics.blocks.on_page_related.reason_counts
            : {};
        const onPageFetchBlockedObserved =
          Number(onPageReasonCounts.on_page_fetch_blocked || 0) > 0 || (!html && !fetchOut.ok);
        if (fallbackUsed.includes('related_on_page_fallback') && relPool.length) {
          competitorSource = 'on_page_related_only';
        }
        if (onPageFetchBlockedObserved) {
          competitorReason = 'on_page_fetch_blocked';
        } else {
          competitorReason =
            timedOut.length || fallbackUsed.length
              ? 'dag_timeout_or_empty'
              : 'dag_empty';
        }
      }
    } else {
      competitorOut = await buildRealtimeCompetitorCandidates({
        productUrl: parsedUrl.toString(),
        parsedProduct: parsedProductObj,
        keyIngredients,
        anchorProduct,
        profileSummary,
        lang,
        logger,
      });
      const recalledCandidates = sanitizeCompetitorCandidates(
        competitorOut?.candidates,
        PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        { enforceSkincare: true, pool: 'competitors', stats: candidateFilterStats },
      );
      let onPageCandidates = [];
      competitorSource = 'catalog';
      competitorReason = competitorOut?.reason ? String(competitorOut.reason) : null;
      if (!recalledCandidates.length) {
        onPageCandidates = buildOnPageCompetitorCandidates({
          html,
          productUrl: parsedUrl.toString(),
          anchorProduct,
          profileSummary,
          lang,
          maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        });
      }
      routedPools = routeCompetitorCandidatePools({
        anchorProduct,
        candidates: [...recalledCandidates, ...onPageCandidates],
        maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
      });
      candidateFilterStats = initCandidateFilterStats(routedPools?.candidateFilterStats);
      if (!routedPools.compPool.length) {
        if (onPageCandidates.length || routedPools.relPool.length) {
          competitorSource = 'on_page_related_only';
          competitorReason = competitorReason || 'hard_gate_filtered';
        } else if (recalledCandidates.length) {
          competitorReason = competitorReason || 'hard_gate_filtered';
        }
      }
      if (!html && !fetchOut.ok && !competitorReason) {
        competitorReason = 'on_page_fetch_blocked';
      }
    }
    const competitorCandidates = routedPools.compPool;
    const relatedCandidates = routedPools.relPool;
    const dupeCandidates = routedPools.dupePool;
    const relatedSemanticsReclassified = relatedCandidates.some((candidate) => {
      const raw = String(candidate?.recommendation_intent ?? candidate?.recommendationIntent ?? '').trim().toLowerCase();
      return raw !== 'replace' && raw !== 'pair';
    });
    const routeReasonCodesRaw = Array.isArray(routedPools?.routeReasonCodesRaw)
      ? routedPools.routeReasonCodesRaw
      : collectRouterReasonCodeTokens(routedPools?.routed);
    const hasCategoryUnknownBlocked = routeReasonCodesRaw.some(
      (code) => String(code || '').trim().toLowerCase() === 'competitor_category_unknown_blocked',
    );
    const hasDroppedNonSkincare = hasCandidateFilterDropStats(candidateFilterStats);
    const urlSkincareSignalStrong = /\b(skincare|moisturizer|moisturiser|serum|cream|lotion|cleanser|toner|essence|sunscreen|spf|face)\b/i
      .test(`${parsedUrl.hostname} ${parsedUrl.pathname}`);
    if (hasDroppedNonSkincare && urlSkincareSignalStrong) {
      logger?.warn?.(
        {
          url: parsedUrl.toString(),
          dropped_stats: candidateFilterStats,
        },
        'aurora bff: competitor category drift filtered for skincare URL',
      );
    }
    const competitorMissing = !competitorCandidates.length;
    const socialMissing = !socialSignals.has_signal;

    let confidence = Number(
      Math.max(
        0.28,
        Math.min(
          0.84,
          0.42 +
            (normalizedInci.length >= 15 ? 0.12 : 0.04) +
            (keyIngredients.length >= 4 ? 0.1 : 0.04) +
            (riskNotes.length ? 0.04 : 0) +
            (!html ? -0.1 : 0) +
            (regulatorySupplement && regulatorySupplement.ok ? 0.05 : 0) +
            (retailSupplement && retailSupplement.ok ? 0.03 : 0) +
            (socialMissing ? 0 : 0.05) +
            (competitorMissing ? 0 : 0.05),
        ),
      ).toFixed(3),
    );
    const hasAuthoritativeSource = Boolean(html || (regulatorySupplement && regulatorySupplement.ok));
    if (!hasAuthoritativeSource && retailSupplement && retailSupplement.ok && incidecoderSupplement && incidecoderSupplement.ok) {
      confidence = Number(Math.min(confidence, 0.62).toFixed(3));
    }

    const dagFallbacksUsed = Array.isArray(dagDiagnostics?.fallbacks_used) ? dagDiagnostics.fallbacks_used : [];
    const dagTimedOutBlocks = Array.isArray(dagDiagnostics?.timed_out_blocks) ? dagDiagnostics.timed_out_blocks : [];
    const routeReasonCodes = dagReasonCodes.length ? dagReasonCodes : summarizeRouterReasonCodes(routedPools.routed);
    const catalogAnnStats =
      dagProvenancePatch &&
      typeof dagProvenancePatch === 'object' &&
      !Array.isArray(dagProvenancePatch) &&
      dagProvenancePatch.block_stats &&
      typeof dagProvenancePatch.block_stats === 'object' &&
      !Array.isArray(dagProvenancePatch.block_stats) &&
      dagProvenancePatch.block_stats.catalog_ann &&
      typeof dagProvenancePatch.block_stats.catalog_ann === 'object' &&
      !Array.isArray(dagProvenancePatch.block_stats.catalog_ann)
        ? dagProvenancePatch.block_stats.catalog_ann
        : {};
    const catalogAnnReasonCounts =
      catalogAnnStats.reason_counts &&
      typeof catalogAnnStats.reason_counts === 'object' &&
      !Array.isArray(catalogAnnStats.reason_counts)
        ? catalogAnnStats.reason_counts
        : {};
    const catalogAnnTransientFailureCount =
      Number(catalogAnnStats.transient_failure_count || 0) ||
      Number(catalogAnnReasonCounts.upstream_timeout || 0) +
        Number(catalogAnnReasonCounts.upstream_error || 0) +
        Number(catalogAnnReasonCounts.rate_limited || 0);
    const catalogSourceTemporarilyDeprioritized = catalogAnnStats.source_temporarily_deprioritized === true;
    const resolverFirstSkippedForAurora = catalogAnnStats.resolver_first_skipped_for_aurora === true;
    const retrievalAttemptedSources = uniqCaseInsensitiveStrings(
      Array.isArray(catalogAnnStats.attempted_sources) ? catalogAnnStats.attempted_sources : [],
      8,
    );
    const retrievalBudgetProfile =
      catalogAnnStats.budget_profile &&
      typeof catalogAnnStats.budget_profile === 'object' &&
      !Array.isArray(catalogAnnStats.budget_profile)
        ? catalogAnnStats.budget_profile
        : null;
    const competitorRecallTransientDegraded =
      catalogAnnTransientFailureCount > 0 &&
      competitorSource === 'on_page_related_only' &&
      relatedCandidates.length > 0 &&
      competitorCandidates.length === 0;
    const retrievalDegradation = {
      transient_failure_count: Math.max(0, Math.trunc(Number(catalogAnnTransientFailureCount) || 0)),
      attempted_sources: retrievalAttemptedSources,
      resolver_first_applied: catalogAnnStats.resolver_first_applied === true,
      resolver_first_skipped_for_aurora: resolverFirstSkippedForAurora,
      source_temporarily_deprioritized: catalogSourceTemporarilyDeprioritized,
      ...(retrievalBudgetProfile ? { budget_profile: retrievalBudgetProfile } : {}),
      degraded:
        catalogAnnTransientFailureCount > 0 ||
        competitorSource === 'on_page_related_only' ||
        dagTimedOutBlocks.includes('catalog_ann'),
    };

    const evidenceMissingInfo = [];
    if (!html && !fetchOut.ok && fetchOut.failure_code) evidenceMissingInfo.push(String(fetchOut.failure_code));
    if (!html && !fetchOut.ok) evidenceMissingInfo.push('on_page_fetch_blocked');
    if (urlFetchRecoveredWithFallback) evidenceMissingInfo.push('url_fetch_recovered_with_fallback');
    if (fetchOut?.used_unblock_vendor) evidenceMissingInfo.push('url_fetch_vendor_unblock_used');
    if (!fetchOut?.ok && fetchOut?.unblock_attempted && fetchOut?.unblock_failed) {
      evidenceMissingInfo.push('url_fetch_vendor_unblock_failed');
    }
    if (regulatorySupplement && regulatorySupplement.ok) {
      evidenceMissingInfo.push('regulatory_source_used', 'version_verification_needed');
    }
    if (retailSupplement && retailSupplement.ok) {
      evidenceMissingInfo.push('retail_source_used', 'version_verification_needed');
    } else if (retailSupplement && retailSupplement.reason) {
      const retailReason = String(retailSupplement.reason || '').trim().toLowerCase();
      if (retailReason.includes('no_match') || retailReason.includes('retail')) evidenceMissingInfo.push('retail_source_no_match');
    }
    if (incidecoderSupplement && incidecoderSupplement.ok) {
      evidenceMissingInfo.push('incidecoder_source_used', 'version_verification_needed');
    } else if (incidecoderSupplement && incidecoderSupplement.reason) {
      const reasonToken = String(incidecoderSupplement.reason || '').trim().toLowerCase();
      if (reasonToken === 'incidecoder_no_match') evidenceMissingInfo.push('incidecoder_no_match');
      else if (reasonToken.includes('fetch')) evidenceMissingInfo.push('incidecoder_fetch_failed');
    }
    if (!normalizedInci.length) evidenceMissingInfo.push('evidence_missing');
    if (ingredientConsensus.has_conflict) evidenceMissingInfo.push('ingredient_source_conflict');
    if (!concentrationSignals.length) evidenceMissingInfo.push('concentration_unknown');
    if (!anchorPrice) evidenceMissingInfo.push('price_unknown');
    if (socialMissing) evidenceMissingInfo.push('social_signals_missing');
    if (competitorMissing) evidenceMissingInfo.push('competitors_missing');
    if (!competitorMissing && competitorCandidates.length < PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT) {
      evidenceMissingInfo.push('competitors_low_coverage');
    }
    if (catalogAnnTransientFailureCount > 0) evidenceMissingInfo.push('catalog_ann_transient_failure');
    if (catalogSourceTemporarilyDeprioritized) evidenceMissingInfo.push('catalog_source_temporarily_deprioritized');
    if (resolverFirstSkippedForAurora) evidenceMissingInfo.push('resolver_first_skipped_for_aurora');
    if (competitorRecallTransientDegraded) evidenceMissingInfo.push('competitor_recall_transient_degraded');
    if (Number(candidateFilterStats.competitors_dropped_non_skincare || 0) > 0) {
      evidenceMissingInfo.push('competitors_non_skincare_filtered');
    }
    if (Number(candidateFilterStats.related_dropped_non_skincare || 0) > 0) {
      evidenceMissingInfo.push('related_products_non_skincare_filtered');
    }
    if (Number(candidateFilterStats.dupes_dropped_non_skincare || 0) > 0) {
      evidenceMissingInfo.push('dupes_non_skincare_filtered');
    }
    if (relatedSemanticsReclassified) evidenceMissingInfo.push('related_semantics_reclassified');
    if (hasCategoryUnknownBlocked) evidenceMissingInfo.push('competitor_category_unknown_blocked');
    if (competitorMissing && competitorReason) evidenceMissingInfo.push(`competitor_recall_${String(competitorReason).toLowerCase()}`);

    const defaultConfidenceByBlock = {
      competitors: {
        score: competitorMissing ? 0.18 : 0.62,
        level: competitorMissing ? 'low' : 'med',
        reasons: competitorMissing ? ['competitors_missing'] : ['competitors_available'],
      },
      related_products: {
        score: relatedCandidates.length ? 0.62 : 0.42,
        level: relatedCandidates.length ? 'med' : 'low',
        reasons: relatedCandidates.length ? ['related_products_available'] : ['related_products_sparse'],
      },
      dupes: {
        score: dupeCandidates.length ? 0.58 : 0.38,
        level: dupeCandidates.length ? 'med' : 'low',
        reasons: dupeCandidates.length ? ['dupes_available'] : ['dupes_sparse'],
      },
    };

    const evidenceSources = [];
    if (html) {
      evidenceSources.push({
        type: 'official_page',
        url: parsedUrl.toString(),
        label: hostName || 'Official page',
        confidence: 0.78,
      });
    }
    if (regulatorySupplement && regulatorySupplement.ok) {
      evidenceSources.push({
        type: 'regulatory',
        url: String(regulatorySupplement.source?.url || regulatorySupplement.source_url || ''),
        label: 'DailyMed',
        confidence: 0.72,
      });
    }
    if (retailSupplement && retailSupplement.ok) {
      evidenceSources.push({
        type: 'retail_page',
        url: String(retailSupplement.source?.url || retailSupplement.source_url || ''),
        label: String(retailSupplement.source?.label || 'Retail PDP'),
        confidence: Number(retailSupplement.source?.confidence || 0.58),
      });
    }
    if (incidecoderSupplement && incidecoderSupplement.ok) {
      evidenceSources.push({
        type: 'inci_decoder',
        url: String(incidecoderSupplement.source?.url || incidecoderSupplement.source_url || ''),
        label: 'INCIDecoder',
        confidence: Number(incidecoderSupplement.source?.confidence || 0.55),
      });
    }
    const normalizedEvidenceSources = evidenceSources
      .map((item) => ({
        type: String(item?.type || '').trim().toLowerCase(),
        url: String(item?.url || '').trim(),
        label: String(item?.label || '').trim(),
        confidence: Number(item?.confidence),
      }))
      .filter((item) => /^https?:\/\//i.test(item.url))
      .slice(0, 4);

    const urlFetchProvenance = {
      final_strategy: String(fetchOut?.final_strategy || 'none').trim() || 'none',
      attempts: (Array.isArray(fetchOut?.attempts) ? fetchOut.attempts : []).slice(0, 6).map((item) => ({
        strategy: String(item?.strategy || '').trim() || 'unknown',
        provider: String(item?.provider || 'native').trim().toLowerCase() || 'native',
        ...(Number.isFinite(Number(item?.status)) ? { status: Number(item.status) } : {}),
        ...(item?.error_code ? { error_code: String(item.error_code).trim().toLowerCase() } : {}),
        ...(item?.challenge_type ? { challenge_type: String(item.challenge_type).trim().toLowerCase() } : {}),
      })),
      ...(fetchOut?.failure_code ? { failure_code: String(fetchOut.failure_code).trim().toLowerCase() } : {}),
      ...(fetchOut?.used_unblock_vendor ? { vendor_unblock_used: true } : {}),
      ...(fetchOut?.unblock_attempted ? { vendor_unblock_attempted: true } : {}),
      ...(fetchOut?.unblock_failed ? { vendor_unblock_failed: true } : {}),
      ...(urlFetchChallengeBlocked
        ? {
          failure_detail: {
            challenge_type: urlFetchFailureCode === 'url_fetch_access_denied' ? 'access_denied_page' : 'cloudflare_challenge',
            next_step: 'provide_inci_or_accessible_retail_pdp',
          },
        }
        : {}),
    };
    const sourceChain = uniqCaseInsensitiveStrings(
      [
        html ? 'official_page' : '',
        regulatorySupplement && regulatorySupplement.ok ? 'regulatory' : '',
        retailSupplement && retailSupplement.ok ? 'retail_page' : '',
        incidecoderSupplement && incidecoderSupplement.ok ? 'inci_decoder' : '',
        'llm_extraction',
      ],
      6,
    );

  	  const raw = {
  	    assessment: {
  	      verdict,
  	      reasons,
  	      summary: selectAssessmentSummary({
  	        summary: reasons[0] || '',
  	        reasons,
  	        fallbacks: [fitNotes[0], mechanisms[0]],
  	      }),
  	      ingredient_confidence_tier: ingredientConfidenceTier,
  	      anchor_product: anchorProduct,
  	    },
      evidence: {
        science: {
          key_ingredients: keyIngredients,
          mechanisms,
          fit_notes: fitNotes,
          risk_notes: riskNotes,
        },
        social_signals: {
          ...(Object.keys(socialSignals.platform_scores || {}).length
            ? { platform_scores: socialSignals.platform_scores }
            : {}),
          typical_positive: socialSignals.typical_positive,
          typical_negative: socialSignals.typical_negative,
          risk_for_groups: socialSignals.risk_for_groups,
        },
        expert_notes: uniqCaseInsensitiveStrings(
          [
            html
              ? isCn
                ? `证据来源：${hostName || 'product page'} 官方产品页成分表抓取。`
                : `Evidence source: ingredient list parsed from ${hostName || 'product page'}.`
              : isCn
                ? '官网页面抓取受站点策略限制（403/反爬），本次走了可诊断降级。'
                : 'Official-page extraction was blocked by site policy (403/anti-bot); a diagnosable degraded path was used.',
            urlFetchRecoveredWithFallback
              ? isCn
                ? 'URL 抓取已通过回退策略恢复（默认请求失败后切换 UA）。'
                : 'URL extraction recovered via fallback strategy (alternate UA profile).'
              : '',
            fetchOut?.used_unblock_vendor
              ? isCn
                ? 'URL 抓取已使用第三方解封服务恢复（ZenRows）。'
                : 'URL extraction recovered via vendor unblock service (ZenRows).'
              : '',
            regulatorySupplement && regulatorySupplement.ok
              ? isCn
                ? `监管源补充：DailyMed 活性信息已接入（query=${regulatorySupplement.query || 'n/a'}）。`
                : `Regulatory supplement loaded from DailyMed (query=${regulatorySupplement.query || 'n/a'}).`
              : '',
            retailSupplement && retailSupplement.ok
              ? isCn
                ? `零售页补充：${String(retailSupplement.source?.label || 'Retail PDP')} 已解析 ${retailInci.length} 项成分线索（match=${Number(retailSupplement.match_score || 0).toFixed(2)}）。`
                : `Retail PDP supplement loaded from ${String(retailSupplement.source?.label || 'Retail PDP')} (${retailInci.length} ingredients, match=${Number(retailSupplement.match_score || 0).toFixed(2)}).`
              : '',
            incidecoderSupplement && incidecoderSupplement.ok
              ? isCn
                ? `INCIDecoder 补充：已解析 ${incidecoderInci.length} 项成分线索（match=${Number(incidecoderSupplement.match_score || 0).toFixed(2)}）。`
                : `INCIDecoder supplement loaded (${incidecoderInci.length} ingredients, match=${Number(incidecoderSupplement.match_score || 0).toFixed(2)}).`
              : '',
            anchorPrice
              ? isCn
                ? `页面价格信号：${anchorPrice.currency || 'USD'} ${anchorPrice.amount}（用于同类对比）`
                : `Price signal from page: ${anchorPrice.currency || 'USD'} ${anchorPrice.amount} (used for comparable matching).`
              : '',
            ...socialSignals.notes,
            competitorOut?.queries?.length
              ? isCn
                ? `竞品召回查询：${competitorOut.queries.join(' | ')}`
                : `Competitor recall queries: ${competitorOut.queries.join(' | ')}`
              : '',
            dagFallbacksUsed.length
              ? isCn
                ? `DAG 降级轨迹：${dagFallbacksUsed.join(', ')}。`
                : `DAG fallback trace: ${dagFallbacksUsed.join(', ')}.`
              : '',
            dagTimedOutBlocks.length
              ? isCn
                ? `DAG 超时分支：${dagTimedOutBlocks.join(', ')}。`
                : `DAG timed-out branches: ${dagTimedOutBlocks.join(', ')}.`
              : '',
            competitorSource === 'on_page_related_only'
              ? isCn
                ? '同页 related products 已分流到 related_products，未进入 competitors（硬约束）。'
                : 'On-page related products were routed to related_products and blocked from competitors by hard gates.'
              : '',
            !html && !regulatorySupplement?.ok && !retailSupplement?.ok
              ? isCn
                ? urlFetchChallengeBlocked
                  ? '下一步：请上传包装 INCI 图、粘贴成分表，或改用可访问的零售 PDP 链接继续。'
                  : '下一步：请贴包装 INCI 或换一个可公开访问的官方页面链接，以提升分析信息量。'
                : urlFetchChallengeBlocked
                  ? 'Next step: upload package INCI, paste ingredient list, or use an accessible retail PDP URL.'
                  : 'Next step: paste package INCI or share a publicly accessible official product page to improve evidence quality.'
              : '',
          ],
          8,
        ),
        ...(normalizedEvidenceSources.length ? { sources: normalizedEvidenceSources } : {}),
        confidence,
        missing_info: evidenceMissingInfo,
      },
      inci_status: inciStatus,
      confidence,
      confidence_by_block: dagConfidencePatch || defaultConfidenceByBlock,
      provenance: {
        source: 'url_realtime_product_intel',
        pipeline: dagProvenancePatch?.pipeline || 'url_realtime_product_intel_v1',
        validation_mode: dagProvenancePatch?.validation_mode || 'soft_fail',
        ...(dagProvenancePatch && typeof dagProvenancePatch === 'object' ? dagProvenancePatch : {}),
        url_fetch: urlFetchProvenance,
        ...(sourceChain.length ? { source_chain: sourceChain } : {}),
        ...(relatedSemanticsReclassified ? { related_semantics_reclassified: true } : {}),
        ...(ingredientConsensus && typeof ingredientConsensus === 'object'
          ? {
            ingredient_consensus: {
              confidence_tier: ingredientConfidenceTier,
              has_conflict: Boolean(ingredientConsensus.has_conflict),
              ...(ingredientConsensus.stats && typeof ingredientConsensus.stats === 'object'
                ? { stats: ingredientConsensus.stats }
                : {}),
            },
          }
          : {}),
        social_enrichment_status: 'pending_async',
        retrieval_degradation: retrievalDegradation,
        ...(hasCandidateFilterDropStats(candidateFilterStats)
          ? {
            candidate_filter_stats: {
              competitors_dropped_non_skincare: Number(candidateFilterStats.competitors_dropped_non_skincare || 0),
              related_dropped_non_skincare: Number(candidateFilterStats.related_dropped_non_skincare || 0),
              dupes_dropped_non_skincare: Number(candidateFilterStats.dupes_dropped_non_skincare || 0),
            },
          }
          : {}),
        ...(regulatorySupplement && regulatorySupplement.ok
          ? {
            regulatory_source: {
              provider: 'dailymed',
              url: String(regulatorySupplement.source_url || ''),
              query: String(regulatorySupplement.query || ''),
            },
          }
          : {}),
        ...(retailSupplement && retailSupplement.ok
          ? {
            retail_source: {
              provider: String(retailSupplement.source?.label || 'retail_pdp').trim().toLowerCase(),
              url: String(retailSupplement.source_url || ''),
              query: String(retailSupplement.query || ''),
              match_score: Number(retailSupplement.match_score || 0),
              ingredient_count: retailInci.length,
            },
          }
          : {}),
        ...(incidecoderSupplement && incidecoderSupplement.ok
          ? {
            inci_decoder: {
              provider: 'incidecoder',
              url: String(incidecoderSupplement.source_url || ''),
              query: String(incidecoderSupplement.query || ''),
              match_score: Number(incidecoderSupplement.match_score || 0),
              ingredient_count: incidecoderInci.length,
              overlap_count: incidecoderOverlapCount,
            },
          }
          : {}),
        ...(competitorSnapshotMeta
          ? {
            competitor_meta: {
              source: String(competitorSnapshotMeta.source || 'snapshot'),
              confidence: Number.isFinite(Number(competitorSnapshotMeta.confidence))
                ? Number(competitorSnapshotMeta.confidence)
                : null,
              snapshot_age_sec: Number.isFinite(Number(competitorSnapshotMeta.age_sec))
                ? Number(competitorSnapshotMeta.age_sec)
                : null,
              degraded: Boolean(competitorSnapshotMeta.degraded),
              stale: Boolean(competitorSnapshotMeta.stale),
              very_stale: Boolean(competitorSnapshotMeta.very_stale),
            },
          }
          : {}),
      },
      missing_info: uniqCaseInsensitiveStrings(
        [
          'url_ingredient_analysis_used',
          'url_realtime_product_intel_used',
          ...(fetchOut?.failure_code ? [String(fetchOut.failure_code)] : []),
          ...(!html && !fetchOut.ok ? ['on_page_fetch_blocked'] : []),
          ...(urlFetchRecoveredWithFallback ? ['url_fetch_recovered_with_fallback'] : []),
          ...(fetchOut?.used_unblock_vendor ? ['url_fetch_vendor_unblock_used'] : []),
          ...(!fetchOut?.ok && fetchOut?.unblock_attempted && fetchOut?.unblock_failed ? ['url_fetch_vendor_unblock_failed'] : []),
          ...(regulatorySupplement && regulatorySupplement.ok ? ['regulatory_source_used', 'version_verification_needed'] : []),
          ...(retailSupplement && retailSupplement.ok ? ['retail_source_used', 'version_verification_needed'] : []),
          ...(retailSupplement && !retailSupplement.ok && retailSupplement.reason ? ['retail_source_no_match'] : []),
          ...(incidecoderSupplement && incidecoderSupplement.ok ? ['incidecoder_source_used', 'version_verification_needed'] : []),
          ...(
            incidecoderSupplement && !incidecoderSupplement.ok && incidecoderSupplement.reason
              ? [String(incidecoderSupplement.reason)]
              : []
          ),
          ...(!normalizedInci.length ? ['evidence_missing'] : []),
          ...(!anchorPrice ? ['price_unknown'] : []),
          ...(socialMissing ? ['social_signals_missing'] : []),
          ...(competitorMissing ? ['competitors_missing'] : []),
          ...(!competitorMissing && competitorCandidates.length < PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT ? ['competitors_low_coverage'] : []),
          ...(catalogAnnTransientFailureCount > 0 ? ['catalog_ann_transient_failure'] : []),
          ...(catalogSourceTemporarilyDeprioritized ? ['catalog_source_temporarily_deprioritized'] : []),
          ...(resolverFirstSkippedForAurora ? ['resolver_first_skipped_for_aurora'] : []),
          ...(competitorRecallTransientDegraded ? ['competitor_recall_transient_degraded'] : []),
          ...(Number(candidateFilterStats.competitors_dropped_non_skincare || 0) > 0 ? ['competitors_non_skincare_filtered'] : []),
          ...(Number(candidateFilterStats.related_dropped_non_skincare || 0) > 0 ? ['related_products_non_skincare_filtered'] : []),
          ...(Number(candidateFilterStats.dupes_dropped_non_skincare || 0) > 0 ? ['dupes_non_skincare_filtered'] : []),
          ...(hasCategoryUnknownBlocked ? ['competitor_category_unknown_blocked'] : []),
          competitorMissing && competitorReason ? `competitor_recall_${String(competitorReason).toLowerCase()}` : '',
        ],
        12,
      ),
      ...(competitorCandidates.length ? { competitors: { candidates: competitorCandidates } } : {}),
      ...(relatedCandidates.length ? { related_products: { candidates: relatedCandidates } } : {}),
      ...(dupeCandidates.length ? { dupes: { candidates: dupeCandidates } } : {}),
      ...(dagTracking ? { candidate_tracking: dagTracking } : {}),
    };

    const competitorSnapshotKey = buildCompetitorSnapshotKey({
      anchor_product_id: pickFirstTrimmed(anchorProduct?.product_id, anchorProduct?.sku_id),
      normalized_query: pickFirstTrimmed(anchorDisplayName, anchorName),
      product_url: parsedUrl.toString(),
      locale: lang,
      surface: 'product_analysis',
      objective: 'competitors',
      category: pickFirstTrimmed(anchorProduct?.category, anchorProduct?.category_name, parsedProductObj?.category_taxonomy),
      price_band: inferRecoPriceBand(anchorProduct?.price_band, {
        price: normalizePriceObject(anchorProduct?.price)?.amount,
      }),
      skin_fit_bucket: buildProfileSkinTags(profileSummary).slice(0, 2).join('_'),
    });
    if (competitorSnapshotKey && competitorCandidates.length) {
      writeCompetitorSnapshot(
        competitorSnapshotKey,
        {
          competitors: competitorCandidates,
          related_products: relatedCandidates,
          dupes: dupeCandidates,
          competitor_queries: competitorOut?.queries || [],
        },
        {
          created_at: new Date().toISOString(),
          source: competitorSource === 'snapshot' ? 'snapshot' : 'realtime_main',
          ranker_version: String(dagProvenancePatch?.pipeline || 'reco_blocks_dag.v1'),
          coverage: {
            competitors: competitorCandidates.length,
            related_products: relatedCandidates.length,
            dupes: dupeCandidates.length,
          },
          confidence:
            dagConfidencePatch?.competitors?.score ??
            dagConfidencePatch?.competitors?.level ??
            confidence,
          reason_flags: [
            ...(competitorMissing ? ['competitors_missing'] : []),
            ...(dagTimedOutBlocks.length ? ['timed_out_blocks_present'] : []),
            ...(dagFallbacksUsed.length ? ['fallbacks_used_present'] : []),
          ],
        },
      );
    }

    const norm = normalizeProductAnalysis(raw);
    const payloadInternalCodes = Array.isArray(norm.payload?.internal_debug_codes) ? norm.payload.internal_debug_codes : [];
    const mergedInternalCodes = Array.from(
      new Set([
        ...payloadInternalCodes,
        'url_ingredient_analysis_used',
        'url_realtime_product_intel_used',
        ...(fetchOut?.failure_code ? [String(fetchOut.failure_code)] : []),
        ...(!html && !fetchOut.ok ? ['on_page_fetch_blocked'] : []),
        ...(urlFetchRecoveredWithFallback ? ['url_fetch_recovered_with_fallback'] : []),
        ...(fetchOut?.used_unblock_vendor ? ['url_fetch_vendor_unblock_used'] : []),
        ...(!fetchOut?.ok && fetchOut?.unblock_attempted && fetchOut?.unblock_failed ? ['url_fetch_vendor_unblock_failed'] : []),
        ...(regulatorySupplement && regulatorySupplement.ok ? ['regulatory_source_used', 'version_verification_needed'] : []),
        ...(retailSupplement && retailSupplement.ok ? ['retail_source_used', 'version_verification_needed'] : []),
        ...(retailSupplement && !retailSupplement.ok && retailSupplement.reason ? ['retail_source_no_match'] : []),
        ...(incidecoderSupplement && incidecoderSupplement.ok ? ['incidecoder_source_used', 'version_verification_needed'] : []),
        ...(incidecoderSupplement && !incidecoderSupplement.ok && incidecoderSupplement.reason ? [String(incidecoderSupplement.reason)] : []),
        ...(!normalizedInci.length ? ['evidence_missing'] : []),
        ...(socialMissing ? ['social_signals_missing'] : []),
        ...(competitorMissing ? ['competitors_missing'] : []),
        ...(!competitorMissing && competitorCandidates.length < PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT ? ['competitors_low_coverage'] : []),
        ...(catalogAnnTransientFailureCount > 0 ? ['catalog_ann_transient_failure'] : []),
        ...(catalogSourceTemporarilyDeprioritized ? ['catalog_source_temporarily_deprioritized'] : []),
        ...(resolverFirstSkippedForAurora ? ['resolver_first_skipped_for_aurora'] : []),
        ...(competitorRecallTransientDegraded ? ['competitor_recall_transient_degraded'] : []),
        ...(Number(candidateFilterStats.competitors_dropped_non_skincare || 0) > 0 ? ['competitors_non_skincare_filtered'] : []),
        ...(Number(candidateFilterStats.related_dropped_non_skincare || 0) > 0 ? ['related_products_non_skincare_filtered'] : []),
        ...(Number(candidateFilterStats.dupes_dropped_non_skincare || 0) > 0 ? ['dupes_non_skincare_filtered'] : []),
        ...(hasCategoryUnknownBlocked ? ['competitor_category_unknown_blocked'] : []),
        ...(competitorMissing && competitorReason ? [`competitor_recall_${String(competitorReason).toLowerCase()}`] : []),
        ...routeReasonCodes,
        ...dagFallbacksUsed.map((item) => `reco_dag_fallback_${String(item || '').trim().toLowerCase()}`),
        ...dagTimedOutBlocks.map((item) => `reco_dag_timeout_${String(item || '').trim().toLowerCase()}`),
      ]),
    );
    const nextPayload = reconcileProductAnalysisConsistency(applyProductAnalysisGapContract({
      ...(norm.payload && typeof norm.payload === 'object' ? norm.payload : {}),
      ...(
        raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence)
          ? {
            evidence: {
              ...(norm.payload && typeof norm.payload.evidence === 'object' && !Array.isArray(norm.payload.evidence)
                ? norm.payload.evidence
                : {}),
              ...(raw.evidence.sources ? { sources: raw.evidence.sources } : {}),
            },
          }
          : {}
      ),
      ...(raw.confidence_by_block ? { confidence_by_block: raw.confidence_by_block } : {}),
      ...(raw.provenance ? { provenance: raw.provenance } : {}),
      internal_debug_codes: mergedInternalCodes,
    }), { lang });
    const nextFieldMissing = Array.isArray(norm.field_missing) ? norm.field_missing.filter((item) => {
      const field = String(item?.field || '').trim();
      return field !== 'assessment' && field !== 'evidence';
    }) : [];
    return {
      payload: nextPayload,
      field_missing: nextFieldMissing,
      source_meta: {
        analyzer: 'url_realtime_product_intel_v1',
        source_url: parsedUrl.toString(),
        source_host: hostName || null,
        url_fetch: urlFetchProvenance,
        competitor_queries: competitorOut?.queries || [],
        competitor_reason: competitorReason || null,
        competitor_source: competitorSource,
        retrieval_degradation: retrievalDegradation,
        ...(regulatorySupplement && regulatorySupplement.ok
          ? {
            regulatory_source: {
              provider: 'dailymed',
              url: String(regulatorySupplement.source_url || ''),
              query: String(regulatorySupplement.query || ''),
            },
          }
          : {}),
        ...(retailSupplement && retailSupplement.ok
          ? {
            retail_source: {
              provider: String(retailSupplement.source?.label || 'retail_pdp').trim().toLowerCase(),
              url: String(retailSupplement.source_url || ''),
              query: String(retailSupplement.query || ''),
              match_score: Number(retailSupplement.match_score || 0),
              ingredient_count: retailInci.length,
            },
          }
          : {}),
        ...(incidecoderSupplement && incidecoderSupplement.ok
          ? {
            incidecoder_source: {
              provider: 'incidecoder',
              url: String(incidecoderSupplement.source_url || ''),
              query: String(incidecoderSupplement.query || ''),
              match_score: Number(incidecoderSupplement.match_score || 0),
              overlap_count: incidecoderOverlapCount,
              ingredient_count: incidecoderInci.length,
            },
            inci_decoder_overlap_count: incidecoderOverlapCount,
          }
          : {}),
        competitor_snapshot_meta: competitorSnapshotMeta
          ? {
            source: String(competitorSnapshotMeta.source || 'snapshot'),
            confidence: Number.isFinite(Number(competitorSnapshotMeta.confidence))
              ? Number(competitorSnapshotMeta.confidence)
              : null,
            snapshot_age_sec: Number.isFinite(Number(competitorSnapshotMeta.age_sec))
              ? Number(competitorSnapshotMeta.age_sec)
              : null,
            degraded: Boolean(competitorSnapshotMeta.degraded),
            stale: Boolean(competitorSnapshotMeta.stale),
            very_stale: Boolean(competitorSnapshotMeta.very_stale),
          }
          : null,
        social_signal_present: !socialMissing,
        competitor_count: competitorCandidates.length,
        related_count: relatedCandidates.length,
        dupe_count: dupeCandidates.length,
        competitor_router_reason_codes: routeReasonCodes,
        ...(hasCandidateFilterDropStats(candidateFilterStats)
          ? {
            candidate_filter_stats: {
              competitors_dropped_non_skincare: Number(candidateFilterStats.competitors_dropped_non_skincare || 0),
              related_dropped_non_skincare: Number(candidateFilterStats.related_dropped_non_skincare || 0),
              dupes_dropped_non_skincare: Number(candidateFilterStats.dupes_dropped_non_skincare || 0),
            },
          }
          : {}),
        reco_blocks_dag: dagDiagnostics
          ? {
            mode: String(dagDiagnostics.mode || 'main_path'),
            budget_ms: Number(dagDiagnostics.budget_ms || AURORA_BFF_RECO_BLOCKS_BUDGET_MS),
            timed_out_blocks: dagTimedOutBlocks,
            fallbacks_used: dagFallbacksUsed,
            block_stats: dagProvenancePatch?.block_stats || null,
          }
          : null,
      },
    };
  }


  return {
    buildProductAnalysisFromUrlIngredients,
  };
}

module.exports = {
  createProductIntelUrlIngredientRuntime,
};
