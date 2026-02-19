const {
  buildSocialSourceConfig,
  fetchCrossPlatformSocialSignals,
  buildSocialCandidateKey,
  buildSocialInputHash,
} = require('./socialSourceAdapter');
const { attachExplanations } = require('./recoScoreExplain');
const {
  extractWhitelistedSocialChannels,
  buildSocialSummaryUserVisible,
} = require('./socialSummaryUserVisible');
const {
  getProductIntelKbEntry,
  upsertProductIntelKbEntry,
  mergeProductIntelKbAnalysis,
} = require('./productIntelKbStore');

const socialFetchCache = new Map();
const socialFetchStats = {
  hit: 0,
  miss: 0,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value, max = 180) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.slice(0, Math.max(16, max));
}

function normalizeLang(raw) {
  return String(raw || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function uniqStrings(items, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const token = sanitizeText(raw, 64);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function cloneJson(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return Number(n.toFixed(3));
}

function buildAnchorForExplain(payload, inputAnchor, inputProfileSummary) {
  const assessment = isPlainObject(payload?.assessment) ? payload.assessment : {};
  const anchorPayload = isPlainObject(assessment.anchor_product || assessment.anchorProduct)
    ? (assessment.anchor_product || assessment.anchorProduct)
    : {};
  const anchorInput = isPlainObject(inputAnchor) ? inputAnchor : {};
  const science = isPlainObject(payload?.evidence?.science) ? payload.evidence.science : {};
  const profileSummary = isPlainObject(inputProfileSummary) ? inputProfileSummary : {};
  const profileSkinTags = uniqStrings(
    [
      profileSummary.skinType,
      profileSummary.sensitivity,
      profileSummary.barrierStatus,
      ...(Array.isArray(profileSummary.goals) ? profileSummary.goals : []),
    ],
    12,
  );
  return {
    brand_id: sanitizeText(
      anchorInput.brand_id ||
        anchorInput.brandId ||
        anchorPayload.brand_id ||
        anchorPayload.brandId ||
        anchorPayload.brand ||
        anchorPayload.brand_name ||
        '',
      120,
    ),
    category_taxonomy:
      anchorInput.category_taxonomy ||
      anchorInput.categoryTaxonomy ||
      anchorPayload.category_taxonomy ||
      anchorPayload.categoryTaxonomy ||
      anchorPayload.category ||
      null,
    price:
      anchorInput.price ||
      anchorPayload.price ||
      anchorPayload.price_value ||
      anchorPayload.priceValue ||
      null,
    ingredient_tokens: uniqStrings(Array.isArray(science.key_ingredients) ? science.key_ingredients : [], 20),
    profile_skin_tags: profileSkinTags,
  };
}

function getBlockCandidates(payload, block) {
  const blockObj = isPlainObject(payload?.[block]) ? payload[block] : {};
  return Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
}

function collectAllCandidates(payload) {
  const out = [];
  for (const block of ['competitors', 'related_products', 'dupes']) {
    const rows = getBlockCandidates(payload, block);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!isPlainObject(row)) continue;
      out.push({ block, index: i, row });
    }
  }
  return out;
}

function applySignalsToBlock(blockRows, signalMap, blockName, anchorForExplain, lang) {
  let changed = false;
  const mergedRows = (Array.isArray(blockRows) ? blockRows : []).map((row, idx) => {
    if (!isPlainObject(row)) return row;
    const key = buildSocialCandidateKey(row, idx);
    const signal = isPlainObject(signalMap[key]) ? signalMap[key] : null;
    if (!signal) return row;
    const prevRaw = isPlainObject(row.social_raw) ? row.social_raw : {};
    const mergedRaw = {
      ...prevRaw,
      ...signal,
      channels: extractWhitelistedSocialChannels({
        channels: [
          ...(Array.isArray(prevRaw.channels) ? prevRaw.channels : []),
          ...(Array.isArray(signal.channels) ? signal.channels : []),
        ],
      }),
      topic_keywords: uniqStrings(
        [
          ...(Array.isArray(prevRaw.topic_keywords) ? prevRaw.topic_keywords : []),
          ...(Array.isArray(signal.topic_keywords) ? signal.topic_keywords : []),
        ],
        12,
      ),
    };
    const next = {
      ...row,
      social_raw: mergedRaw,
    };
    changed = true;
    return next;
  });

  if (!changed) {
    return {
      changed: false,
      candidates: blockRows,
    };
  }

  const explained = attachExplanations(blockName, anchorForExplain, mergedRows, {
    lang,
    max_evidence_refs: 6,
  });
  return {
    changed: true,
    candidates: explained,
  };
}

function toPlatformLabel(channel) {
  const token = String(channel || '').trim().toLowerCase();
  if (token === 'reddit') return 'Reddit';
  if (token === 'xiaohongshu') return 'Xiaohongshu';
  if (token === 'tiktok') return 'TikTok';
  if (token === 'youtube') return 'YouTube';
  if (token === 'instagram') return 'Instagram';
  return token || 'Unknown';
}

function buildSocialEvidencePatch(existingEvidence, rowsByBlock, { lang = 'EN', channelsUsed = [] } = {}) {
  const sourceRows = [
    ...getBlockCandidates(rowsByBlock, 'competitors'),
    ...getBlockCandidates(rowsByBlock, 'related_products'),
    ...getBlockCandidates(rowsByBlock, 'dupes'),
  ];
  const themePool = [];
  const keywordPool = [];
  const sentimentPool = [];
  const platformScoreAgg = new Map();

  for (const row of sourceRows) {
    if (!isPlainObject(row)) continue;
    const summary = isPlainObject(row.social_summary_user_visible) ? row.social_summary_user_visible : null;
    if (summary) {
      themePool.push(...(Array.isArray(summary.themes) ? summary.themes : []));
      keywordPool.push(...(Array.isArray(summary.top_keywords) ? summary.top_keywords : []));
      if (typeof summary.sentiment_hint === 'string' && summary.sentiment_hint.trim()) {
        sentimentPool.push(summary.sentiment_hint.trim());
      }
    } else {
      const fallbackSummary = buildSocialSummaryUserVisible(row.social_raw, { lang });
      if (fallbackSummary) {
        themePool.push(...(Array.isArray(fallbackSummary.themes) ? fallbackSummary.themes : []));
        keywordPool.push(...(Array.isArray(fallbackSummary.top_keywords) ? fallbackSummary.top_keywords : []));
        if (typeof fallbackSummary.sentiment_hint === 'string' && fallbackSummary.sentiment_hint.trim()) {
          sentimentPool.push(fallbackSummary.sentiment_hint.trim());
        }
      }
    }
    const socialRaw = isPlainObject(row.social_raw) ? row.social_raw : {};
    const channels = extractWhitelistedSocialChannels(socialRaw);
    const strength = clamp01(socialRaw.co_mention_strength ?? socialRaw.context_match ?? socialRaw.contextMatch);
    for (const channel of channels) {
      const key = toPlatformLabel(channel);
      const current = platformScoreAgg.get(key) || { sum: 0, count: 0 };
      current.sum += strength == null ? 0.5 : strength;
      current.count += 1;
      platformScoreAgg.set(key, current);
    }
  }

  const platformScores = {};
  for (const [platform, scoreObj] of platformScoreAgg.entries()) {
    if (!scoreObj.count) continue;
    platformScores[platform] = Number((scoreObj.sum / scoreObj.count).toFixed(3));
  }

  const themes = uniqStrings(themePool, 6);
  const keywords = uniqStrings(keywordPool, 8);
  const locale = normalizeLang(lang);
  const sentimentNote = sentimentPool[0] || '';
  const positive = themes.slice(0, 3);
  const negative = sentimentNote && /(cautious|risk|谨慎|风险)/i.test(sentimentNote) ? ['tolerance watch'] : [];
  const riskForGroups = sentimentNote && /(cautious|risk|谨慎|风险)/i.test(sentimentNote)
    ? [locale === 'CN' ? '敏感肌需观察耐受' : 'Sensitive skin should monitor tolerance']
    : [];
  const existing = isPlainObject(existingEvidence) ? existingEvidence : {};
  return {
    ...existing,
    social_signals: {
      ...(Object.keys(platformScores).length ? { platform_scores: platformScores } : {}),
      typical_positive: positive,
      typical_negative: negative,
      risk_for_groups: riskForGroups,
      ...(channelsUsed.length ? { channels_used: channelsUsed } : {}),
    },
  };
}

function getSocialFetchCacheEntry(inputHash) {
  const key = String(inputHash || '').trim();
  if (!key) return null;
  const entry = socialFetchCache.get(key);
  if (!entry) return null;
  if (Number(entry.expires_at_ms || 0) <= Date.now()) {
    socialFetchCache.delete(key);
    return null;
  }
  return entry;
}

function pruneSocialFetchCache(maxEntries = 500) {
  while (socialFetchCache.size > maxEntries) {
    const oldestKey = socialFetchCache.keys().next().value;
    if (!oldestKey) break;
    socialFetchCache.delete(oldestKey);
  }
}

function recordSocialCacheHit(hit) {
  if (hit) socialFetchStats.hit += 1;
  else socialFetchStats.miss += 1;
}

function getSocialEnrichCacheStats() {
  const total = socialFetchStats.hit + socialFetchStats.miss;
  return {
    hit: socialFetchStats.hit,
    miss: socialFetchStats.miss,
    hit_rate: total > 0 ? socialFetchStats.hit / total : 0,
  };
}

async function fetchSignalsWithCache({
  adapterInput,
  logger,
  fetchFn,
} = {}) {
  const ttlMs = buildSocialSourceConfig(process.env).ttl_ms;
  const inputHash = buildSocialInputHash(adapterInput);
  const cacheEntry = getSocialFetchCacheEntry(inputHash);
  if (cacheEntry?.result) {
    recordSocialCacheHit(true);
    return {
      ...cacheEntry.result,
      input_hash: inputHash,
      from_cache: true,
    };
  }
  if (cacheEntry?.promise) {
    recordSocialCacheHit(true);
    const awaited = await cacheEntry.promise;
    return {
      ...awaited,
      input_hash: inputHash,
      from_cache: true,
    };
  }
  recordSocialCacheHit(false);

  const requestPromise = Promise.resolve()
    .then(() =>
      typeof fetchFn === 'function'
        ? fetchFn(adapterInput)
        : fetchCrossPlatformSocialSignals(adapterInput),
    )
    .catch((err) => {
      logger?.warn?.(
        { err: err?.message || String(err) },
        'aurora bff: social enrich fetch failed',
      );
      return {
        ok: false,
        reason: 'upstream_error',
        signals_by_key: {},
        channels_used: [],
      };
    });
  socialFetchCache.set(inputHash, {
    promise: requestPromise,
    expires_at_ms: Date.now() + ttlMs,
  });
  pruneSocialFetchCache();

  const result = await requestPromise;
  socialFetchCache.set(inputHash, {
    result,
    expires_at_ms: Date.now() + ttlMs,
  });
  pruneSocialFetchCache();
  return {
    ...result,
    input_hash: inputHash,
    from_cache: false,
  };
}

function mergeSocialPatchIntoPayload(payload, patch) {
  const base = isPlainObject(payload) ? cloneJson(payload) : {};
  const nextPatch = isPlainObject(patch) ? patch : {};
  const next = {
    ...base,
    ...nextPatch,
  };
  for (const block of ['competitors', 'related_products', 'dupes']) {
    if (!isPlainObject(nextPatch[block])) continue;
    next[block] = {
      ...(isPlainObject(base[block]) ? base[block] : {}),
      ...(isPlainObject(nextPatch[block]) ? nextPatch[block] : {}),
    };
  }
  if (isPlainObject(nextPatch.evidence)) {
    next.evidence = {
      ...(isPlainObject(base.evidence) ? base.evidence : {}),
      ...nextPatch.evidence,
    };
  }
  if (isPlainObject(nextPatch.provenance)) {
    next.provenance = {
      ...(isPlainObject(base.provenance) ? base.provenance : {}),
      ...nextPatch.provenance,
    };
  }
  return next;
}

async function runSocialEnrichWorker(input = {}) {
  const payload = isPlainObject(input.payload) ? cloneJson(input.payload) : null;
  if (!payload) return { ok: false, reason: 'payload_missing' };

  const logger = isPlainObject(input.logger) ? input.logger : null;
  const lang = normalizeLang(input.lang);
  const mode = sanitizeText(input.mode || 'main_path', 48) || 'main_path';
  const sourceConfig = buildSocialSourceConfig(process.env);
  const candidatesFlat = collectAllCandidates(payload);
  if (!candidatesFlat.length) return { ok: false, reason: 'empty_candidates' };

  const anchorForExplain = buildAnchorForExplain(payload, input.anchor_product, input.profile_summary);
  const adapterInput = {
    anchor: anchorForExplain,
    candidates: candidatesFlat.map((x) => x.row),
    lang,
    channels: sourceConfig.channels,
    timeoutMs: input.timeout_ms || sourceConfig.timeout_ms,
    logger,
  };
  const fetched = await fetchSignalsWithCache({
    adapterInput,
    logger,
    fetchFn: input.fetch_fn,
  });
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason || 'social_fetch_failed',
      from_cache: fetched.from_cache === true,
      input_hash: fetched.input_hash || null,
      fetch_status: fetched.reason || 'failed',
      channels_used: [],
    };
  }

  const signalMap = isPlainObject(fetched.signals_by_key) ? fetched.signals_by_key : {};
  if (!Object.keys(signalMap).length) {
    return {
      ok: false,
      reason: 'empty_social_signals',
      from_cache: fetched.from_cache === true,
      input_hash: fetched.input_hash || null,
      fetch_status: 'empty',
      channels_used: uniqStrings(fetched.channels_used || [], 5).map((x) => x.toLowerCase()),
    };
  }

  const currentBlocks = {
    competitors: getBlockCandidates(payload, 'competitors'),
    related_products: getBlockCandidates(payload, 'related_products'),
    dupes: getBlockCandidates(payload, 'dupes'),
  };
  const changedBlocks = [];
  const nextBlocks = {};
  for (const block of ['competitors', 'related_products', 'dupes']) {
    const applied = applySignalsToBlock(currentBlocks[block], signalMap, block, anchorForExplain, lang);
    nextBlocks[block] = applied.candidates;
    if (applied.changed) changedBlocks.push(block);
  }
  if (!changedBlocks.length) {
    return {
      ok: false,
      reason: 'no_candidate_signal_delta',
      from_cache: fetched.from_cache === true,
      input_hash: fetched.input_hash || null,
      fetch_status: 'no_delta',
      channels_used: uniqStrings(fetched.channels_used || [], 5).map((x) => x.toLowerCase()),
    };
  }

  const freshUntilMs = Date.now() + sourceConfig.ttl_ms;
  const freshUntilIso = new Date(freshUntilMs).toISOString();
  const channelsUsed = extractWhitelistedSocialChannels({
    channels: [
      ...(Array.isArray(fetched.channels_used) ? fetched.channels_used : []),
      ...Object.values(signalMap).flatMap((x) => (Array.isArray(x?.channels) ? x.channels : [])),
    ],
  });
  const existingEvidence = isPlainObject(payload.evidence) ? payload.evidence : {};
  const evidencePatch = buildSocialEvidencePatch(
    existingEvidence,
    {
      competitors: { candidates: nextBlocks.competitors },
      related_products: { candidates: nextBlocks.related_products },
      dupes: { candidates: nextBlocks.dupes },
    },
    { lang, channelsUsed },
  );
  const existingProvenance = isPlainObject(payload.provenance) ? payload.provenance : {};
  const provenancePatch = {
    ...existingProvenance,
    social_fetch_mode: 'async_refresh',
    social_fresh_until: freshUntilIso,
    social_source_version: fetched.source_version || sourceConfig.source_version,
    ...(channelsUsed.length ? { social_channels_used: channelsUsed } : {}),
  };

  const payloadPatch = {
    competitors: {
      ...(isPlainObject(payload.competitors) ? payload.competitors : {}),
      candidates: nextBlocks.competitors,
    },
    related_products: {
      ...(isPlainObject(payload.related_products) ? payload.related_products : {}),
      candidates: nextBlocks.related_products,
    },
    dupes: {
      ...(isPlainObject(payload.dupes) ? payload.dupes : {}),
      candidates: nextBlocks.dupes,
    },
    evidence: evidencePatch,
    provenance: provenancePatch,
  };

  const asyncResults = [];
  if (typeof input.apply_async_patch === 'function') {
    for (const block of changedBlocks) {
      try {
        const patchOut = input.apply_async_patch({
          block,
          next_candidates: nextBlocks[block],
        }) || {};
        const resultToken = patchOut.applied ? 'applied' : patchOut.reason === 'no_change' ? 'noop' : 'skipped';
        const changedCount = Number.isFinite(Number(patchOut.changedCount)) ? Math.max(0, Math.trunc(Number(patchOut.changedCount))) : 0;
        asyncResults.push({ block, result: resultToken, changed_count: changedCount });
        if (typeof input.on_async_update === 'function') {
          input.on_async_update({
            block,
            result: resultToken,
            changed_count: changedCount,
            mode,
          });
        }
      } catch (err) {
        logger?.warn?.(
          {
            block,
            err: err?.message || String(err),
          },
          'aurora bff: social enrich async patch failed',
        );
      }
    }
  }

  let kbBackfilled = false;
  const kbKey = sanitizeText(input.kb_key, 320);
  if (!input.skip_kb_write && kbKey) {
    try {
      const existingKb = await getProductIntelKbEntry(kbKey);
      const baseAnalysis = isPlainObject(existingKb?.analysis) ? existingKb.analysis : payload;
      const mergedAnalysis = mergeProductIntelKbAnalysis({
        existingAnalysis: baseAnalysis,
        patchAnalysis: payloadPatch,
      });
      await upsertProductIntelKbEntry({
        kb_key: kbKey,
        analysis: mergedAnalysis,
        source: sanitizeText(input.source || existingKb?.source || 'url_realtime_product_intel_social_async', 120),
        source_meta: {
          ...(isPlainObject(existingKb?.source_meta) ? existingKb.source_meta : {}),
          ...(isPlainObject(input.source_meta) ? input.source_meta : {}),
          social_async_enriched: true,
          social_input_hash: fetched.input_hash || null,
          social_source_version: fetched.source_version || sourceConfig.source_version,
          social_channels_used: channelsUsed,
          social_fetch_mode: 'async_refresh',
          social_fresh_until: freshUntilIso,
        },
        last_success_at: nowIso(),
        last_error: null,
      });
      kbBackfilled = true;
    } catch (err) {
      logger?.warn?.(
        {
          err: err?.message || String(err),
          kb_key: kbKey,
        },
        'aurora bff: social enrich kb backfill failed',
      );
    }
  }

  return {
    ok: true,
    reason: null,
    mode,
    from_cache: fetched.from_cache === true,
    input_hash: fetched.input_hash || null,
    fetch_status: 'ok',
    source_version: fetched.source_version || sourceConfig.source_version,
    channels_used: channelsUsed,
    changed_blocks: changedBlocks,
    async_updates: asyncResults,
    kb_backfilled: kbBackfilled,
    social_fresh_until: freshUntilIso,
    payload_patch: payloadPatch,
  };
}

module.exports = {
  runSocialEnrichWorker,
  getSocialEnrichCacheStats,
  __internal: {
    socialFetchCache,
    socialFetchStats,
    fetchSignalsWithCache,
    applySignalsToBlock,
    buildSocialEvidencePatch,
  },
};
