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

function pickHeroIngredientFromEvidence(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence);
  if (!ev) return null;
  const science = asPlainObject(ev.science) || {};
  const keyIngredients = asStringArray(science.key_ingredients ?? science.keyIngredients);
  if (!keyIngredients.length) return null;

  const candidates = keyIngredients
    .map((s) => (typeof s === 'string' ? s.trim() : String(s || '').trim()))
    .filter(Boolean)
    .filter((s) => !/^water$/i.test(s));
  if (!candidates.length) return null;

  const rules = [
    {
      tokens: ['tretinoin', 'adapalene', 'retinal', 'retinol'],
      role: { EN: 'retinoid', CN: '维A类' },
      why: {
        EN: 'Most effective for long-term texture/lines, but can be irritating—ramp slowly.',
        CN: '对长期纹理/抗老最有效，但刺激性可能更高——需要循序渐进。',
      },
    },
    {
      tokens: ['benzoyl peroxide'],
      role: { EN: 'anti-acne active', CN: '抗痘活性' },
      why: {
        EN: 'Can be very effective for inflammatory acne, but often drying/irritating—use carefully.',
        CN: '对炎症痘通常很有效，但容易干燥/刺激——需要谨慎使用。',
      },
    },
    {
      tokens: ['salicylic acid', 'bha', 'beta hydroxy'],
      role: { EN: 'exfoliant (BHA)', CN: '去角质（BHA）' },
      why: {
        EN: 'Helpful for pores/comedones by exfoliating inside the pore; irritation risk depends on strength/frequency.',
        CN: '对毛孔/闭口有帮助（可深入毛孔去角质）；刺激风险取决于浓度与频率。',
      },
    },
    {
      tokens: ['glycolic acid', 'aha', 'lactic acid', 'mandelic acid'],
      role: { EN: 'exfoliant (AHA)', CN: '去角质（AHA）' },
      why: {
        EN: 'Improves texture/dullness via exfoliation, but can increase sensitivity—start low and slow.',
        CN: '通过去角质改善粗糙/暗沉，但可能增加敏感——建议低频起步。',
      },
    },
    {
      tokens: ['azelaic acid'],
      role: { EN: 'multi-benefit active', CN: '多效活性' },
      why: {
        EN: 'Often useful for redness/bumps/pigmentation with a gentler profile than many acids (still patch test).',
        CN: '常用于泛红/闭口/色沉，相对更温和（但仍建议先做测试）。',
      },
    },
    {
      tokens: ['niacinamide'],
      role: { EN: 'multi-benefit active', CN: '多效活性' },
      why: {
        EN: 'Supports barrier function and can help oiliness/uneven tone in some users.',
        CN: '支持屏障功能，并可能改善出油/肤色不均（因人而异）。',
      },
    },
    {
      tokens: ['tranexamic acid'],
      role: { EN: 'brightening active', CN: '淡斑活性' },
      why: {
        EN: 'Targets discoloration/dark spots; usually well tolerated.',
        CN: '针对色沉/斑点；通常耐受性较好。',
      },
    },
    {
      tokens: ['ascorbic acid', 'vitamin c'],
      role: { EN: 'antioxidant (vitamin C)', CN: '抗氧化（维C）' },
      why: {
        EN: 'Can help brighten and protect from oxidative stress; irritation depends on form and strength.',
        CN: '可提亮并抗氧化；刺激性取决于维C形式与浓度。',
      },
    },
    {
      tokens: ['ceramide', 'ceramides'],
      role: { EN: 'barrier lipid', CN: '屏障脂质' },
      why: {
        EN: 'Supports barrier lipids and can improve tolerance/hydration over time.',
        CN: '补充屏障脂质，长期可提升耐受与保湿。',
      },
    },
    {
      tokens: ['petrolatum', 'petroleum jelly'],
      role: { EN: 'occlusive', CN: '封闭剂' },
      why: {
        EN: 'A strong occlusive that reduces water loss—often the main driver behind “barrier protection” feel.',
        CN: '强封闭成分，可减少水分流失——通常是“屏障保护感”的主要来源。',
      },
    },
    {
      tokens: ['panthenol'],
      role: { EN: 'soothing (pro‑vitamin B5)', CN: '舒缓（维B5前体）' },
      why: {
        EN: 'Helps soothe irritation and supports barrier comfort.',
        CN: '帮助舒缓刺激，并提升屏障舒适度。',
      },
    },
    {
      tokens: ['glycerin'],
      role: { EN: 'humectant', CN: '保湿剂' },
      why: {
        EN: 'A well-studied humectant that draws water into the skin to improve hydration.',
        CN: '经典保湿剂，可吸附水分提升含水量。',
      },
    },
    {
      tokens: ['hyaluronic acid', 'sodium hyaluronate'],
      role: { EN: 'humectant', CN: '保湿剂' },
      why: {
        EN: 'Hydrates by binding water; usually low irritation.',
        CN: '通过结合水分保湿；通常刺激性较低。',
      },
    },
  ];

  const lowerCandidates = candidates.map((x) => x.toLowerCase());
  const match = rules.find((r) => r.tokens.some((t) => lowerCandidates.some((c) => c.includes(t))));
  if (!match) return null;

  const langKey = String(lang).toUpperCase() === 'CN' ? 'CN' : 'EN';
  const name = candidates.find((x) => match.tokens.some((t) => x.toLowerCase().includes(t))) || candidates[0];

  return {
    name,
    role: match.role[langKey],
    why: match.why[langKey],
    source: 'heuristic',
  };
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
  const hero = pickHeroIngredientFromEvidence(ev, { lang });

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
  if (hero) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? `最关键成分：${hero.name}（${hero.role}）— ${hero.why}`
        : `Most impactful ingredient: ${hero.name} (${hero.role}) — ${hero.why}`,
    );
  }
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

  if (!hero) {
    const keyPicks = take(keyIngredients.filter((x) => !/^water$/i.test(String(x))), 4);
    if (keyPicks.length) {
      out.push(
        String(lang).toUpperCase() === 'CN'
          ? `关键成分（证据）：${keyPicks.join('、')}`
          : `Key ingredients (from evidence): ${keyPicks.join(', ')}`,
      );
    }
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
  if (!assessment) {
    const ev = asPlainObject(p.evidence) || {};
    const science = asPlainObject(ev.science) || {};
    const social = asPlainObject(ev.social_signals || ev.socialSignals) || {};
    const evidenceLooksMissing = (() => {
      const keyIngredients = asStringArray(science.key_ingredients ?? science.keyIngredients);
      const mechanisms = asStringArray(science.mechanisms);
      const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
      const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
      const expertNotes = asStringArray(ev.expert_notes ?? ev.expertNotes);
      const positives = asStringArray(social.typical_positive ?? social.typicalPositive);
      const negatives = asStringArray(social.typical_negative ?? social.typicalNegative);
      return (
        keyIngredients.length === 0 &&
        mechanisms.length === 0 &&
        fitNotes.length === 0 &&
        riskNotes.length === 0 &&
        expertNotes.length === 0 &&
        positives.length === 0 &&
        negatives.length === 0
      );
    })();

    const reasons = [];
    if (String(lang).toUpperCase() === 'CN') {
      reasons.push('目前无法获取可靠的产品分析结果，因此结论暂时为“未知”。');
      if (evidenceLooksMissing) reasons.push('证据链缺失（成分/口碑/专家笔记未返回），无法做出有把握的评估。');
      reasons.push('你可以补充产品链接或完整成分表（INCI），我再做更准确的 Deep Scan。');
    } else {
      reasons.push('I couldn’t retrieve a reliable product analysis right now, so the verdict is “Unknown”.');
      if (evidenceLooksMissing) reasons.push('Evidence is missing (ingredients/social/expert notes were not returned), so confidence is low.');
      reasons.push('Send the product link or full INCI ingredient list and I’ll re-run a deeper scan.');
    }

    return {
      ...p,
      assessment: {
        verdict: String(lang).toUpperCase() === 'CN' ? '未知' : 'Unknown',
        reasons: uniqueStrings(reasons).slice(0, 5),
      },
    };
  }

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

  const heroExisting = assessment.hero_ingredient ?? assessment.heroIngredient ?? null;
  const hero = heroExisting && typeof heroExisting === 'object' ? heroExisting : pickHeroIngredientFromEvidence(p.evidence, { lang });

  if (hero && typeof hero === 'object' && hero.name && hero.why && Array.isArray(reasons) && reasons.length < maxReasons) {
    const heroName = String(hero.name).toLowerCase();
    const alreadyMentioned = reasons.some((r) => String(r || '').toLowerCase().includes(heroName));
    if (!alreadyMentioned) {
      const heroLine =
        String(lang).toUpperCase() === 'CN'
          ? `最关键成分：${hero.name}（${hero.role || '未知'}）— ${hero.why}`
          : `Most impactful ingredient: ${hero.name} (${hero.role || 'unknown'}) — ${hero.why}`;
      reasons.unshift(heroLine);
    }
  }

  const outAssessment = {
    ...assessment,
    ...(hero && typeof hero === 'object' ? { hero_ingredient: hero } : {}),
    reasons: uniqueStrings(reasons).slice(0, maxReasons),
  };
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
        missing_info: uniqueStrings(['upstream_missing_or_unstructured']),
        warnings: uniqueStrings(evOut.evidence?.missing_info || []),
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

  const missing_info_raw = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  const warnings_raw = uniqueStrings(
    asStringArray(o.warnings ?? o.warning ?? o.context_gaps ?? o.contextGaps ?? o.warnings_info ?? o.warningsInfo),
  );

  const warningLike = new Set([
    'routine_missing',
    'over_budget',
    'price_unknown',
    'availability_unknown',
    'recent_logs_missing',
    'itinerary_unknown',
    'analysis_missing',
    'evidence_missing',
    'upstream_missing_or_unstructured',
    'upstream_missing_or_empty',
    'alternatives_partial',
  ]);

  const warnings = uniqueStrings([
    ...warnings_raw,
    ...missing_info_raw.filter((c) => warningLike.has(String(c || '').trim())),
    ...(evOut.evidence.missing_info || []),
  ]);

  const missing_info = uniqueStrings(missing_info_raw.filter((c) => !warningLike.has(String(c || '').trim())));

  return {
    payload: {
      recommendations,
      evidence: evOut.evidence,
      confidence,
      missing_info,
      warnings,
    },
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
