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
    return {
      payload: { assessment: null, evidence: null, confidence: null, missing_info: ['upstream_missing_or_unstructured'] },
      field_missing: [{ field: 'assessment', reason: 'upstream_missing_or_unstructured' }],
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

function normalizeDupeCompare(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    return {
      payload: { tradeoffs: [], evidence: null, confidence: null, missing_info: ['upstream_missing_or_unstructured'] },
      field_missing: [{ field: 'tradeoffs', reason: 'upstream_missing_or_unstructured' }],
    };
  }

  const field_missing = [];

  const tradeoffs = asStringArray(o.tradeoffs);
  if (!tradeoffs.length) field_missing.push({ field: 'tradeoffs', reason: 'upstream_missing_or_empty' });

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  if (evOut.evidence.missing_info?.length) missing_info.push(...evOut.evidence.missing_info);

  return {
    payload: { tradeoffs, evidence: evOut.evidence, confidence, missing_info: uniqueStrings(missing_info) },
    field_missing,
  };
}

function normalizeRecoGenerate(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    return {
      payload: { recommendations: [], evidence: null, confidence: null, missing_info: ['upstream_missing_or_unstructured'] },
      field_missing: [{ field: 'recommendations', reason: 'upstream_missing_or_unstructured' }],
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
  normalizeDupeCompare,
  normalizeRecoGenerate,
};

