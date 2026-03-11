'use strict';

const { executeDupeSuggest } = require('../usecases/dupeSuggest');
const { executeDupeCompare } = require('../usecases/dupeCompare');
const {
  buildDupeCompareParsePrompt,
  buildDupeCompareMainPrompt,
  buildDupeCompareDeepScanPrompt,
  mergeCompareProductContext,
} = require('../dupeCompareContract');
const { dupeFlags } = require('../dupeFlags');

/**
 * Mount dupe-related routes: /v1/dupe/suggest, /v1/dupe/compare.
 *
 * @param {object} app     – Express app
 * @param {object} deps    – shared dependencies from the main routes module
 */
function mountDupeRoutes(app, deps) {
  const {
    logger,
    buildRequestContext,
    requireAuroraUid,
    DupeSuggestRequestSchema,
    DupeCompareRequestSchema,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    applyDupeSuggestSanitizeToEnvelope,
    getDupeKbEntry,
    upsertDupeKbEntry,
    purgeDupeKbEntriesByContractVersion,
    normalizeDupeKbKey,
    searchPivotaBackendProducts,
    buildExternalSeedCompareSearchQueries,
    buildRecoAlternativesCandidatePool,
    fetchRecoAlternativesForProduct,
    auroraChat,
    buildContextPrefix,
    getUpstreamStructuredOrJson,
    extractJsonObjectByKeys,
    sanitizeDupeSuggestPayload,
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    summarizeProfileForContext,
    buildProductInputText,
    normalizeDupeCompareRequestPayload,
    normalizeDupeCompare,
    mapAuroraAlternativesToDupeCompare,
    mapAuroraProductAnalysis,
    normalizeProductAnalysis,
    enrichProductAnalysisPayload,
    extractAnchorIdFromProductLike,
    mergeFieldMissing,
    getDupeDeepscanCache,
    setDupeDeepscanCache,
  } = deps;

  const {
    AURORA_DECISION_BASE_URL,
    DUPE_KB_ASYNC_BACKFILL_ENABLED,
    AURORA_DUPE_SUGGEST_SANITIZE_V1,
  } = dupeFlags;

  // --- dupe_suggest services (assembled once, passed to usecase) ----------
  const _dupeSuggestServices = {
    getDupeKbEntry,
    upsertDupeKbEntry,
    purgeDupeKbEntriesByContractVersion,
    normalizeDupeKbKey,
    searchPivotaBackendProducts,
    buildExternalSeedCompareSearchQueries,
    buildRecoAlternativesCandidatePool,
    fetchRecoAlternativesForProduct,
    auroraChat,
    buildContextPrefix,
    getUpstreamStructuredOrJson,
    extractJsonObjectByKeys,
    sanitizeDupeSuggestPayload,
  };
  const _dupeSuggestFlags = {
    AURORA_DECISION_BASE_URL,
    DUPE_KB_ASYNC_BACKFILL_ENABLED,
  };

  app.post('/v1/dupe/suggest', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = DupeSuggestRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);

      const result = await executeDupeSuggest({
        ctx,
        input: parsed.data,
        profileSummary,
        recentLogs,
        services: _dupeSuggestServices,
        logger,
        flags: _dupeSuggestFlags,
      });

      if (!result.ok) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: result.error_code || 'BAD_REQUEST', details: result.error_details } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: result.error_code || 'BAD_REQUEST' })],
        });
        return res.status(result.status_code || 400).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_suggest_${ctx.request_id}`,
            type: 'dupe_suggest',
            payload: result.payload,
            ...(result.field_missing && result.field_missing.length ? { field_missing: result.field_missing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, result.event_kind || 'value_moment', { kind: 'dupe_suggest', source: result.event_source || 'llm', quality_gated: result.quality_gated })],
      });
      const sanitizedEnvelope = AURORA_DUPE_SUGGEST_SANITIZE_V1
        ? applyDupeSuggestSanitizeToEnvelope(envelope, { lang: ctx.lang }).envelope
        : envelope;
      return res.json(sanitizedEnvelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to suggest dupes.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'DUPE_SUGGEST_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'DUPE_SUGGEST_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  // --- dupe_compare inner orchestration (extracted for thin delegation) ------
  async function _executeCompareInner(ctx, {
    originalInput, dupeInput, originalObj, dupeObj, originalUrl, dupeUrl,
    profileSummary, recentLogs, logger: _logger,
    parsePrefix, analyzePrefix, comparePrefix,
  }) {
    const productQuery = (input) => buildDupeCompareParsePrompt({ prefix: parsePrefix, input });

    const parseOne = async ({ inputText, anchorObj, anchorUrl, side }) => {
      try {
        const anchorId = anchorObj && (anchorObj.sku_id || anchorObj.product_id);
        const _t0 = Date.now();
        const result = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: productQuery(inputText),
          timeoutMs: 9000,
          ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
          ...(anchorUrl ? { anchor_product_url: anchorUrl } : {}),
          prompt_template_id: 'dupe_compare_parse',
          trace_id: ctx.trace_id,
          request_id: ctx.request_id,
        });
        logger?.info({
          event: 'llm_call_trace',
          task_mode: 'dupe_compare',
          step: `parse_${side}`,
          template_id: 'dupe_compare_parse',
          has_anchor: Boolean(anchorId),
          has_url: Boolean(anchorUrl),
          duration_ms: Date.now() - _t0,
          has_structured: Boolean(result && result.structured),
        }, `aurora bff: dupe_compare parse_${side} llm trace`);
        return result;
      } catch {
        return null;
      }
    };

    const [originalUpstream, dupeUpstream] = await Promise.all([
      parseOne({ inputText: originalInput, anchorObj: originalObj, anchorUrl: originalUrl, side: 'original' }),
      parseOne({ inputText: dupeInput, anchorObj: dupeObj, anchorUrl: dupeUrl, side: 'dupe' }),
    ]);

    const originalStructured = getUpstreamStructuredOrJson(originalUpstream);
    const dupeStructured = getUpstreamStructuredOrJson(dupeUpstream);
    const originalAnchorFromUpstream = originalStructured && originalStructured.parse && typeof originalStructured.parse === 'object'
      ? (originalStructured.parse.anchor_product || originalStructured.parse.anchorProduct)
      : null;
    const dupeAnchorFromUpstream = dupeStructured && dupeStructured.parse && typeof dupeStructured.parse === 'object'
      ? (dupeStructured.parse.anchor_product || dupeStructured.parse.anchorProduct)
      : null;

    const originalAnchor = originalAnchorFromUpstream || originalObj || null;
    const dupeAnchor = dupeAnchorFromUpstream || dupeObj || null;

    const originalText = buildProductInputText(originalAnchor, originalUrl) || originalInput;
    const dupeText = buildProductInputText(dupeAnchor, dupeUrl) || dupeInput;

    const compareQuery = buildDupeCompareMainPrompt({
      prefix: comparePrefix,
      originalText,
      dupeText,
    });

    let compareUpstream = null;
    try {
      const originalAnchorId = originalAnchor && (originalAnchor.sku_id || originalAnchor.product_id);
      const _llmCompareStart = Date.now();
      compareUpstream = await auroraChat({
        baseUrl: AURORA_DECISION_BASE_URL,
        query: compareQuery,
        timeoutMs: 18000,
        ...(originalAnchorId ? { anchor_product_id: String(originalAnchorId) } : {}),
        ...(originalUrl ? { anchor_product_url: originalUrl } : {}),
        prompt_template_id: 'dupe_compare_main',
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
      });
      logger?.info({
        event: 'llm_call_trace',
        task_mode: 'dupe_compare',
        step: 'compare',
        template_id: 'dupe_compare_main',
        has_original_anchor: Boolean(originalAnchorId),
        has_original_url: Boolean(originalUrl),
        duration_ms: Date.now() - _llmCompareStart,
        has_structured: Boolean(compareUpstream && compareUpstream.structured),
      }, 'aurora bff: dupe_compare compare llm trace');
    } catch (err) {
      // ignore; fall back below
    }

    const compareStructured = (() => {
      const structured = compareUpstream && compareUpstream.structured && typeof compareUpstream.structured === 'object' && !Array.isArray(compareUpstream.structured)
        ? compareUpstream.structured
        : null;
      const answerJson =
        compareUpstream && typeof compareUpstream.answer === 'string'
          ? extractJsonObjectByKeys(compareUpstream.answer, [
            'tradeoffs',
            'tradeoffs_detail',
            'tradeoffsDetail',
            'evidence',
            'original',
            'dupe',
            'alternatives',
            'compare',
          ])
          : null;
      const answerObj = answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? answerJson : null;
      if (structured && Array.isArray(structured.alternatives)) return structured;
      if (answerObj && (Array.isArray(answerObj.tradeoffs) || answerObj.tradeoffs_detail || answerObj.tradeoffsDetail)) return answerObj;
      return structured || answerObj;
    })();

    const fallbackAnalyze = () => {
      if (!originalStructured || !dupeStructured) {
        return {
          original: originalAnchor || null,
          dupe: dupeAnchor || null,
          tradeoffs: [],
          evidence: null,
          confidence: null,
          missing_info: ['upstream_missing_or_unstructured'],
        };
      }
      const orig = mapAuroraProductAnalysis(originalStructured);
      const dup = mapAuroraProductAnalysis(dupeStructured);

      const origKeys = Array.isArray(orig.evidence?.science?.key_ingredients) ? orig.evidence.science.key_ingredients : [];
      const dupKeys = Array.isArray(dup.evidence?.science?.key_ingredients) ? dup.evidence.science.key_ingredients : [];
      const origRisk = Array.isArray(orig.evidence?.science?.risk_notes) ? orig.evidence.science.risk_notes : [];
      const dupRisk = Array.isArray(dup.evidence?.science?.risk_notes) ? dup.evidence.science.risk_notes : [];

      const barrierRaw = profileSummary && typeof profileSummary.barrierStatus === 'string' ? profileSummary.barrierStatus.trim().toLowerCase() : '';
      const barrierImpaired = barrierRaw === 'impaired' || barrierRaw === 'damaged';

      const ingredientSignals = (items) => {
        const out = {
          occlusives: [],
          humectants: [],
          soothing: [],
          exfoliants: [],
          brightening: [],
          peptides: [],
          fragrance: [],
          alcohol: [],
        };

        const seen = new Set();
        const add = (k, v) => {
          const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
          if (!s) return;
          const key = `${k}:${s.toLowerCase()}`;
          if (seen.has(key)) return;
          seen.add(key);
          out[k].push(s);
        };

        for (const raw of Array.isArray(items) ? items : []) {
          const s = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
          if (!s) continue;
          const n = s.toLowerCase();

          // Ignore trivial carriers.
          if (n === 'water' || n === 'aqua') continue;

          if (
            n.includes('petrolatum') ||
            n.includes('petroleum jelly') ||
            n.includes('mineral oil') ||
            n.includes('paraffin') ||
            n.includes('dimethicone') ||
            n.includes('lanolin') ||
            n.includes('wax') ||
            n.includes('beeswax') ||
            n.includes('shea butter') ||
            n.includes('cocoa butter')
          ) {
            add('occlusives', s);
          }

          if (
            n.includes('glycerin') ||
            n.includes('hyaluronic') ||
            n.includes('sodium hyaluronate') ||
            n.includes('panthenol') ||
            n.includes('urea') ||
            n.includes('betaine') ||
            n.includes('sodium pca') ||
            n.includes('trehalose') ||
            n.includes('propanediol') ||
            n.includes('butylene glycol') ||
            n.includes('sorbitol')
          ) {
            add('humectants', s);
          }

          if (
            n.includes('panthenol') ||
            n.includes('allantoin') ||
            n.includes('madecassoside') ||
            n.includes('centella') ||
            n.includes('ceramide') ||
            n.includes('cholesterol') ||
            n.includes('beta-glucan') ||
            n.includes('cica')
          ) {
            add('soothing', s);
          }

          if (
            n.includes('glycolic') ||
            n.includes('lactic') ||
            n.includes('mandelic') ||
            n.includes('salicylic') ||
            n.includes('gluconolactone') ||
            n.includes('pha') ||
            n.includes('bha') ||
            n.includes('aha')
          ) {
            add('exfoliants', s);
          }

          if (
            n.includes('niacinamide') ||
            n.includes('tranexamic') ||
            n.includes('azelaic') ||
            n.includes('ascorbic') ||
            n.includes('vitamin c') ||
            n.includes('arbutin') ||
            n.includes('kojic') ||
            n.includes('licorice')
          ) {
            add('brightening', s);
          }

          if (n.includes('peptide')) add('peptides', s);

          if (
            n.includes('fragrance') ||
            n.includes('parfum') ||
            n.includes('essential oil') ||
            n.includes('limonene') ||
            n.includes('linalool') ||
            n.includes('citral')
          ) {
            add('fragrance', s);
          }

          if (n.includes('alcohol denat') || n.includes('denatured alcohol')) add('alcohol', s);
        }

        return out;
      };

      const pickFew = (arr, max) => Array.from(new Set(Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : [])).slice(0, max);
      const joinFew = (arr, max) => pickFew(arr, max).join(', ');
      const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

      const origSig = ingredientSignals(origKeys);
      const dupSig = ingredientSignals(dupKeys);

      const tradeoffs = [];
      if (nonEmpty(origSig.occlusives) && !nonEmpty(dupSig.occlusives) && nonEmpty(dupSig.humectants)) {
        tradeoffs.push(
          ctx.lang === 'CN'
            ? `质地/封闭性：原产品更偏封闭锁水（例如 ${joinFew(origSig.occlusives, 2)}）；平替更偏补水（例如 ${joinFew(dupSig.humectants, 2)}）→ 通常更清爽，但可能需要叠加面霜来“锁水”。`
            : `Texture/finish: Original is more occlusive (e.g., ${joinFew(origSig.occlusives, 2)}) while the dupe is more humectant (e.g., ${joinFew(dupSig.humectants, 2)}) → lighter feel, but may need a moisturizer on top to seal.`,
        );
      } else if (nonEmpty(origSig.occlusives) && nonEmpty(dupSig.occlusives)) {
        tradeoffs.push(
          ctx.lang === 'CN'
            ? `共同点：两者都含封闭/油脂类成分（原：${joinFew(origSig.occlusives, 2)}；平替：${joinFew(dupSig.occlusives, 2)}）→ 都可能偏“锁水/滋润”，差异更多来自比例与配方。`
            : `Shared: Both include occlusive/emollient components (orig: ${joinFew(origSig.occlusives, 2)}; dupe: ${joinFew(dupSig.occlusives, 2)}) → both can be “sealing”; differences may come from formula balance.`,
        );
      }

      if (nonEmpty(origSig.humectants) && nonEmpty(dupSig.humectants) && tradeoffs.length < 2) {
        tradeoffs.push(
          ctx.lang === 'CN'
            ? `共同点：两者都含常见保湿成分（原：${joinFew(origSig.humectants, 2)}；平替：${joinFew(dupSig.humectants, 2)}）→ 都能提升含水量，但“锁水力度”仍取决于封闭类成分。`
            : `Shared: Both include humectants (orig: ${joinFew(origSig.humectants, 2)}; dupe: ${joinFew(dupSig.humectants, 2)}) → both support hydration; how “sealing” it feels depends on occlusives.`,
        );
      }

      if (nonEmpty(dupSig.exfoliants)) {
        tradeoffs.push(
          ctx.lang === 'CN'
            ? `刺激风险：平替含去角质类成分（例如 ${joinFew(dupSig.exfoliants, 2)}）→ ${barrierImpaired ? '屏障受损时更容易不耐受，建议低频' : '更易刺激，建议低频'}，不要叠加强活性。`
            : `Irritation risk: Dupe includes exfoliant-like actives (e.g., ${joinFew(dupSig.exfoliants, 2)}) → ${barrierImpaired ? 'higher irritation risk if your barrier is impaired; start low' : 'higher irritation risk; start low'}, avoid stacking strong actives.`,
        );
      }

      if (nonEmpty(dupSig.fragrance) && !nonEmpty(origSig.fragrance)) {
        tradeoffs.push(
          ctx.lang === 'CN'
            ? `气味/敏感风险：平替可能含香精/香料相关成分（例如 ${joinFew(dupSig.fragrance, 1)}）→ 更敏感人群需要谨慎。`
            : `Fragrance risk: Dupe may include fragrance-related ingredients (e.g., ${joinFew(dupSig.fragrance, 1)}) → higher risk for sensitive skin.`,
        );
      }

      const addedRisks = dupRisk.filter((k) => !origRisk.includes(k));
      if (addedRisks.length) {
        tradeoffs.push(
          ctx.lang === 'CN'
            ? `平替风险提示：${addedRisks.slice(0, 2).join(' · ')}`
            : `Dupe risk notes: ${addedRisks.slice(0, 2).join(' · ')}`,
        );
      }

      if (!tradeoffs.length) {
        const origPreview = pickFew([...origSig.occlusives, ...origSig.humectants, ...origSig.soothing, ...origSig.brightening, ...origSig.exfoliants], 3);
        const dupPreview = pickFew([...dupSig.occlusives, ...dupSig.humectants, ...dupSig.soothing, ...dupSig.brightening, ...dupSig.exfoliants], 3);
        if (origPreview.length && dupPreview.length) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `关键成分侧重（简要）：原产品—${origPreview.length ? origPreview.join(' / ') : '未知'}；平替—${dupPreview.length ? dupPreview.join(' / ') : '未知'}。`
              : `Key ingredient emphasis (brief): original — ${origPreview.length ? origPreview.join(' / ') : 'unknown'}; dupe — ${dupPreview.length ? dupPreview.join(' / ') : 'unknown'}.`,
          );
        }
      }

      const confidence = typeof orig.confidence === 'number' && typeof dup.confidence === 'number'
        ? (orig.confidence + dup.confidence) / 2
        : (orig.confidence || dup.confidence || null);

      const evidence = {
        science: {
          key_ingredients: Array.from(new Set([...origKeys, ...dupKeys])),
          mechanisms: Array.from(new Set([...(orig.evidence?.science?.mechanisms || []), ...(dup.evidence?.science?.mechanisms || [])])),
          fit_notes: Array.from(new Set([...(orig.evidence?.science?.fit_notes || []), ...(dup.evidence?.science?.fit_notes || [])])),
          risk_notes: Array.from(new Set([...(orig.evidence?.science?.risk_notes || []), ...(dup.evidence?.science?.risk_notes || [])])),
        },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: Array.from(new Set([...(orig.evidence?.expert_notes || []), ...(dup.evidence?.expert_notes || [])])),
        confidence,
        missing_info: ['dupe_not_in_alternatives_used_analyze_diff'],
      };

      return {
        original: originalAnchor || null,
        dupe: dupeAnchor || null,
        tradeoffs,
        evidence,
        confidence,
        missing_info: ['dupe_not_found_in_alternatives'],
      };
    };

    const mappedFromOriginalAlts =
      originalStructured && originalStructured.alternatives
        ? mapAuroraAlternativesToDupeCompare(originalStructured, dupeAnchor, {
            fallbackAnalyze,
            originalAnchorFallback: originalAnchor,
            lang: ctx.lang,
            barrierStatus: profileSummary && profileSummary.barrierStatus,
          })
        : null;

    const mapped = (() => {
      // Prefer structured.alternatives (when present) because it yields stable similarity/tradeoffs.
      if (mappedFromOriginalAlts && Array.isArray(mappedFromOriginalAlts.tradeoffs) && mappedFromOriginalAlts.tradeoffs.length) {
        return mappedFromOriginalAlts;
      }
      if (compareStructured) {
        if (compareStructured.alternatives) {
          return mapAuroraAlternativesToDupeCompare(compareStructured, dupeAnchor, {
            fallbackAnalyze,
            originalAnchorFallback: originalAnchor,
            lang: ctx.lang,
            barrierStatus: profileSummary && profileSummary.barrierStatus,
          });
        }
        return compareStructured;
      }
      if (mappedFromOriginalAlts) return mappedFromOriginalAlts;
      return fallbackAnalyze();
    })();

    const norm = normalizeDupeCompare(mapped);
    let payload = norm.payload;
    let field_missing = norm.field_missing;
    if (originalAnchor) payload = { ...payload, original: mergeCompareProductContext(originalAnchor, payload.original) };
    if (dupeAnchor) payload = { ...payload, dupe: mergeCompareProductContext(dupeAnchor, payload.dupe) };

    const uniqStrings = (arr) => {
      const out = [];
      const seen = new Set();
      for (const v of Array.isArray(arr) ? arr : []) {
        const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    };
    const coerceCompareProduct = (product) => {
      const row = product && typeof product === 'object' ? { ...product } : product;
      if (!row || typeof row !== 'object') return row;
      const brand = typeof row.brand === 'string' ? row.brand.trim() : '';
      const name = [
        row.name,
        row.display_name,
        row.displayName,
        row.product_name,
        row.productName,
        row.title,
      ].map((value) => (typeof value === 'string' ? value.trim() : '')).find(Boolean) || '';
      return {
        ...row,
        brand,
        name,
        ...(name && !row.display_name ? { display_name: name } : {}),
      };
    };

    const isMissingTradeoffs = !Array.isArray(payload.tradeoffs) || payload.tradeoffs.length === 0;
    if (isMissingTradeoffs) {
      const scanOne = async ({ productText, productObj, productUrl }) => {
        const anchorId = extractAnchorIdFromProductLike(productObj);
        const bestText = String(productText || '').trim() || (anchorId ? String(anchorId) : '');
        if (!bestText) return null;

        const cacheKey = (() => {
          const langKey = ctx.lang === 'CN' ? 'CN' : 'EN';
          if (anchorId) return `dupe_deepscan:${langKey}:id:${String(anchorId).trim()}`;
          const url = typeof productUrl === 'string' ? productUrl.trim() : '';
          if (url) return `dupe_deepscan:${langKey}:url:${url}`;
          const norm = bestText.toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
          return `dupe_deepscan:${langKey}:text:${norm}`;
        })();
        const cached = getDupeDeepscanCache(cacheKey);
        if (cached) return cached;

        const buildQuery = (strict = false) =>
          buildDupeCompareDeepScanPrompt({
            prefix: analyzePrefix,
            productText: bestText,
            strict,
          });

        const runScan = async (queryText, timeoutMs) =>
          auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: queryText,
            timeoutMs,
            ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
            ...(productUrl ? { anchor_product_url: productUrl } : {}),
          });

        const parseUpstream = (upstream) => {
          const upStructured = upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
            ? upstream.structured
            : null;
          const upAnswerJson =
            upstream && typeof upstream.answer === 'string'
              ? extractJsonObjectByKeys(upstream.answer, [
                  'assessment',
                  'evidence',
                  'confidence',
                  'missing_info',
                  'missingInfo',
                  'analyze',
                  'verdict',
                  'reasons',
                  'science_evidence',
                  'social_signals',
                  'expert_notes',
                ])
              : null;
          const upAnswerObj = upAnswerJson && typeof upAnswerJson === 'object' && !Array.isArray(upAnswerJson) ? upAnswerJson : null;
          const answerLooksLikeProductAnalysis =
            upAnswerObj &&
            (upAnswerObj.assessment != null ||
              upAnswerObj.evidence != null ||
              upAnswerObj.analyze != null ||
              upAnswerObj.analysis != null ||
              upAnswerObj.product_analysis != null ||
              upAnswerObj.productAnalysis != null ||
              upAnswerObj.confidence != null ||
              upAnswerObj.missing_info != null ||
              upAnswerObj.missingInfo != null ||
              upAnswerObj.verdict != null ||
              upAnswerObj.reasons != null ||
              upAnswerObj.science_evidence != null ||
              upAnswerObj.scienceEvidence != null ||
              upAnswerObj.social_signals != null ||
              upAnswerObj.socialSignals != null ||
              upAnswerObj.expert_notes != null ||
              upAnswerObj.expertNotes != null);
          const structuredOrJson =
            upStructured && upStructured.analyze && typeof upStructured.analyze === 'object'
              ? upStructured
              : answerLooksLikeProductAnalysis
                ? upAnswerObj
                : upStructured || upAnswerObj;

          const mappedAnalyze =
            structuredOrJson && typeof structuredOrJson === 'object' && !Array.isArray(structuredOrJson)
              ? mapAuroraProductAnalysis(structuredOrJson)
              : structuredOrJson;
          const normAnalyze = normalizeProductAnalysis(mappedAnalyze);
          const keyIngredientsNow = (() => {
            const ev = normAnalyze.payload && typeof normAnalyze.payload === 'object' ? normAnalyze.payload.evidence : null;
            const sci = ev && typeof ev === 'object' ? ev.science : null;
            const key = sci && typeof sci === 'object' ? (sci.key_ingredients || sci.keyIngredients) : null;
            return Array.isArray(key) ? key.filter(Boolean) : [];
          })();
          return { normAnalyze, keyIngredientsNow };
        };

        let best = null;
        try {
          const upstream1 = await runScan(buildQuery(false), 12000);
          best = parseUpstream(upstream1);
        } catch {
          // ignore
        }

        const needsRetry = !best || !best.normAnalyze.payload.assessment || best.keyIngredientsNow.length === 0;
        if (needsRetry) {
          try {
            const upstream2 = await runScan(buildQuery(true), 11000);
            const parsed2 = parseUpstream(upstream2);
            if (parsed2 && parsed2.normAnalyze && parsed2.normAnalyze.payload && parsed2.normAnalyze.payload.assessment) {
              best = parsed2;
            }
          } catch {
            // ignore
          }
        }

        if (!best) return null;

        const enriched = enrichProductAnalysisPayload(best.normAnalyze.payload, { lang: ctx.lang, profileSummary });
        const out = { payload: enriched, field_missing: best.normAnalyze.field_missing };

        const keyAfterEnrich = (() => {
          const ev = enriched && typeof enriched === 'object' ? enriched.evidence : null;
          const sci = ev && typeof ev === 'object' ? ev.science : null;
          const key = sci && typeof sci === 'object' ? (sci.key_ingredients || sci.keyIngredients) : null;
          return Array.isArray(key) ? key.filter(Boolean) : [];
        })();
        if (enriched && enriched.assessment && keyAfterEnrich.length >= 3) {
          setDupeDeepscanCache(cacheKey, out);
        }

        return out;
      };

      const [origScan, dupeScan] = await Promise.all([
        scanOne({ productText: originalText, productObj: originalAnchor, productUrl: originalUrl }),
        scanOne({ productText: dupeText, productObj: dupeAnchor, productUrl: dupeUrl }),
      ]);

      const origPayload = origScan && origScan.payload && typeof origScan.payload === 'object' ? origScan.payload : null;
      const dupePayload = dupeScan && dupeScan.payload && typeof dupeScan.payload === 'object' ? dupeScan.payload : null;

      const extractEvidence = (p) => {
        const ev = p && typeof p === 'object' ? p.evidence : null;
        const sci = ev && typeof ev === 'object' ? ev.science : null;
        const soc = ev && typeof ev === 'object' ? (ev.social_signals || ev.socialSignals) : null;
        return {
          key: uniqStrings(sci && Array.isArray(sci.key_ingredients || sci.keyIngredients) ? (sci.key_ingredients || sci.keyIngredients) : []),
          mech: uniqStrings(sci && Array.isArray(sci.mechanisms) ? sci.mechanisms : []),
          fit: uniqStrings(sci && Array.isArray(sci.fit_notes || sci.fitNotes) ? (sci.fit_notes || sci.fitNotes) : []),
          risk: uniqStrings(sci && Array.isArray(sci.risk_notes || sci.riskNotes) ? (sci.risk_notes || sci.riskNotes) : []),
          pos: uniqStrings(soc && Array.isArray(soc.typical_positive || soc.typicalPositive) ? (soc.typical_positive || soc.typicalPositive) : []),
          neg: uniqStrings(soc && Array.isArray(soc.typical_negative || soc.typicalNegative) ? (soc.typical_negative || soc.typicalNegative) : []),
          expert: uniqStrings(ev && Array.isArray(ev.expert_notes || ev.expertNotes) ? (ev.expert_notes || ev.expertNotes) : []),
          missing: uniqStrings(ev && Array.isArray(ev.missing_info || ev.missingInfo) ? (ev.missing_info || ev.missingInfo) : []),
          conf: ev && typeof ev.confidence === 'number' ? ev.confidence : null,
        };
      };

      const origEv = extractEvidence(origPayload);
      const dupEv = extractEvidence(dupePayload);

      const isCn = ctx.lang === 'CN';

      const ingredientSignals = (items) => {
        const out = {
          occlusives: [],
          humectants: [],
          soothing: [],
          exfoliants: [],
          brightening: [],
          peptides: [],
          fragrance: [],
          alcohol: [],
        };

        const seen = new Set();
        const add = (k, v) => {
          const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
          if (!s) return;
          const key = `${k}:${s.toLowerCase()}`;
          if (seen.has(key)) return;
          seen.add(key);
          out[k].push(s);
        };

        for (const raw of Array.isArray(items) ? items : []) {
          const s = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
          if (!s) continue;
          const n = s.toLowerCase();

          // Ignore trivial carriers.
          if (n === 'water' || n === 'aqua') continue;

          if (
            n.includes('petrolatum') ||
            n.includes('petroleum jelly') ||
            n.includes('mineral oil') ||
            n.includes('paraffin') ||
            n.includes('dimethicone') ||
            n.includes('lanolin') ||
            n.includes('wax') ||
            n.includes('beeswax') ||
            n.includes('shea butter') ||
            n.includes('cocoa butter')
          ) {
            add('occlusives', s);
          }

          if (
            n.includes('glycerin') ||
            n.includes('hyaluronic') ||
            n.includes('sodium hyaluronate') ||
            n.includes('panthenol') ||
            n.includes('urea') ||
            n.includes('betaine') ||
            n.includes('sodium pca') ||
            n.includes('trehalose') ||
            n.includes('propanediol') ||
            n.includes('butylene glycol') ||
            n.includes('sorbitol')
          ) {
            add('humectants', s);
          }

          if (
            n.includes('panthenol') ||
            n.includes('allantoin') ||
            n.includes('madecassoside') ||
            n.includes('centella') ||
            n.includes('ceramide') ||
            n.includes('cholesterol') ||
            n.includes('beta-glucan') ||
            n.includes('cica')
          ) {
            add('soothing', s);
          }

          if (
            n.includes('glycolic') ||
            n.includes('lactic') ||
            n.includes('mandelic') ||
            n.includes('salicylic') ||
            n.includes('gluconolactone') ||
            n.includes('pha') ||
            n.includes('bha') ||
            n.includes('aha')
          ) {
            add('exfoliants', s);
          }

          if (
            n.includes('niacinamide') ||
            n.includes('tranexamic') ||
            n.includes('azelaic') ||
            n.includes('ascorbic') ||
            n.includes('vitamin c') ||
            n.includes('arbutin') ||
            n.includes('kojic') ||
            n.includes('licorice')
          ) {
            add('brightening', s);
          }

          if (n.includes('peptide')) add('peptides', s);

          if (
            n.includes('fragrance') ||
            n.includes('parfum') ||
            n.includes('essential oil') ||
            n.includes('limonene') ||
            n.includes('linalool') ||
            n.includes('citral')
          ) {
            add('fragrance', s);
          }

          if (n.includes('alcohol denat') || n.includes('denatured alcohol')) add('alcohol', s);
        }

        return out;
      };

      const pickFew = (arr, max) => uniqStrings(arr).slice(0, max);
      const joinFew = (arr, max) => pickFew(arr, max).join(', ');
      const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

      const origSig = ingredientSignals(origEv.key);
      const dupSig = ingredientSignals(dupEv.key);

      const derivedTradeoffs = [];

      // More human, high-signal comparisons (avoid dumping full INCI).
      if (nonEmpty(origSig.occlusives) && !nonEmpty(dupSig.occlusives) && nonEmpty(dupSig.humectants)) {
        derivedTradeoffs.push(
          isCn
            ? `质地/封闭性：原产品更偏封闭锁水（例如 ${joinFew(origSig.occlusives, 2)}）；平替更偏补水（例如 ${joinFew(dupSig.humectants, 2)}）→ 通常更清爽，但可能需要叠加面霜来“锁水”。`
            : `Texture/finish: Original is more occlusive (e.g., ${joinFew(origSig.occlusives, 2)}) while the dupe is more humectant (e.g., ${joinFew(dupSig.humectants, 2)}) → lighter feel, but may need a moisturizer on top to seal.`,
        );
      } else if (nonEmpty(dupSig.occlusives) && !nonEmpty(origSig.occlusives) && nonEmpty(origSig.humectants)) {
        derivedTradeoffs.push(
          isCn
            ? `质地/封闭性：平替更偏封闭锁水（例如 ${joinFew(dupSig.occlusives, 2)}）；原产品更偏补水（例如 ${joinFew(origSig.humectants, 2)}）→ 平替通常更厚重、更“锁水”。`
            : `Texture/finish: Dupe is more occlusive (e.g., ${joinFew(dupSig.occlusives, 2)}) while the original is more humectant (e.g., ${joinFew(origSig.humectants, 2)}) → dupe may feel richer and more sealing.`,
        );
      } else if (nonEmpty(origSig.occlusives) && nonEmpty(dupSig.occlusives)) {
        derivedTradeoffs.push(
          isCn
            ? `共同点：两者都含封闭/油脂类成分（原：${joinFew(origSig.occlusives, 2)}；平替：${joinFew(dupSig.occlusives, 2)}）→ 都可能偏“锁水/滋润”，差异更多来自比例与配方。`
            : `Shared: Both include occlusive/emollient components (orig: ${joinFew(origSig.occlusives, 2)}; dupe: ${joinFew(dupSig.occlusives, 2)}) → both can be “sealing”; differences may come from formula balance.`,
        );
      }

      if (nonEmpty(origSig.humectants) && nonEmpty(dupSig.humectants) && derivedTradeoffs.length < 2) {
        derivedTradeoffs.push(
          isCn
            ? `共同点：两者都含常见保湿成分（原：${joinFew(origSig.humectants, 2)}；平替：${joinFew(dupSig.humectants, 2)}）→ 都能提升含水量，但“锁水力度”仍取决于封闭类成分。`
            : `Shared: Both include humectants (orig: ${joinFew(origSig.humectants, 2)}; dupe: ${joinFew(dupSig.humectants, 2)}) → both support hydration; how “sealing” it feels depends on occlusives.`,
        );
      }

      if (nonEmpty(dupSig.exfoliants)) {
        derivedTradeoffs.push(
          isCn
            ? `刺激风险：平替含去角质类成分（例如 ${joinFew(dupSig.exfoliants, 2)}）→ 屏障受损/刺痛时更容易不耐受，建议低频、不要叠加强活性。`
            : `Irritation risk: Dupe includes exfoliant-like actives (e.g., ${joinFew(dupSig.exfoliants, 2)}) → higher irritation risk if your barrier is impaired; start low and avoid stacking strong actives.`,
        );
      }

      if (nonEmpty(dupSig.fragrance) && !nonEmpty(origSig.fragrance)) {
        derivedTradeoffs.push(
          isCn
            ? `气味/敏感风险：平替可能含香精/香料相关成分（例如 ${joinFew(dupSig.fragrance, 1)}）→ 更敏感人群需要谨慎。`
            : `Fragrance risk: Dupe may include fragrance-related ingredients (e.g., ${joinFew(dupSig.fragrance, 1)}) → higher risk for sensitive skin.`,
        );
      }

      const addedRisks = dupEv.risk.filter((k) => !origEv.risk.includes(k));
      if (addedRisks.length) {
        derivedTradeoffs.push(
          isCn
            ? `平替风险提示：${addedRisks.slice(0, 2).join(' · ')}`
            : `Dupe risk notes: ${addedRisks.slice(0, 2).join(' · ')}`,
        );
      }

      if (derivedTradeoffs.length < 2) {
        const origPreview = pickFew([...origSig.occlusives, ...origSig.humectants, ...origSig.soothing, ...origSig.brightening, ...origSig.exfoliants], 3);
        const dupPreview = pickFew([...dupSig.occlusives, ...dupSig.humectants, ...dupSig.soothing, ...dupSig.brightening, ...dupSig.exfoliants], 3);
        if (origPreview.length && dupPreview.length) {
          derivedTradeoffs.push(
            isCn
              ? `关键成分侧重（简要）：原产品—${origPreview.length ? origPreview.join(' / ') : '未知'}；平替—${dupPreview.length ? dupPreview.join(' / ') : '未知'}。`
              : `Key ingredient emphasis (brief): original — ${origPreview.length ? origPreview.join(' / ') : 'unknown'}; dupe — ${dupPreview.length ? dupPreview.join(' / ') : 'unknown'}.`,
          );
        }
      }

      const origHero = origPayload && origPayload.assessment && typeof origPayload.assessment === 'object'
        ? (origPayload.assessment.hero_ingredient || origPayload.assessment.heroIngredient)
        : null;
      const dupHero = dupePayload && dupePayload.assessment && typeof dupePayload.assessment === 'object'
        ? (dupePayload.assessment.hero_ingredient || dupePayload.assessment.heroIngredient)
        : null;
      if (origHero && dupHero && origHero.name && dupHero.name && String(origHero.name).toLowerCase() !== String(dupHero.name).toLowerCase()) {
        derivedTradeoffs.push(`Hero ingredient shift: ${origHero.name} → ${dupHero.name}`);
      }

      const outConfidence = typeof origEv.conf === 'number' && typeof dupEv.conf === 'number'
        ? (origEv.conf + dupEv.conf) / 2
        : (origEv.conf || dupEv.conf || null);

      const labelLines = (label, arr, max) => uniqStrings(arr).slice(0, max).map((x) => `${label}: ${x}`);

      const mergedEvidence = {
        science: {
          key_ingredients: uniqStrings([...origEv.key, ...dupEv.key]),
          mechanisms: uniqStrings([...origEv.mech, ...dupEv.mech]).slice(0, 8),
          fit_notes: uniqStrings([...labelLines('Original', origEv.fit, 3), ...labelLines('Dupe', dupEv.fit, 3)]),
          risk_notes: uniqStrings([...labelLines('Original', origEv.risk, 3), ...labelLines('Dupe', dupEv.risk, 3)]),
        },
        social_signals: {
          typical_positive: uniqStrings([...labelLines('Original', origEv.pos, 3), ...labelLines('Dupe', dupEv.pos, 3)]),
          typical_negative: uniqStrings([...labelLines('Original', origEv.neg, 3), ...labelLines('Dupe', dupEv.neg, 3)]),
          risk_for_groups: [],
        },
        expert_notes: uniqStrings([...labelLines('Original', origEv.expert, 2), ...labelLines('Dupe', dupEv.expert, 2)]),
        confidence: outConfidence,
        missing_info: uniqStrings(['tradeoffs_from_product_analyze_diff', ...origEv.missing, ...dupEv.missing]),
      };

      const origAnchorOut =
        (origPayload && origPayload.assessment && typeof origPayload.assessment === 'object'
          ? (origPayload.assessment.anchor_product || origPayload.assessment.anchorProduct)
          : null) || payload.original || null;
      const dupeAnchorOut =
        (dupePayload && dupePayload.assessment && typeof dupePayload.assessment === 'object'
          ? (dupePayload.assessment.anchor_product || dupePayload.assessment.anchorProduct)
          : null) || payload.dupe || null;

      if (derivedTradeoffs.length) {
        const rawOut = {
          original: origAnchorOut,
          dupe: dupeAnchorOut,
          ...(payload.similarity != null ? { similarity: payload.similarity } : {}),
          ...(payload.tradeoffs_detail ? { tradeoffs_detail: payload.tradeoffs_detail } : {}),
          tradeoffs: derivedTradeoffs.slice(0, 6),
          evidence: mergedEvidence,
          confidence: outConfidence,
          missing_info: uniqStrings([
            ...uniqStrings(payload.missing_info).filter((c) => c !== 'evidence_missing'),
            'compare_tradeoffs_missing_used_deepscan_diff',
          ]),
        };
        const norm2 = normalizeDupeCompare(rawOut);
        payload = norm2.payload;
        field_missing = mergeFieldMissing(field_missing.filter((x) => x && x.field !== 'tradeoffs'), norm2.field_missing);
        field_missing = mergeFieldMissing(field_missing, mergeFieldMissing(origScan && origScan.field_missing, dupeScan && dupeScan.field_missing));
      }
    }

    if (!Array.isArray(payload.tradeoffs) || payload.tradeoffs.length === 0) {
      const note =
        ctx.lang === 'CN'
          ? '上游未返回可用的取舍对比细节（仅能提供有限对比）。你可以提供平替的链接/完整名称，或从推荐的替代里选择再比对。'
          : 'No tradeoff details were returned (comparison is limited). Provide the dupe link/full name or pick from suggested alternatives to compare again.';
      const basicBullets = [];
      const origObj = payload.original && typeof payload.original === 'object' ? payload.original : {};
      const dupeObj = payload.dupe && typeof payload.dupe === 'object' ? payload.dupe : {};
      const origCat = String(origObj.category || origObj.product_type || origObj.type || '').trim();
      const dupeCat = String(dupeObj.category || dupeObj.product_type || dupeObj.type || '').trim();
      if (origCat && dupeCat) {
        basicBullets.push(ctx.lang === 'CN'
          ? `品类：${origCat === dupeCat ? `两者同属「${origCat}」` : `原产品「${origCat}」vs 平替「${dupeCat}」`}`
          : `Category: ${origCat === dupeCat ? `Both are "${origCat}"` : `Original "${origCat}" vs dupe "${dupeCat}"`}`);
      } else if (origCat || dupeCat) {
        basicBullets.push(ctx.lang === 'CN' ? `品类：${origCat || dupeCat}` : `Category: ${origCat || dupeCat}`);
      }
      const origPrice = Number(origObj.price || origObj.price_usd);
      const dupePrice = Number(dupeObj.price || dupeObj.price_usd);
      if (Number.isFinite(origPrice) && Number.isFinite(dupePrice)) {
        const diff = Math.round((dupePrice - origPrice) * 100) / 100;
        basicBullets.push(ctx.lang === 'CN'
          ? `价格差异：${diff > 0 ? '+$' + Math.abs(diff) : diff < 0 ? '-$' + Math.abs(diff) : '相近'}`
          : `Price delta: ${diff > 0 ? '+$' + Math.abs(diff) : diff < 0 ? '-$' + Math.abs(diff) : 'similar'}`);
      } else {
        basicBullets.push(ctx.lang === 'CN' ? '价格差异：未知' : 'Price delta: unknown');
      }
      if (payload.similarity != null && Number.isFinite(Number(payload.similarity))) {
        const pct = Math.round(Number(payload.similarity) > 1 ? Number(payload.similarity) : Number(payload.similarity) * 100);
        basicBullets.push(ctx.lang === 'CN' ? `相似度：${pct}%` : `Similarity: ${pct}%`);
      }
      payload = {
        ...payload,
        original: coerceCompareProduct(payload.original),
        dupe: coerceCompareProduct(payload.dupe),
        tradeoffs: [note],
        compare_quality: 'limited',
        limited_reason: 'tradeoffs_detail_missing',
        basic_compare: basicBullets,
        missing_info: uniqStrings([...(Array.isArray(payload.missing_info) ? payload.missing_info : []), 'tradeoffs_detail_missing']),
      };
    } else {
      payload = {
        ...payload,
        original: coerceCompareProduct(payload.original),
        dupe: coerceCompareProduct(payload.dupe),
        compare_quality: String(payload.compare_quality || '').trim().toLowerCase() === 'limited' ? 'limited' : 'full',
        limited_reason: typeof payload.limited_reason === 'string' ? payload.limited_reason : '',
      };
    }

    return { payload, field_missing };
  }

  app.post('/v1/dupe/compare', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = DupeCompareRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const compareInput = normalizeDupeCompareRequestPayload(parsed.data);
      const upstreamMeta = { lang: ctx.lang, state: ctx.state || 'idle', trigger_source: ctx.trigger_source };
      const parsePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
      const analyzePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_analyze', action_id: 'chip.action.analyze_product' });
      const comparePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'dupe_compare', action_id: 'chip.action.dupe_compare' });

      const result = await executeDupeCompare({
        ctx,
        input: compareInput,
        services: {
          resolveIdentity: () => resolveIdentity(req, ctx),
          getProfileForIdentity,
          getRecentSkinLogsForIdentity,
          summarizeProfileForContext,
          executeCompareInner: (innerCtx, innerInput) =>
            _executeCompareInner(innerCtx, {
              ...innerInput,
              logger,
              parsePrefix,
              analyzePrefix,
              comparePrefix,
            }),
        },
        logger,
      });

      if (!result.ok) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: result.error_code || 'BAD_REQUEST', details: result.error_details } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: result.error_code || 'BAD_REQUEST' })],
        });
        return res.status(result.status_code || 400).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_${ctx.request_id}`,
            type: 'dupe_compare',
            payload: result.payload,
            ...(result.field_missing?.length ? { field_missing: result.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, result.event_kind || 'value_moment', { kind: 'dupe_compare', quality_gated: result.quality_gated === true })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to compare products.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'DUPE_COMPARE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'DUPE_COMPARE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });



}

module.exports = { mountDupeRoutes };
