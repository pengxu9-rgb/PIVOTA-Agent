function asPlainObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value;
}

function asString(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s : null;
}

function asNumberOrNull(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => asString(v)).filter(Boolean);
  const s = asString(value);
  return s ? [s] : [];
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(items) ? items : []) {
    const s = asString(v);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeBudgetHint(value) {
  const s = asString(value);
  if (!s) return null;
  if (/¥\s*200/.test(s) || /\b200\b/.test(s) || /\blow\b/i.test(s)) return '¥200';
  if (/¥\s*500/.test(s) || /\b500\b/.test(s) || /\bmid\b/i.test(s) || /\bmedium\b/i.test(s)) return '¥500';
  if (/¥\s*1000\+/.test(s) || /1000\+/.test(s) || /\bhigh\b/i.test(s) || /\bpremium\b/i.test(s)) return '¥1000+';
  if (/不确定/.test(s) || /unknown/i.test(s) || /unsure/i.test(s)) return '不确定';
  return null;
}

function mapConcerns(goals) {
  const alias = {
    acne: 'acne (痘痘)',
    dark_spots: 'dark spots / hyperpigmentation (淡斑/痘印)',
    dullness: 'brightening (提亮/美白)',
    wrinkles: 'anti-aging (抗老/细纹)',
    aging: 'anti-aging (抗老/细纹)',
    pores: 'closed comedones / rough texture (闭口/黑头/粗糙)',
    redness: 'redness / sensitive skin (泛红敏感)',
    dehydration: 'hydration + repair (补水修护)',
    repair: 'barrier repair (屏障修护)',
    barrier: 'barrier repair (屏障修护)',
  };

  const out = [];
  for (const g of Array.isArray(goals) ? goals : []) {
    const s = asString(g);
    if (!s) continue;
    const key = s.toLowerCase();
    out.push(alias[key] || s);
  }
  return uniqueStrings(out);
}

function mapBarrierStatus(value) {
  const s = asString(value);
  const norm = (s || '').toLowerCase();
  if (['healthy', 'stable', 'ok', 'good'].includes(norm)) return 'Stable barrier (no stinging/redness) / 屏障稳定';
  if (['impaired', 'sensitive', 'reactive'].includes(norm)) return 'Impaired barrier (stinging/redness) / 刺痛泛红，屏障受损';
  if (['unknown', 'unsure', 'not sure', 'n/a'].includes(norm)) return 'Barrier status unknown (not sure) / 不确定屏障状态';
  return s || 'unknown';
}

function compactCitations(citations, max = 10) {
  const items = uniqueStrings(Array.isArray(citations) ? citations : []);
  if (!items.length) return null;
  const head = items.slice(0, max);
  const tailCount = items.length - head.length;
  return tailCount > 0 ? `${head.join(', ')} (+${tailCount} more)` : head.join(', ');
}

function mapAuroraProductParse(upstreamStructured) {
  const structured = asPlainObject(upstreamStructured);
  const parse = structured && asPlainObject(structured.parse);
  const anchor = parse && asPlainObject(parse.anchor_product || parse.anchorProduct);
  const confidence = asNumberOrNull(parse && (parse.parse_confidence ?? parse.parseConfidence));

  const kb = structured && asPlainObject(structured.kb_requirements_check || structured.kbRequirementsCheck);
  const missingFields = kb ? asStringArray(kb.missing_fields || kb.missingFields) : [];

  return {
    product: anchor || null,
    confidence,
    missing_info: missingFields,
  };
}

function mapAuroraAnalyzeToEvidence(analyze, { missingFields, kbNotes } = {}) {
  const a = asPlainObject(analyze);

  const scienceEvidence = a
    ? Array.isArray(a.science_evidence || a.scienceEvidence)
      ? (a.science_evidence || a.scienceEvidence)
      : []
    : [];

  const keyIngredients = [];
  const mechanisms = [];
  const fitNotes = [];
  const riskNotes = [];

  for (const item of scienceEvidence) {
    const e = asPlainObject(item);
    if (!e) continue;
    const key = asString(e.key);
    if (key) keyIngredients.push(key);
    const mech = asString(e.mechanism);
    if (mech) mechanisms.push(mech);
    const targets = asStringArray(e.targets);
    if (targets.length) fitNotes.push(`Targets: ${targets.join(', ')}`);
    const risks = asStringArray(e.risks);
    if (risks.length) riskNotes.push(...risks);
  }

  const social = a ? asPlainObject(a.social_signals || a.socialSignals) : null;
  const platformScores = {};
  if (social) {
    const redScore = asNumberOrNull(social.red_score ?? social.RED_score ?? social.redScore);
    const redditScore = asNumberOrNull(social.reddit_score ?? social.Reddit_score ?? social.redditScore);
    const burnRate = asNumberOrNull(social.burn_rate ?? social.burnRate);
    if (redScore != null) platformScores.RED = redScore;
    if (redditScore != null) platformScores.Reddit = redditScore;
    if (burnRate != null) platformScores.burn_rate = burnRate;
  }

  const topKeywords = social ? asStringArray(social.top_keywords || social.topKeywords) : [];

  const expertNotes = [];
  const expertRaw = a ? a.expert_notes ?? a.expertNotes : null;
  if (typeof expertRaw === 'string') {
    expertNotes.push(expertRaw);
  } else if (Array.isArray(expertRaw)) {
    expertNotes.push(...asStringArray(expertRaw));
  } else {
    const o = asPlainObject(expertRaw);
    if (o) {
      for (const key of ['chemist_notes', 'chemistNotes', 'sensitivity_flags', 'sensitivityFlags', 'key_actives', 'keyActives']) {
        const s = asString(o[key]);
        if (s) expertNotes.push(s);
      }
      const citations = compactCitations(o.citations || o.kb_citations || o.kbCitations);
      if (citations) expertNotes.push(`Citations: ${citations}`);
    }
  }

  const kbNoteLines = asStringArray(kbNotes);
  if (kbNoteLines.length) expertNotes.push(...kbNoteLines.map((n) => `KB note: ${n}`));

  if (social) {
    const burnRate = asNumberOrNull(social.burn_rate ?? social.burnRate);
    if (burnRate != null && burnRate >= 0.25) {
      riskNotes.push('Higher irritation/burn rate reported; extra caution for very sensitive skin.');
    }
  }

  const confidence = asNumberOrNull(a && a.confidence);
  const missing = uniqueStrings([...(Array.isArray(missingFields) ? missingFields : [])]);

  return {
    evidence: {
      science: {
        key_ingredients: uniqueStrings(keyIngredients),
        mechanisms: uniqueStrings(mechanisms),
        fit_notes: uniqueStrings(fitNotes),
        risk_notes: uniqueStrings(riskNotes),
      },
      social_signals: {
        ...(Object.keys(platformScores).length ? { platform_scores: platformScores } : {}),
        typical_positive: uniqueStrings(topKeywords),
        typical_negative: [],
        risk_for_groups: [],
      },
      expert_notes: uniqueStrings(expertNotes),
      confidence,
      missing_info: missing,
    },
  };
}

function mapAuroraProductAnalysis(upstreamStructured) {
  const structured = asPlainObject(upstreamStructured);
  const parse = structured && asPlainObject(structured.parse);
  const anchor = parse && asPlainObject(parse.anchor_product || parse.anchorProduct);

  const analyze = structured && asPlainObject(structured.analyze);
  const verdict = analyze ? asString(analyze.verdict) : null;
  const reasons = analyze ? asStringArray(analyze.reasons) : [];

  const kb = structured && asPlainObject(structured.kb_requirements_check || structured.kbRequirementsCheck);
  const missingFields = kb ? asStringArray(kb.missing_fields || kb.missingFields) : [];
  const kbNotes = kb ? asStringArray(kb.notes) : [];

  const assessment = {
    ...(verdict ? { verdict } : {}),
    ...(reasons.length ? { reasons } : {}),
    ...(anchor ? { anchor_product: anchor } : {}),
    ...(analyze && analyze.how_to_use != null ? { how_to_use: analyze.how_to_use } : {}),
  };

  const evidenceOut = mapAuroraAnalyzeToEvidence(analyze, { missingFields, kbNotes });

  const confidence = analyze ? asNumberOrNull(analyze.confidence) : null;

  const missing_info = uniqueStrings(missingFields);
  if (!anchor) missing_info.push('anchor_product_missing');
  if (!analyze) missing_info.push('analysis_missing');

  return {
    assessment: Object.keys(assessment).length ? assessment : null,
    evidence: evidenceOut.evidence,
    confidence,
    missing_info,
  };
}

function mapAuroraAlternativesToDupeCompare(originalStructured, dupeAnchor, { fallbackAnalyze, originalAnchorFallback } = {}) {
  const structured = asPlainObject(originalStructured);
  const parse = structured && asPlainObject(structured.parse);
  const originalAnchor = parse && asPlainObject(parse.anchor_product || parse.anchorProduct);
  const original = originalAnchor || asPlainObject(originalAnchorFallback) || null;
  const alternatives = structured && Array.isArray(structured.alternatives) ? structured.alternatives : [];

  const dupe = asPlainObject(dupeAnchor);
  const dupeSkuId = dupe ? asString(dupe.sku_id || dupe.skuId || dupe.product_id || dupe.productId) : null;
  const dupeDisplay = dupe ? asString(dupe.display_name || dupe.displayName || dupe.name) : null;
  const dupeBrand = dupe ? asString(dupe.brand) : null;

  function normName(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  let match = null;
  if (dupeSkuId) {
    match = alternatives.find((alt) => {
      const p = asPlainObject(alt && alt.product);
      const sku = p && asString(p.sku_id || p.skuId || p.product_id || p.productId);
      return sku && sku === dupeSkuId;
    }) || null;
  }

  if (!match && (dupeDisplay || dupeBrand)) {
    const want = normName(`${dupeBrand || ''}${dupeDisplay || ''}`);
    match = alternatives.find((alt) => {
      const p = asPlainObject(alt && alt.product);
      if (!p) return false;
      const cand = normName(`${p.brand || ''}${p.display_name || p.displayName || p.name || ''}`);
      return want && cand && (cand.includes(want) || want.includes(cand));
    }) || null;
  }

  if (!match && fallbackAnalyze) {
    return fallbackAnalyze();
  }

  if (!match) {
    return {
      original,
      dupe: dupe || null,
      tradeoffs: [],
      evidence: null,
      confidence: null,
      missing_info: ['dupe_not_found_in_alternatives'],
    };
  }

  const tradeoffsOut = [];
  const t = asPlainObject(match.tradeoffs);
  const missingActives = t ? uniqueStrings(asStringArray(t.missing_actives || t.missingActives)) : [];
  const addedBenefits = t ? uniqueStrings(asStringArray(t.added_benefits || t.addedBenefits)) : [];
  const textureDiff = t ? uniqueStrings(asStringArray(t.texture_finish_differences || t.textureFinishDifferences)) : [];
  const availabilityNote = t ? asString(t.availability_note || t.availabilityNote) : null;
  const priceDeltaUsd = t ? asNumberOrNull(t.price_delta_usd || t.priceDeltaUsd) : null;

  if (missingActives.length) tradeoffsOut.push(`Missing actives vs original: ${missingActives.join(', ')}`);
  if (addedBenefits.length) tradeoffsOut.push(`Added benefits/actives: ${addedBenefits.join(', ')}`);
  tradeoffsOut.push(...textureDiff);
  if (priceDeltaUsd != null) tradeoffsOut.push(`Price delta (USD): ${priceDeltaUsd}`);
  if (availabilityNote) tradeoffsOut.push(`Availability: ${availabilityNote}`);

  const similarityScore = asNumberOrNull(match.similarity_score ?? match.similarityScore);
  const confidence = similarityScore == null ? null : Math.max(0, Math.min(1, similarityScore > 1 ? similarityScore / 100 : similarityScore));

  const evidence = {
    science: {
      key_ingredients: uniqueStrings([...missingActives, ...addedBenefits]),
      mechanisms: [],
      fit_notes: uniqueStrings(textureDiff),
      risk_notes: [],
    },
    social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
    expert_notes: [],
    confidence,
    missing_info: [],
  };

  const ev = asPlainObject(match.evidence);
  const citations = compactCitations(ev && (ev.kb_citations || ev.kbCitations));
  if (citations) evidence.expert_notes.push(`Citations: ${citations}`);

  const matchProduct = asPlainObject(match.product) || null;
  const tradeoffs_detail = {
    ...(missingActives.length ? { missing_actives: missingActives } : {}),
    ...(addedBenefits.length ? { added_benefits: addedBenefits } : {}),
    ...(textureDiff.length ? { texture_finish_differences: textureDiff } : {}),
    ...(priceDeltaUsd != null ? { price_delta_usd: priceDeltaUsd } : {}),
    ...(availabilityNote ? { availability_note: availabilityNote } : {}),
  };

  return {
    original,
    dupe: matchProduct || dupe || null,
    ...(similarityScore != null ? { similarity: similarityScore } : {}),
    tradeoffs: uniqueStrings(tradeoffsOut),
    ...(Object.keys(tradeoffs_detail).length ? { tradeoffs_detail } : {}),
    evidence,
    confidence,
    missing_info: [],
  };
}

function classifyAlternativeKind(priceDeltaUsd) {
  const delta = asNumberOrNull(priceDeltaUsd);
  if (delta == null) return 'similar';
  if (delta < -0.01) return 'dupe';
  if (delta > 0.01) return 'premium';
  return 'similar';
}

function isNoisyAltNote(value) {
  const s = asString(value);
  if (!s) return true;
  const t = s.toLowerCase();
  if (t.length > 90) return true;
  if (/\b(varies|verify|percent|percentage|claim)\b/i.test(t)) return true;
  if (/\b(snapshot|estimat|estimate|approx)\b/i.test(t)) return true;
  if (/\b(e\.g\.|example|i\.e\.)\b/i.test(t)) return true;
  if (/\bby region\b/i.test(t)) return true;
  if (/\bunknown\b|\bn\/a\b/i.test(t)) return true;
  return false;
}

function splitAltNoteTokens(value) {
  const s = asString(value);
  if (!s) return [];
  return String(s)
    .replace(/\r?\n/g, ' ')
    .split(/[|·•;,]/g)
    .map((p) => p.trim())
    .filter(Boolean);
}

function cleanAltToken(value) {
  const s = asString(value);
  if (!s) return null;
  let t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;

  const cutWords = ['e.g.', 'example', 'i.e.', 'varies', 'verify', 'claim'];
  const lower = t.toLowerCase();
  for (const w of cutWords) {
    const idx = lower.indexOf(w);
    if (idx > 0) {
      t = t.slice(0, idx).trim();
      break;
    }
  }

  t = t.replace(/^(pros|优势|added benefits\/actives)[:：]\s*/i, '').trim();
  t = t.replace(/[.，,;；:\s]+$/g, '').trim();
  if (!t) return null;
  if (isNoisyAltNote(t)) return null;
  return t;
}

function pickCleanAltNotes(items, max = 6) {
  const out = [];
  const seen = new Set();
  outer: for (const raw of Array.isArray(items) ? items : []) {
    const tokens = splitAltNoteTokens(raw);
    if (!tokens.length) continue;
    for (const token of tokens) {
      const cleaned = cleanAltToken(token);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
      if (out.length >= max) break outer;
    }
  }
  return out;
}

function describeActiveBenefit(token, language) {
  const t = asString(token);
  if (!t) return null;
  const s = t.toLowerCase();
  if (s.includes('niacinamide') || s.includes('nicotinamide')) return language === 'CN' ? '控油/均匀肤色' : 'oil-control + tone-evening';
  if (s.includes('panthenol') || /\bb5\b/.test(s)) return language === 'CN' ? '修护/舒缓' : 'barrier support + soothing';
  if (s.includes('hyal') || /\bha\b/.test(s)) return language === 'CN' ? '补水' : 'hydration';
  if (s.includes('ceramide')) return language === 'CN' ? '屏障脂质修护' : 'barrier lipid support';
  if (s.includes('allantoin')) return language === 'CN' ? '舒缓' : 'soothing';
  if (s.includes('pha')) return language === 'CN' ? '温和去角质' : 'gentle exfoliation';
  if (s.includes('salicy') || s.includes('bha')) return language === 'CN' ? '疏通毛孔' : 'pore unclogging';
  if (s.includes('glycolic') || s.includes('aha') || s.includes('lactic')) return language === 'CN' ? '去角质/提亮' : 'exfoliation/brightening';
  if (s.includes('zinc pca')) return language === 'CN' ? '控油' : 'oil-control';
  if (s.includes('peptide')) return language === 'CN' ? '抗老/紧致倾向' : 'anti-aging/firming';
  return null;
}

function mapAuroraAlternativesToRecoAlternatives(alternatives, { lang = 'EN', maxTotal = 3 } = {}) {
  const items = Array.isArray(alternatives) ? alternatives : [];
  const language = String(lang).toUpperCase() === 'CN' ? 'CN' : 'EN';
  const limit = Math.max(0, Math.min(6, Number.isFinite(Number(maxTotal)) ? Math.trunc(Number(maxTotal)) : 3));
  if (!items.length || limit <= 0) return [];

  const mapped = [];
  for (const alt of items) {
    const a = asPlainObject(alt);
    if (!a) continue;

    const product = asPlainObject(a.product) || null;
    if (!product) continue;

    const similarityRaw = asNumberOrNull(a.similarity_score ?? a.similarityScore ?? a.similarity);
    const similarityPct = similarityRaw == null ? null : similarityRaw > 1 ? similarityRaw : similarityRaw * 100;
    const similarity = similarityPct == null ? null : Math.max(0, Math.min(100, Math.round(similarityPct)));

    const t = asPlainObject(a.tradeoffs);
    const missingActives = t ? uniqueStrings(asStringArray(t.missing_actives || t.missingActives)) : [];
    const addedBenefitsRaw = t ? uniqueStrings(asStringArray(t.added_benefits || t.addedBenefits)) : [];
    const addedBenefits = pickCleanAltNotes(addedBenefitsRaw, 8);
    const textureDiff = t ? uniqueStrings(asStringArray(t.texture_finish_differences || t.textureFinishDifferences)) : [];
    const availabilityNote = t ? asString(t.availability_note || t.availabilityNote) : null;
    const priceDeltaUsd = t ? asNumberOrNull(t.price_delta_usd || t.priceDeltaUsd) : null;

    const kind = classifyAlternativeKind(priceDeltaUsd);

    const tradeoffs = [];
    if (missingActives.length) {
      tradeoffs.push(
        language === 'CN'
          ? `相比原产品缺少活性：${missingActives.join('、')}`
          : `Missing actives vs original: ${missingActives.join(', ')}`,
      );
    }
    if (addedBenefits.length) {
      tradeoffs.push(
        language === 'CN'
          ? `新增亮点/活性：${addedBenefits.join('、')}`
          : `Added benefits/actives: ${addedBenefits.join(', ')}`,
      );
    }
    tradeoffs.push(...textureDiff);
    if (priceDeltaUsd != null) {
      const abs = Math.round(Math.abs(priceDeltaUsd) * 100) / 100;
      const priceLine =
        priceDeltaUsd < -0.01
          ? language === 'CN'
            ? `价格通常更低（USD 价差约：-$${abs}）`
            : `Usually cheaper (USD delta: -$${abs})`
          : priceDeltaUsd > 0.01
            ? language === 'CN'
              ? `价格通常更高（USD 价差约：+$${abs}）`
              : `Usually more expensive (USD delta: +$${abs})`
            : language === 'CN'
              ? '价格大致相近（USD 价差约：$0）'
              : 'Price is roughly similar (USD delta: ~$0)';
      tradeoffs.push(priceLine);
    }
    if (availabilityNote) {
      tradeoffs.push(language === 'CN' ? `可得性：${availabilityNote}` : `Availability: ${availabilityNote}`);
    }

    const upstreamReasons = pickCleanAltNotes(asStringArray(a.reasons || a.why || a.rationale), 2);
    const reasons = [...upstreamReasons];
    if (!reasons.length && addedBenefits.length) {
      const top = addedBenefits[0];
      const benefit = describeActiveBenefit(top, language);
      reasons.push(
        language === 'CN'
          ? `优势：新增${top}${benefit ? `（${benefit}）` : ''}`
          : `Pros: adds ${top}${benefit ? ` (${benefit})` : ''}`,
      );
    }
    if (priceDeltaUsd != null && priceDeltaUsd < -0.01 && reasons.length < 2) {
      const abs = Math.round(Math.abs(priceDeltaUsd) * 100) / 100;
      reasons.push(language === 'CN' ? `优势：通常更省预算（约省 $${abs}）` : `Pros: Usually cheaper (save ~$${abs})`);
    }
    if (availabilityNote && reasons.length < 2) {
      reasons.push(language === 'CN' ? `优势：更容易买到（${availabilityNote}）` : `Pros: Easier to find (${availabilityNote})`);
    }
    if (!reasons.length && textureDiff.length) {
      reasons.push(language === 'CN' ? `优势：肤感/质地差异：${textureDiff[0]}` : `Pros: Texture/finish: ${textureDiff[0]}`);
    }

    const confidence = similarity == null ? null : Math.max(0, Math.min(1, similarity / 100));

    const evidence = {
      science: {
        key_ingredients: uniqueStrings([...missingActives, ...addedBenefits]),
        mechanisms: [],
        fit_notes: uniqueStrings(textureDiff),
        risk_notes: [],
      },
      social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
      expert_notes: [],
      confidence,
      missing_info: [],
    };

    const ev = asPlainObject(a.evidence);
    const citations = compactCitations(ev && (ev.kb_citations || ev.kbCitations));
    if (citations) evidence.expert_notes.push(language === 'CN' ? `引用：${citations}` : `Citations: ${citations}`);

    const tradeoffs_detail = {
      ...(missingActives.length ? { missing_actives: missingActives } : {}),
      ...(addedBenefits.length ? { added_benefits: addedBenefits } : {}),
      ...(textureDiff.length ? { texture_finish_differences: textureDiff } : {}),
      ...(priceDeltaUsd != null ? { price_delta_usd: priceDeltaUsd } : {}),
      ...(availabilityNote ? { availability_note: availabilityNote } : {}),
    };

    const missing_info = [];
    if (priceDeltaUsd == null) missing_info.push('price_delta_unknown');
    if (!t) missing_info.push('tradeoffs_detail_missing');

    mapped.push({
      kind,
      product,
      ...(similarity != null ? { similarity } : {}),
      ...(reasons.length ? { reasons: uniqueStrings(reasons).slice(0, 2) } : {}),
      tradeoffs: uniqueStrings(tradeoffs),
      ...(Object.keys(tradeoffs_detail).length ? { tradeoffs_detail } : {}),
      evidence,
      confidence,
      missing_info: uniqueStrings(missing_info),
    });
  }

  if (!mapped.length) return [];

  const sorted = [...mapped].sort((a, b) => (Number(b.similarity ?? -1) || -1) - (Number(a.similarity ?? -1) || -1));
  const chosen = [];
  const usedSkus = new Set();

  const kindOrder = ['dupe', 'similar', 'premium'];
  for (const k of kindOrder) {
    const next = sorted.find((it) => String(it.kind || '').toLowerCase() === k && it.product);
    if (!next) continue;
    const sku = asString(next.product && (next.product.sku_id || next.product.skuId || next.product.product_id || next.product.productId));
    if (sku && usedSkus.has(sku)) continue;
    if (sku) usedSkus.add(sku);
    chosen.push(next);
    if (chosen.length >= limit) return chosen.slice(0, limit);
  }

  for (const it of sorted) {
    if (chosen.length >= limit) break;
    const sku = asString(it.product && (it.product.sku_id || it.product.skuId || it.product.product_id || it.product.productId));
    if (sku && usedSkus.has(sku)) continue;
    if (sku) usedSkus.add(sku);
    chosen.push(it);
  }

  return chosen.slice(0, limit);
}

function mapAuroraRoutineToRecoGenerate(contextRoutine, contextMeta) {
  const routine = asPlainObject(contextRoutine);
  const am = routine && Array.isArray(routine.am) ? routine.am : [];
  const pm = routine && Array.isArray(routine.pm) ? routine.pm : [];

  const recommendations = [];
  for (const step of am) {
    if (!asPlainObject(step)) continue;
    recommendations.push({ slot: 'am', ...step });
  }
  for (const step of pm) {
    if (!asPlainObject(step)) continue;
    recommendations.push({ slot: 'pm', ...step });
  }

  const keyIngredients = [];
  const fitNotes = [];
  const riskNotes = [];
  const expertNotes = [];
  const platformScoresAcc = {};
  const platformScoresCount = {};

  function addPlatformScore(platform, value) {
    const n = asNumberOrNull(value);
    if (n == null) return;
    const key = String(platform || '').trim();
    if (!key) return;
    platformScoresAcc[key] = (platformScoresAcc[key] || 0) + n;
    platformScoresCount[key] = (platformScoresCount[key] || 0) + 1;
  }

  function maybeCollectFromStep(step) {
    const s = asPlainObject(step);
    if (!s) return;
    fitNotes.push(...asStringArray(s.notes));

    const ep = asPlainObject(s.evidence_pack || s.evidencePack);
    if (ep) {
      keyIngredients.push(...asStringArray(ep.keyActives || ep.key_actives));
      fitNotes.push(...asStringArray(ep.comparisonNotes || ep.comparison_notes));
      riskNotes.push(...asStringArray(ep.sensitivityFlags || ep.sensitivity_flags));
      expertNotes.push(...asStringArray(ep.pairingRules || ep.pairing_rules));
      const citations = compactCitations(ep.citations);
      if (citations) expertNotes.push(`Citations: ${citations}`);
    }

    const sku = asPlainObject(s.sku);
    const social = sku && asPlainObject(sku.social_stats || sku.socialStats);
    const scores = social && asPlainObject(social.platform_scores || social.platformScores);
    if (scores) {
      for (const [k, v] of Object.entries(scores)) addPlatformScore(k, v);
    }
    if (social) {
      const keyPhrases = asPlainObject(social.key_phrases || social.keyPhrases);
      if (keyPhrases) {
        for (const phrases of Object.values(keyPhrases)) {
          expertNotes.push(...asStringArray(phrases).slice(0, 6));
        }
      }
    }
  }

  for (const step of recommendations) maybeCollectFromStep(step);

  const platform_scores = {};
  for (const [k, sum] of Object.entries(platformScoresAcc)) {
    const c = platformScoresCount[k] || 0;
    if (!c) continue;
    platform_scores[k] = Math.round((sum / c) * 1000) / 1000;
  }

  const evidence = {
    science: { key_ingredients: uniqueStrings(keyIngredients), mechanisms: [], fit_notes: uniqueStrings(fitNotes), risk_notes: uniqueStrings(riskNotes) },
    social_signals: {
      ...(Object.keys(platform_scores).length ? { platform_scores } : {}),
      typical_positive: [],
      typical_negative: [],
      risk_for_groups: [],
    },
    expert_notes: uniqueStrings(expertNotes),
    confidence: null,
    missing_info: [],
  };

  const missing_info = [];
  if (!am.length && !pm.length) missing_info.push('routine_missing');

  if (contextMeta && typeof contextMeta === 'object') {
    if (contextMeta.over_budget === true) missing_info.push('over_budget');
    const budget = normalizeBudgetHint(contextMeta.budget || contextMeta.budget_cny);
    if (!budget) missing_info.push('budget_unknown');
  }

  return {
    recommendations,
    evidence,
    confidence: null,
    missing_info: uniqueStrings(missing_info),
  };
}

module.exports = {
  normalizeBudgetHint,
  mapConcerns,
  mapBarrierStatus,
  mapAuroraProductParse,
  mapAuroraProductAnalysis,
  mapAuroraAlternativesToDupeCompare,
  mapAuroraAlternativesToRecoAlternatives,
  mapAuroraRoutineToRecoGenerate,
};
