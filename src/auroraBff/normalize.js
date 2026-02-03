function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(items) ? items : []) {
    const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value;
}

function asStringArray(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (typeof value === 'string') return uniqueStrings([value]);
  return [];
}

function asNumberOrNull(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function asRecordOfNumbers(value) {
  const o = asPlainObject(value);
  if (!o) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const key = String(k || '').trim();
    const n = asNumberOrNull(v);
    if (!key || n == null) continue;
    out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEvidence(raw) {
  const field_missing = [];
  const ev = asPlainObject(raw);
  if (!ev) {
    field_missing.push({ field: 'evidence', reason: 'upstream_missing_or_invalid' });
    return {
      evidence: {
        science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        confidence: null,
        missing_info: ['evidence_missing'],
      },
      field_missing,
    };
  }

  const scienceRaw = asPlainObject(ev.science);
  if (!scienceRaw) field_missing.push({ field: 'evidence.science', reason: 'upstream_missing_or_invalid' });

  const socialRaw = asPlainObject(ev.social_signals || ev.socialSignals);
  if (!socialRaw) field_missing.push({ field: 'evidence.social_signals', reason: 'upstream_missing_or_invalid' });

  const expertNotesRaw = ev.expert_notes ?? ev.expertNotes;
  const expert_notes = asStringArray(expertNotesRaw);
  if (!expert_notes.length) field_missing.push({ field: 'evidence.expert_notes', reason: 'upstream_missing_or_empty' });

  const science = {
    key_ingredients: asStringArray(scienceRaw?.key_ingredients ?? scienceRaw?.keyIngredients),
    mechanisms: asStringArray(scienceRaw?.mechanisms),
    fit_notes: asStringArray(scienceRaw?.fit_notes ?? scienceRaw?.fitNotes),
    risk_notes: asStringArray(scienceRaw?.risk_notes ?? scienceRaw?.riskNotes),
  };

  const social_signals = {
    ...(asRecordOfNumbers(socialRaw?.platform_scores ?? socialRaw?.platformScores)
      ? { platform_scores: asRecordOfNumbers(socialRaw?.platform_scores ?? socialRaw?.platformScores) }
      : {}),
    typical_positive: asStringArray(socialRaw?.typical_positive ?? socialRaw?.typicalPositive),
    typical_negative: asStringArray(socialRaw?.typical_negative ?? socialRaw?.typicalNegative),
    risk_for_groups: asStringArray(socialRaw?.risk_for_groups ?? socialRaw?.riskForGroups),
  };

  const missing_info = uniqueStrings(asStringArray(ev.missing_info ?? ev.missingInfo));
  const confidence = asNumberOrNull(ev.confidence);

  return {
    evidence: {
      science,
      social_signals,
      expert_notes,
      confidence,
      missing_info,
    },
    field_missing,
  };
}

function normalizeProductParse(raw) {
  const field_missing = [];
  const o = asPlainObject(raw);
  if (!o) {
    return {
      payload: { product: null, confidence: null, missing_info: ['upstream_missing_or_unstructured'] },
      field_missing: [{ field: 'product', reason: 'upstream_missing_or_unstructured' }],
    };
  }

  const product = asPlainObject(o.product) || null;
  if (!product) field_missing.push({ field: 'product', reason: 'upstream_missing_or_invalid' });

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));

  return {
    payload: { product, confidence, missing_info },
    field_missing,
  };
}

function normalizeProductAnalysis(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    const evOut = normalizeEvidence(null);
    return {
      payload: {
        assessment: null,
        evidence: evOut.evidence,
        confidence: null,
        missing_info: uniqueStrings(['upstream_missing_or_unstructured', ...(evOut.evidence?.missing_info || [])]),
      },
      field_missing: [{ field: 'assessment', reason: 'upstream_missing_or_unstructured' }, ...evOut.field_missing],
    };
  }

  const field_missing = [];

  const assessment = asPlainObject(o.assessment) || null;
  if (!assessment) field_missing.push({ field: 'assessment', reason: 'upstream_missing_or_invalid' });

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  if (evOut.evidence.missing_info?.length) missing_info.push(...evOut.evidence.missing_info);

  return {
    payload: {
      assessment,
      evidence: evOut.evidence,
      confidence,
      missing_info: uniqueStrings(missing_info),
    },
    field_missing,
  };
}

function isGenericReason(reason, lang) {
  const s = typeof reason === 'string' ? reason.trim() : reason == null ? '' : String(reason).trim();
  if (!s) return true;
  const lower = s.toLowerCase();

  const en = [
    'overall fit',
    'looks reasonable',
    'seems suitable',
    'seems risky',
    'broadly compatible',
    'generally compatible',
    'compatible with most',
    'works for most',
    'good fit for most',
  ];
  if (en.some((p) => lower.includes(p))) return true;

  if (String(lang || '').toUpperCase() === 'CN') {
    const cn = ['整体', '总体', '大体', '总体来看', '一般来说', '比较适合', '相对适合', '看起来还行', '大多数'];
    if (cn.some((p) => s.includes(p))) return true;
  }

  return false;
}

function buildReasonsFromEvidence(evidence, { lang = 'EN', verdict = '' } = {}) {
  const out = [];
  const ev = asPlainObject(evidence);
  if (!ev) return out;

  const evMissing = asStringArray(ev.missing_info ?? ev.missingInfo);
  if (evMissing.includes('evidence_missing')) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? '上游未返回证据详情，因此无法给出结论背后的具体理由。'
        : 'Upstream did not return evidence details, so I cannot explain the verdict beyond its label.',
    );
    return out;
  }

  const science = asPlainObject(ev.science) || {};
  const social = asPlainObject(ev.social_signals || ev.socialSignals) || {};

  const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  const mechanisms = asStringArray(science.mechanisms);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
  const keyIngredients = asStringArray(science.key_ingredients ?? science.keyIngredients);

  const positives = asStringArray(social.typical_positive ?? social.typicalPositive);
  const negatives = asStringArray(social.typical_negative ?? social.typicalNegative);
  const riskForGroups = asStringArray(social.risk_for_groups ?? social.riskForGroups);

  const expertNotes = asStringArray(ev.expert_notes ?? ev.expertNotes);

  const v = String(verdict || '').toLowerCase();
  const isNegative = v.includes('mismatch') || v.includes('avoid') || v.includes('veto') || v.includes('not');
  const isCaution = isNegative || v.includes('risky') || v.includes('caution') || v.includes('warn');

  const take = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);

  if (isCaution) {
    if (riskNotes.length) out.push(...take(riskNotes, 2));
    if (negatives.length) {
      out.push(
        String(lang).toUpperCase() === 'CN'
          ? `口碑（常见负向）：${take(negatives, 4).join('、')}`
          : `Social signals: common negatives — ${take(negatives, 4).join(', ')}`,
      );
    }
    if (riskForGroups.length) out.push(take(riskForGroups, 2).join('; '));
  }

  if (fitNotes.length) out.push(...take(fitNotes, 2));
  if (mechanisms.length) out.push(...take(mechanisms, 1));

  if (!riskNotes.length) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? '风险点：证据中未返回明确风险条目。'
        : 'No explicit risk flags were returned in the evidence.',
    );
  }

  if (positives.length) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? `口碑（常见正向）：${take(positives, 4).join('、')}`
        : `Social signals: common positives — ${take(positives, 4).join(', ')}`,
    );
  }

  const keyPicks = take(keyIngredients.filter((x) => !/^water$/i.test(String(x))), 4);
  if (keyPicks.length) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? `关键成分（证据）：${keyPicks.join('、')}`
        : `Key ingredients (from evidence): ${keyPicks.join(', ')}`,
    );
  }

  if (expertNotes.length) {
    out.push(
      String(lang).toUpperCase() === 'CN' ? `专家建议：${expertNotes[0]}` : `Expert notes: ${expertNotes[0]}`,
    );
  }

  return uniqueStrings(out);
}

function enrichProductAnalysisPayload(payload, { lang = 'EN' } = {}) {
  const p = asPlainObject(payload);
  if (!p) return payload;
  const assessment = asPlainObject(p.assessment);
  if (!assessment) return payload;

  const verdict =
    typeof assessment.verdict === 'string' ? assessment.verdict.trim() : String(assessment.verdict || '').trim();

  const existingReasons = asStringArray(assessment.reasons);
  const keptReasons = existingReasons.filter((r) => !isGenericReason(r, lang));

  const minReasons = 2;
  const maxReasons = 5;

  let reasons = keptReasons.slice();
  if (reasons.length < minReasons) {
    const derived = buildReasonsFromEvidence(p.evidence, { lang, verdict });
    for (const r of derived) {
      if (!r) continue;
      if (reasons.includes(r)) continue;
      reasons.push(r);
      if (reasons.length >= maxReasons) break;
    }
  }

  if (!reasons.length) {
    reasons = [
      String(lang).toUpperCase() === 'CN'
        ? '上游未返回可用的解释理由（仅有结论标签）。'
        : 'Upstream did not return usable reasoning (verdict label only).',
    ];
  }

  const outAssessment = { ...assessment, reasons: uniqueStrings(reasons).slice(0, maxReasons) };
  return { ...p, assessment: outAssessment };
}

function normalizeDupeCompare(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    const evOut = normalizeEvidence(null);
    return {
      payload: {
        original: null,
        dupe: null,
        tradeoffs: [],
        evidence: evOut.evidence,
        confidence: null,
        missing_info: uniqueStrings(['upstream_missing_or_unstructured', ...(evOut.evidence?.missing_info || [])]),
      },
      field_missing: [{ field: 'tradeoffs', reason: 'upstream_missing_or_unstructured' }, ...evOut.field_missing],
    };
  }

  const field_missing = [];

  const original = asPlainObject(o.original || o.original_product || o.originalProduct) || null;
  const dupe = asPlainObject(o.dupe || o.dupe_product || o.dupeProduct) || null;

  const similarityRaw = asNumberOrNull(o.similarity ?? o.similarity_score ?? o.similarityScore);
  const similarity = similarityRaw == null ? null : similarityRaw > 1 ? similarityRaw : similarityRaw * 100;

  const tradeoffs = asStringArray(o.tradeoffs);
  if (!tradeoffs.length) field_missing.push({ field: 'tradeoffs', reason: 'upstream_missing_or_empty' });

  const tradeoffsDetail = asPlainObject(o.tradeoffs_detail || o.tradeoffsDetail) || null;

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  if (evOut.evidence.missing_info?.length) missing_info.push(...evOut.evidence.missing_info);

  return {
    payload: {
      original,
      dupe,
      ...(similarity != null ? { similarity: Math.max(0, Math.min(100, Math.round(similarity))) } : {}),
      ...(tradeoffsDetail ? { tradeoffs_detail: tradeoffsDetail } : {}),
      tradeoffs,
      evidence: evOut.evidence,
      confidence,
      missing_info: uniqueStrings(missing_info),
    },
    field_missing,
  };
}

function normalizeRecoGenerate(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    const evOut = normalizeEvidence(null);
    return {
      payload: {
        recommendations: [],
        evidence: evOut.evidence,
        confidence: null,
        missing_info: uniqueStrings(['upstream_missing_or_unstructured', ...(evOut.evidence?.missing_info || [])]),
      },
      field_missing: [{ field: 'recommendations', reason: 'upstream_missing_or_unstructured' }, ...evOut.field_missing],
    };
  }

  const field_missing = [];

  const recommendations = Array.isArray(o.recommendations) ? o.recommendations : [];
  if (!recommendations.length) field_missing.push({ field: 'recommendations', reason: 'upstream_missing_or_empty' });

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  if (evOut.evidence.missing_info?.length) missing_info.push(...evOut.evidence.missing_info);

  return {
    payload: { recommendations, evidence: evOut.evidence, confidence, missing_info: uniqueStrings(missing_info) },
    field_missing,
  };
}

module.exports = {
  normalizeEvidence,
  normalizeProductParse,
  normalizeProductAnalysis,
  enrichProductAnalysisPayload,
  normalizeDupeCompare,
  normalizeRecoGenerate,
};
