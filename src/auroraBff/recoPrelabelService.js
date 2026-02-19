const crypto = require('crypto');
const { normalizeKey: normalizeProductIntelKbKey, getProductIntelKbEntry } = require('./productIntelKbStore');
const { PRELABEL_PROMPT_VERSION, buildPrelabelSystemPrompt, buildPrelabelUserPrompt } = require('./recoPrelabelPrompts');
const { callGeminiPrelabel } = require('./recoPrelabelGemini');
const { validateAndNormalizePrelabelOutput, fallbackInvalidJson } = require('./recoPrelabelValidator');
const { upsertSuggestion, getSuggestionByInputHash, getSuggestionsByAnchor } = require('./recoLabelSuggestionStore');

const BLOCKS = ['competitors', 'dupes', 'related_products'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, max = 400) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function uniqStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const token = normalizeText(raw, 120).toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableStringify(value) {
  const seen = new WeakSet();
  const serialize = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (seen.has(v)) return '"[Circular]"';
    seen.add(v);
    if (Array.isArray(v)) return `[${v.map((item) => serialize(item)).join(',')}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(v[k])}`).join(',')}}`;
  };
  return serialize(value);
}

function hashSha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function normalizeBlock(block) {
  const token = normalizeText(block, 64).toLowerCase();
  if (token === 'competitors' || token === 'dupes' || token === 'related_products') return token;
  return '';
}

function normalizeLang(lang) {
  const token = normalizeText(lang, 16).toUpperCase();
  return token === 'CN' ? 'CN' : 'EN';
}

function blockCandidates(payload, block) {
  const obj = isPlainObject(payload?.[block]) ? payload[block] : {};
  return safeArray(obj.candidates).filter((row) => isPlainObject(row));
}

function pickCandidateId(candidate, index) {
  const row = isPlainObject(candidate) ? candidate : {};
  const key = row.product_id || row.sku_id || row.id || row.name || row.display_name || `idx:${index + 1}`;
  return normalizeText(key, 240);
}

function pickAnchorFromPayload(payload, anchorProductId = '') {
  const assessment = isPlainObject(payload?.assessment) ? payload.assessment : {};
  const anchor = isPlainObject(assessment.anchor_product) ? assessment.anchor_product : {};
  const anchorId = normalizeText(anchorProductId || anchor.product_id || anchor.sku_id || anchor.name, 240);
  return {
    anchor_product_id: anchorId,
    anchor: {
      product_id: normalizeText(anchor.product_id || anchor.sku_id, 200) || anchorId || null,
      brand: normalizeText(anchor.brand || anchor.brand_name, 120) || null,
      category: normalizeText(anchor.category || anchor.category_taxonomy, 180) || null,
      use_case: normalizeText(anchor.use_case || anchor.goal, 180) || null,
      price: anchor.price ?? null,
      ingredients: safeArray(anchor.ingredients || anchor.key_ingredients).map((x) => normalizeText(x, 80)).filter(Boolean).slice(0, 12),
      skin_fit: safeArray(anchor.skin_fit || anchor.skin_tags).map((x) => normalizeText(x, 80)).filter(Boolean).slice(0, 8),
    },
  };
}

function sanitizeEvidenceRefs(candidate) {
  const out = [];
  const refs = safeArray(candidate?.evidence_refs);
  for (const ref of refs) {
    if (!isPlainObject(ref)) continue;
    const displayText = normalizeText(
      ref.display_text || ref.excerpt || ref.note || `${normalizeText(ref.source_type, 60)} ${normalizeText(ref.url, 160)}`.trim(),
      280,
    );
    if (!displayText) continue;
    out.push({
      source_type: normalizeText(ref.source_type, 80) || 'unknown',
      display_text: displayText,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeWhyCandidate(whyCandidate) {
  if (Array.isArray(whyCandidate)) {
    const reasons = whyCandidate.map((x) => normalizeText(x, 180)).filter(Boolean).slice(0, 3);
    return {
      summary: reasons[0] || '',
      reasons_user_visible: reasons,
      boundary_user_visible: '',
    };
  }
  const obj = isPlainObject(whyCandidate) ? whyCandidate : {};
  return {
    summary: normalizeText(obj.summary, 220),
    reasons_user_visible: safeArray(obj.reasons_user_visible).map((x) => normalizeText(x, 180)).filter(Boolean).slice(0, 4),
    boundary_user_visible: normalizeText(obj.boundary_user_visible, 220),
  };
}

function buildSanitizedPrelabelInput({ anchor, block, candidate, allowSameBrandCompetitors = false, allowSameBrandDupes = false } = {}) {
  const cand = isPlainObject(candidate) ? candidate : {};
  const why = normalizeWhyCandidate(cand.why_candidate);
  const social = isPlainObject(cand.social_summary_user_visible) ? cand.social_summary_user_visible : {};
  const out = {
    anchor: {
      brand: normalizeText(anchor?.brand, 120) || null,
      category: normalizeText(anchor?.category, 180) || null,
      use_case: normalizeText(anchor?.use_case, 180) || null,
      price: anchor?.price ?? null,
      ingredients: safeArray(anchor?.ingredients).map((x) => normalizeText(x, 80)).filter(Boolean).slice(0, 12),
      skin_fit: safeArray(anchor?.skin_fit).map((x) => normalizeText(x, 80)).filter(Boolean).slice(0, 8),
    },
    candidate: {
      product_id: normalizeText(cand.product_id || cand.sku_id || cand.id || cand.name, 200) || null,
      brand: normalizeText(cand.brand || cand.brand_name || cand.brand_id, 120) || null,
      category: normalizeText(cand.category || cand.category_taxonomy, 180) || null,
      use_case: normalizeText(cand.use_case || cand.goal, 180) || null,
      price: cand.price ?? null,
      price_band: normalizeText(cand.price_band, 50) || 'unknown',
      source: {
        type: normalizeText(cand?.source?.type || cand.source_type, 80) || 'unknown',
      },
      why_candidate: why,
      score_breakdown: isPlainObject(cand.score_breakdown) ? cand.score_breakdown : {},
      social_summary_user_visible: {
        themes: safeArray(social.themes).map((x) => normalizeText(x, 80)).filter(Boolean).slice(0, 3),
        top_keywords: safeArray(social.top_keywords).map((x) => normalizeText(x, 60)).filter(Boolean).slice(0, 6),
        sentiment_hint: normalizeText(social.sentiment_hint, 180) || null,
        volume_bucket: normalizeText(social.volume_bucket, 32) || 'unknown',
      },
      evidence_refs: sanitizeEvidenceRefs(cand),
    },
    block_context: {
      block_type: normalizeBlock(block),
      allow_same_brand_competitors: Boolean(allowSameBrandCompetitors),
      allow_same_brand_dupes: Boolean(allowSameBrandDupes),
      tau_cat: 0.55,
      tau_dupe: 0.82,
      tau_price_dupe: 1.0,
    },
  };
  return out;
}

function deriveInitialFlags({ block, sanitizedInput }) {
  const out = [];
  const candidate = sanitizedInput?.candidate || {};
  const missingCategory = !normalizeText(candidate?.category, 120);
  const missingPrice = candidate?.price == null || !Number.isFinite(Number(candidate?.price?.amount ?? candidate?.price));
  if (missingCategory) out.push('needs_category_check');
  if (normalizeBlock(block) === 'dupes' && missingPrice) out.push('needs_price_check');
  const socialThemes = safeArray(candidate?.social_summary_user_visible?.themes);
  if (!socialThemes.length) out.push('low_social_signal');
  return uniqStrings(out, 8);
}

function buildPrelabelInputHash({ sanitizedInput, block, modelName, promptVersion }) {
  const payload = {
    block: normalizeBlock(block),
    model_name: normalizeText(modelName, 120),
    prompt_version: normalizeText(promptVersion, 120),
    input: sanitizedInput,
  };
  return hashSha256Hex(stableStringify(payload));
}

function buildRepairPrompt(rawText) {
  return [
    'Fix this output into STRICT JSON object only.',
    'Required schema keys: suggested_label, wrong_block_target, confidence, rationale_user_visible, flags.',
    'No markdown. No extra prose.',
    'Original output:',
    String(rawText || '').slice(0, 4000),
  ].join('\n');
}

function buildKbKeyFromAnchor(anchorProductId, lang = 'EN') {
  const anchor = normalizeText(anchorProductId, 200);
  if (!anchor) return '';
  const langCode = normalizeLang(lang);
  return normalizeProductIntelKbKey(`product:${anchor}|lang:${langCode}`);
}

async function resolveSnapshotPayload({ anchorProductId, snapshotPayload, lang = 'EN' } = {}) {
  if (isPlainObject(snapshotPayload)) return snapshotPayload;
  const kbKey = buildKbKeyFromAnchor(anchorProductId, lang);
  if (!kbKey) return null;
  const kbEntry = await getProductIntelKbEntry(kbKey);
  if (!isPlainObject(kbEntry?.analysis)) return null;
  return kbEntry.analysis;
}

function extractPrelabelCandidatesFromPayload(payload, blocks, maxPerBlock) {
  const out = {};
  for (const block of blocks) {
    const max = Math.max(1, Math.min(30, Number(maxPerBlock?.[block]) || 10));
    out[block] = blockCandidates(payload, block).slice(0, max);
  }
  return out;
}

async function generatePrelabelsForAnchor({
  anchor_product_id,
  blocks = BLOCKS,
  max_candidates_per_block = {},
  force_refresh = false,
  snapshot_payload = null,
  lang = 'EN',
  request_id = '',
  session_id = '',
  logger,
  model_name = process.env.AURORA_BFF_RECO_PRELABEL_MODEL || 'gemini-2.0-flash',
  prompt_version = PRELABEL_PROMPT_VERSION,
  allow_same_brand_competitors = false,
  allow_same_brand_dupes = false,
  ttl_ms = Number(process.env.AURORA_BFF_RECO_PRELABEL_CACHE_TTL_MS || 86400000),
  gemini_timeout_ms = Number(process.env.AURORA_BFF_RECO_PRELABEL_TIMEOUT_MS || 5000),
} = {}) {
  const blockList = uniqStrings(blocks.map((b) => normalizeBlock(b)).filter(Boolean), 3);
  const payload = await resolveSnapshotPayload({
    anchorProductId: anchor_product_id,
    snapshotPayload: snapshot_payload,
    lang,
  });
  const fallbackAnchorId = normalizeText(anchor_product_id, 200);
  const { anchor_product_id: resolvedAnchorId, anchor } = pickAnchorFromPayload(payload || {}, fallbackAnchorId);
  const candidatesByBlock = extractPrelabelCandidatesFromPayload(payload || {}, blockList, max_candidates_per_block);
  const output = {
    ok: true,
    anchor_product_id: resolvedAnchorId || fallbackAnchorId,
    prompt_version: normalizeText(prompt_version, 120) || PRELABEL_PROMPT_VERSION,
    model_name: normalizeText(model_name, 120),
    force_refresh: force_refresh === true,
    generated_count: 0,
    cache_hit_count: 0,
    candidates_total: 0,
    gemini_latency_ms: [],
    requested_by_block: {
      competitors: 0,
      dupes: 0,
      related_products: 0,
    },
    generated_by_block: {
      competitors: 0,
      dupes: 0,
      related_products: 0,
    },
    cache_hit_by_block: {
      competitors: 0,
      dupes: 0,
      related_products: 0,
    },
    invalid_json_by_block: {
      competitors: 0,
      dupes: 0,
      related_products: 0,
    },
    suggestions_by_block: {
      competitors: [],
      dupes: [],
      related_products: [],
    },
    errors: [],
  };

  for (const block of blockList) {
    const rows = safeArray(candidatesByBlock?.[block]);
    output.candidates_total += rows.length;
    output.requested_by_block[block] = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      const candidate = rows[i];
      const candidateProductId = pickCandidateId(candidate, i);
      const sanitizedInput = buildSanitizedPrelabelInput({
        anchor,
        block,
        candidate,
        allowSameBrandCompetitors: allow_same_brand_competitors,
        allowSameBrandDupes: allow_same_brand_dupes,
      });
      const inputHash = buildPrelabelInputHash({
        sanitizedInput,
        block,
        modelName: output.model_name,
        promptVersion: output.prompt_version,
      });
      let record = null;
      if (!force_refresh) {
        record = await getSuggestionByInputHash({
          inputHash,
          modelName: output.model_name,
          promptVersion: output.prompt_version,
          block,
          ttlMs: ttl_ms,
        });
      }
      if (record) {
        output.cache_hit_count += 1;
        output.cache_hit_by_block[block] += 1;
        output.suggestions_by_block[block].push(record);
        continue;
      }

      const initialFlags = deriveInitialFlags({ block, sanitizedInput });
      const systemPrompt = buildPrelabelSystemPrompt();
      const userPrompt = buildPrelabelUserPrompt(sanitizedInput);
      let result = null;
      try {
        result = await callGeminiPrelabel({
          systemPrompt,
          userPrompt,
          timeoutMs: gemini_timeout_ms,
          model: output.model_name,
          logger,
        });
        if (Number.isFinite(Number(result?.latency_ms))) output.gemini_latency_ms.push(Number(result.latency_ms));
      } catch (err) {
        output.errors.push(`gemini_call_failed:${normalizeText(err?.code || err?.message || 'unknown', 120)}`);
      }

      let normalized = validateAndNormalizePrelabelOutput(result?.text || '');
      if (!normalized.ok) {
        try {
          const repair = await callGeminiPrelabel({
            systemPrompt,
            userPrompt: buildRepairPrompt(result?.text || ''),
            timeoutMs: gemini_timeout_ms,
            model: output.model_name,
            logger,
          });
          if (Number.isFinite(Number(repair?.latency_ms))) output.gemini_latency_ms.push(Number(repair.latency_ms));
          normalized = validateAndNormalizePrelabelOutput(repair?.text || '');
          if (!normalized.ok) {
            normalized = {
              ok: true,
              errors: ['invalid_json'],
              value: fallbackInvalidJson(['invalid_json']),
            };
          }
        } catch (err) {
          normalized = {
            ok: true,
            errors: ['invalid_json'],
            value: fallbackInvalidJson(['invalid_json']),
          };
        }
      }

      const suggestionValue = normalized.value || fallbackInvalidJson(['invalid_json']);
      const flags = uniqStrings([...(suggestionValue.flags || []), ...initialFlags], 16);
      const saved = await upsertSuggestion({
        anchor_product_id: output.anchor_product_id,
        block,
        candidate_product_id: candidateProductId,
        suggested_label: suggestionValue.suggested_label,
        wrong_block_target: suggestionValue.wrong_block_target,
        confidence: suggestionValue.confidence,
        rationale_user_visible: suggestionValue.rationale_user_visible,
        flags,
        model_name: output.model_name,
        prompt_version: output.prompt_version,
        input_hash: inputHash,
        request_id,
        session_id,
        snapshot: {
          candidate: {
            product_id: candidateProductId,
            score_breakdown: isPlainObject(candidate?.score_breakdown) ? candidate.score_breakdown : {},
            category: candidate?.category || candidate?.category_taxonomy || null,
            price: candidate?.price ?? null,
            price_band: candidate?.price_band || 'unknown',
          },
          block,
          was_exploration_slot: candidate?.was_exploration_slot === true,
        },
      });
      output.generated_count += 1;
      output.generated_by_block[block] += 1;
      if (flags.some((x) => x === 'invalid_json')) output.invalid_json_by_block[block] += 1;
      output.suggestions_by_block[block].push(saved);
    }
  }
  return output;
}

async function loadSuggestionsForAnchor({ anchor_product_id, block = '', limit = 200 } = {}) {
  return getSuggestionsByAnchor({
    anchorProductId: anchor_product_id,
    block: normalizeBlock(block),
    limit,
  });
}

module.exports = {
  PRELABEL_BLOCKS: BLOCKS,
  buildSanitizedPrelabelInput,
  buildPrelabelInputHash,
  extractPrelabelCandidatesFromPayload,
  generatePrelabelsForAnchor,
  loadSuggestionsForAnchor,
  __internal: {
    stableStringify,
    hashSha256Hex,
    deriveInitialFlags,
    buildRepairPrompt,
    buildKbKeyFromAnchor,
    resolveSnapshotPayload,
  },
};
