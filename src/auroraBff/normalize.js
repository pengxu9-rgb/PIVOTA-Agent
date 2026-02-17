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

  const parseRaw = asPlainObject(o.parse);
  const product =
    asPlainObject(o.product) ||
    asPlainObject(o.anchor_product || o.anchorProduct) ||
    asPlainObject(o.product_entity || o.productEntity) ||
    asPlainObject(parseRaw?.product) ||
    asPlainObject(parseRaw?.anchor_product || parseRaw?.anchorProduct) ||
    asPlainObject(parseRaw?.product_entity || parseRaw?.productEntity) ||
    null;
  if (!product) field_missing.push({ field: 'product', reason: 'upstream_missing_or_invalid' });

  const confidence = asNumberOrNull(
    o.confidence ??
      o.parse_confidence ??
      o.parseConfidence ??
      parseRaw?.parse_confidence ??
      parseRaw?.parseConfidence ??
      parseRaw?.confidence,
  );
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings([
    ...asStringArray(o.missing_info ?? o.missingInfo),
    ...asStringArray(parseRaw?.missing_info ?? parseRaw?.missingInfo ?? parseRaw?.missing_fields ?? parseRaw?.missingFields),
  ]);

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

  const competitorsRaw = asPlainObject(o.competitors);
  const competitorCandidates = [];
  if (competitorsRaw && Array.isArray(competitorsRaw.candidates)) {
    for (const item of competitorsRaw.candidates) {
      const row = asPlainObject(item);
      if (!row) continue;
      competitorCandidates.push(row);
      if (competitorCandidates.length >= 12) break;
    }
  }
  if (competitorsRaw && !competitorCandidates.length) {
    field_missing.push({ field: 'competitors.candidates', reason: 'upstream_missing_or_empty' });
  }

  return {
    payload: {
      assessment,
      evidence: evOut.evidence,
      confidence,
      missing_info: uniqueStrings(missing_info),
      ...(competitorCandidates.length ? { competitors: { candidates: competitorCandidates } } : {}),
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

function truncateText(s, max = 200) {
  const t = typeof s === 'string' ? s.trim() : s == null ? '' : String(s).trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

function isMostlyEnglishText(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (!letters) return false;
  // If it has no CJK and a lot of latin letters, treat as EN-ish.
  const hasCjk = /[\u4e00-\u9fff]/.test(t);
  return !hasCjk && letters / Math.max(1, t.length) > 0.25;
}

function humanizeRiskToken(token, lang) {
  const t = String(token || '').trim();
  if (!t) return '';
  const lower = t.toLowerCase();

  const cn = String(lang).toUpperCase() === 'CN';
  const map = {
    high_irritation: cn ? '刺激性偏高（更容易刺痛/泛红）' : 'Higher irritation potential (stinging/redness more likely)',
    strong_acid: cn ? '酸类偏强（更容易刺激）' : 'Stronger acids (higher irritation risk)',
    mild_acid: cn ? '含温和酸类' : 'Contains mild acids',
    acid: cn ? '含酸类（注意频率）' : 'Contains acids (watch frequency)',
    fragrance: cn ? '可能含香精/香料（以成分表为准）' : 'May be fragranced (verify INCI)',
    fungal_acne: cn ? '真菌痘倾向人群需谨慎（以个人情况为准）' : 'If fungal-acne prone, use with caution (depends on the person)',
    comedogenic: cn ? '可能更闷（以个人情况为准）' : 'May feel occlusive for some users',
  };

  if (map[lower]) return map[lower];

  // If the token is a bare snake_case flag, do not surface it to end users.
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(lower)) return '';

  return t;
}

function humanizeRiskLine(line, lang) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  // Common KB-ish formatting: "a | b | c"
  const parts = raw.split('|').map((p) => p.trim()).filter(Boolean);
  const tokens = parts.length >= 2 ? parts : [raw];
  const out = uniqueStrings(tokens.map((t) => humanizeRiskToken(t, lang)).filter(Boolean));
  return out.length ? truncateText(out.join('；'), 200) : '';
}

function buildProfileFitReasons(profileSummary, evidence, { lang = 'EN' } = {}) {
  const p = asPlainObject(profileSummary);
  if (!p) return [];

  const cn = String(lang).toUpperCase() === 'CN';
  const normalizeEnum = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const skinType = normalizeEnum(p.skinType);
  const sensitivity = normalizeEnum(p.sensitivity);
  const barrier = normalizeEnum(p.barrierStatus);
  const goals = Array.isArray(p.goals) ? p.goals.map((g) => normalizeEnum(g)).filter(Boolean) : [];

  const tags = [];
  if (cn) {
    if (skinType === 'oily') tags.push('油皮');
    else if (skinType === 'dry') tags.push('干皮');
    else if (skinType === 'combo' || skinType === 'combination') tags.push('混合皮');
    else if (skinType) tags.push(`肤质：${skinType}`);

    if (sensitivity === 'low') tags.push('低敏');
    else if (sensitivity === 'medium') tags.push('中敏');
    else if (sensitivity === 'high') tags.push('高敏');
    else if (sensitivity) tags.push(`敏感：${sensitivity}`);

    if (barrier === 'healthy') tags.push('屏障健康');
    else if (barrier === 'impaired') tags.push('屏障受损');
    else if (barrier) tags.push(`屏障：${barrier}`);
  } else {
    if (skinType) tags.push(skinType === 'combination' || skinType === 'combo' ? 'combination' : skinType);
    if (sensitivity) tags.push(`sensitivity=${sensitivity}`);
    if (barrier) tags.push(`barrier=${barrier}`);
  }

  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const keyIngredients = asStringArray(science.key_ingredients ?? science.keyIngredients);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);

  const lower = uniqueStrings(keyIngredients.map((x) => String(x || '').trim()).filter(Boolean)).join(' | ').toLowerCase();
  const hasNiacinamide = /\bniacinamide\b|烟酰胺/.test(lower);
  const hasZincPca = /\bzinc\b.*\bpca\b|锌\s*pca/.test(lower);
  const hasStrongActives =
    /\b(retinol|retinal|tretinoin|adapalene)\b|维a|阿达帕林/.test(lower) ||
    /\baha\b|\bbha\b|\bpha\b|\bglycolic\b|\blactic\b|果酸|水杨酸|杏仁酸|乳酸|葡糖酸内酯/.test(lower);

  const humanizedRisk = uniqueStrings(riskNotes.map((r) => humanizeRiskLine(r, lang)).filter(Boolean));
  const isHighIrr = humanizedRisk.some((r) => /刺激|irrit/i.test(r)) || riskNotes.some((r) => /high_irritation/i.test(String(r || '')));

  const out = [];

  if (tags.length) {
    out.push(
      cn
        ? `你的情况：${truncateText(tags.join(' / '), 80)}。`
        : `Your profile: ${truncateText(tags.join(' / '), 120)}.`,
    );
  }

  if (cn) {
    const goalHint = [];
    if (goals.includes('brightening')) goalHint.push('提亮');
    if (goals.includes('acne')) goalHint.push('痘痘/痘印');
    if (goalHint.length && (hasNiacinamide || hasZincPca)) {
      out.push(`匹配点：你的目标包含${goalHint.join('、')}；烟酰胺/锌类通常更偏这条路线。`);
    } else if (skinType === 'oily' && (hasNiacinamide || hasZincPca)) {
      out.push('匹配点：油皮更常用烟酰胺/锌类来控油、改善痘印与毛孔观感。');
    }
  } else {
    const goalHint = [];
    if (goals.includes('brightening')) goalHint.push('brightening');
    if (goals.includes('acne')) goalHint.push('acne/marks');
    if (goalHint.length && (hasNiacinamide || hasZincPca)) {
      out.push(`Fit: your goals include ${goalHint.join(' + ')}; niacinamide/zinc commonly align with that.`);
    } else if (skinType === 'oily' && (hasNiacinamide || hasZincPca)) {
      out.push('Fit: oily skin often uses niacinamide/zinc for oil control and the look of pores/marks.');
    }
  }

  const needsCaution = barrier === 'impaired' || sensitivity === 'high' || (sensitivity === 'medium' && (hasStrongActives || isHighIrr));
  if (needsCaution) {
    out.push(
      cn
        ? '使用建议：先低频、少量；若刺痛/泛红就暂停，并以修护保湿为主。'
        : 'How to use: start low and small; if stinging/redness happens, pause and focus on barrier support.',
    );
  }

  return uniqueStrings(out.map((x) => truncateText(x, 200)).filter(Boolean)).slice(0, 2);
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
    if (riskNotes.length) {
      const human = uniqueStrings(riskNotes.map((r) => humanizeRiskLine(r, lang)).filter(Boolean));
      if (human.length) out.push(...take(human, 2));
    }
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

const PRODUCT_INTEL_CONTRACT_VERSION = 'aurora.product_intel.contract.v1';
const PRODUCT_INTEL_BLOCK_VERSION = 'aurora.product_intel.block.v1';

function clamp01(value) {
  const n = asNumberOrNull(value);
  if (n == null) return 0;
  return Math.max(0, Math.min(1, n));
}

function mapConfidenceLevel(score) {
  const s = clamp01(score);
  if (s >= 0.75) return 'high';
  if (s >= 0.4) return 'med';
  return 'low';
}

function buildBlockConfidence({
  coverage = 0,
  source_quality = 0.7,
  freshness = 1,
  consistency = 0.7,
  reasons = [],
  missing_fields = [],
} = {}) {
  const cv = clamp01(coverage);
  const sq = clamp01(source_quality);
  const fr = clamp01(freshness);
  const cs = clamp01(consistency);
  const score = Number((0.45 * cv + 0.2 * sq + 0.2 * fr + 0.15 * cs).toFixed(3));

  const outReasons = uniqueStrings([
    ...asStringArray(reasons),
    cv < 0.9 ? `coverage=${Math.round(cv * 100)}%` : '',
    sq < 0.9 ? `source_quality=${Math.round(sq * 100)}%` : '',
    fr < 0.95 ? `freshness=${Math.round(fr * 100)}%` : '',
    cs < 0.9 ? `consistency=${Math.round(cs * 100)}%` : '',
    missing_fields && missing_fields.length ? `missing_fields=${missing_fields.slice(0, 4).join(',')}` : '',
  ]);

  return {
    score,
    level: mapConfidenceLevel(score),
    reasons: outReasons.slice(0, 8),
  };
}

function buildEvidenceItem({
  source_type = 'expert_kb',
  source_name = null,
  url = null,
  captured_at = null,
  time_window = null,
  excerpt = '',
  data = null,
} = {}) {
  const out = {
    source_type,
    ...(source_name ? { source_name } : {}),
    ...(url ? { url } : {}),
    ...(captured_at ? { captured_at } : {}),
    ...(time_window && typeof time_window === 'object' ? { time_window } : {}),
    ...(excerpt ? { excerpt: truncateText(excerpt, 240) } : {}),
    ...(data && typeof data === 'object' && !Array.isArray(data) ? { data } : {}),
  };
  return out;
}

function normalizePlatformName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'red') return 'XHS';
  if (s === 'reddit') return 'Reddit';
  if (s === 'tiktok') return 'TikTok';
  if (s === 'youtube') return 'YouTube';
  if (s === 'instagram') return 'Instagram';
  return raw;
}

function inferIngredientFunctions(name, contextText) {
  const token = `${String(name || '').toLowerCase()} ${String(contextText || '').toLowerCase()}`;
  const out = [];
  if (/\bniacinamide\b|烟酰胺/.test(token)) out.push('barrier_support', 'oil_control', 'tone_evening');
  if (/\b(retinol|retinal|adapalene|tretinoin)\b|维a/.test(token)) out.push('retinoid', 'texture_refine');
  if (/\b(hyaluronic|sodium hyaluronate|glycerin|panthenol|urea|betaine)\b|玻尿酸|甘油/.test(token)) {
    out.push('humectant_hydration');
  }
  if (/\b(ceramide|cholesterol|fatty acid)\b|神经酰胺/.test(token)) out.push('barrier_lipid_support');
  if (/\b(salicylic|bha|aha|pha|glycolic|lactic|mandelic)\b|果酸|水杨酸/.test(token)) out.push('exfoliation');
  if (/\b(vitamin c|ascorbic|ascorbyl)\b|维c/.test(token)) out.push('antioxidant_brightening');
  if (/\b(peptide)\b|肽/.test(token)) out.push('peptide_support');
  return uniqueStrings(out).slice(0, 4);
}

function inferIngredientRisks(name, contextText) {
  const token = `${String(name || '').toLowerCase()} ${String(contextText || '').toLowerCase()}`;
  const out = [];
  if (/\birritat|stinging|burn|high_irritation|刺激|刺痛|泛红/.test(token)) out.push('irritant');
  if (/\ballerg|敏感|过敏/.test(token)) out.push('allergen');
  if (/\b(fragrance|parfum|essential oil|limonene|linalool|citral)\b|香精|精油/.test(token)) out.push('fragrance');
  if (/\b(retinol|retinal|adapalene|tretinoin)\b|维a/.test(token)) out.push('retinoid');
  if (/\b(salicylic|bha|aha|pha|glycolic|lactic|mandelic)\b|果酸|水杨酸/.test(token)) out.push('exfoliating_acid');
  if (/\bcomedo|pore clog|闷痘|爆痘/.test(token)) out.push('comedogenic_risk');
  return uniqueStrings(out).slice(0, 5);
}

function normalizeCompetitorCandidates(rawCandidates) {
  const out = [];
  for (const item of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const row = asPlainObject(item);
    if (!row) continue;
    const nameRaw = row.name ?? row.display_name ?? row.displayName;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (!name) continue;

    const similarityRaw = asNumberOrNull(row.similarity_score ?? row.similarityScore);
    const similarity =
      similarityRaw == null ? null : similarityRaw > 1 ? clamp01(similarityRaw / 100) : clamp01(similarityRaw);

    const whyCandidate = uniqueStrings(asStringArray(row.why_candidate ?? row.whyCandidate));
    const compareHighlights = uniqueStrings(asStringArray(row.compare_highlights ?? row.compareHighlights));

    out.push({
      ...(row.product_id ? { product_id: String(row.product_id).trim() } : {}),
      ...(row.sku_id ? { sku_id: String(row.sku_id).trim() } : {}),
      ...(row.brand ? { brand: String(row.brand).trim() } : {}),
      name,
      ...(row.display_name ? { display_name: String(row.display_name).trim() } : {}),
      ...(similarity != null ? { similarity_score: similarity } : {}),
      why_candidate: whyCandidate,
      ...(compareHighlights.length ? { compare_highlights: compareHighlights } : {}),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function buildIngredientIntelBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const ev = asPlainObject(p.evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const keyIngredients = asStringArray(science.key_ingredients ?? science.keyIngredients);
  const mechanisms = asStringArray(science.mechanisms);
  const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);

  const missingFields = [];
  const warnings = [];
  if (!keyIngredients.length) missingFields.push('evidence.science.key_ingredients');
  if (!mechanisms.length && !fitNotes.length) warnings.push('science_mechanisms_missing');
  if (!riskNotes.length) warnings.push('risk_notes_missing');

  const contextText = uniqueStrings([...mechanisms, ...fitNotes, ...riskNotes]).join(' | ');
  const inciNormalized = keyIngredients.slice(0, 40).map((name) => ({
    inci: name,
    functions: inferIngredientFunctions(name, contextText),
    risks: inferIngredientRisks(name, contextText),
    suitability_tags: [],
  }));

  const actives = keyIngredients.slice(0, 8).map((name, idx) => ({
    name,
    rationale: truncateText(
      mechanisms[idx] ||
        fitNotes[idx] ||
        `Evidence-derived active from science.key_ingredients (${name}).`,
      180,
    ),
  }));

  const redFlags = uniqueStrings([
    ...riskNotes.map((r) => humanizeRiskLine(r, 'EN')),
    ...inciNormalized.flatMap((x) => asStringArray(x.risks)),
  ]).slice(0, 8);

  const evidenceItems = [];
  if (keyIngredients.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_structured',
        captured_at: generatedAt,
        excerpt: `Science key ingredients: ${keyIngredients.slice(0, 8).join(', ')}`,
        data: { key_ingredients: keyIngredients.slice(0, 16) },
      }),
    );
  }
  if (mechanisms.length || fitNotes.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_structured',
        captured_at: generatedAt,
        excerpt: uniqueStrings([...mechanisms, ...fitNotes]).slice(0, 2).join(' | '),
        data: { mechanisms: mechanisms.slice(0, 8), fit_notes: fitNotes.slice(0, 8) },
      }),
    );
  }
  if (riskNotes.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_structured',
        captured_at: generatedAt,
        excerpt: `Risk notes: ${riskNotes.slice(0, 3).join(' | ')}`,
        data: { risk_notes: riskNotes.slice(0, 8) },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: (keyIngredients.length ? 0.55 : 0) + (mechanisms.length || fitNotes.length ? 0.25 : 0) + (riskNotes.length ? 0.2 : 0),
    source_quality: keyIngredients.length ? 0.82 : 0.55,
    freshness: 0.9,
    consistency: 0.76,
    reasons: ['evidence_first=science'],
    missing_fields: missingFields,
  });

  return {
    block: {
      ...(keyIngredients.length ? { inci_raw: keyIngredients.join(', ') } : {}),
      ...(inciNormalized.length ? { inci_normalized: inciNormalized } : { inci_normalized: [] }),
      ...(actives.length ? { actives } : { actives: [] }),
      ...(redFlags.length ? { red_flags: redFlags } : { red_flags: [] }),
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 24 * 14,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildSkinFitBlock(payload, { profileSummary = null, generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const ev = asPlainObject(p.evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const assessment = asPlainObject(p.assessment) || {};
  const profile = asPlainObject(profileSummary ?? p.profile_summary ?? p.profileSummary) || {};

  const verdict = String(assessment.verdict || '').trim().toLowerCase();
  const reasons = asStringArray(assessment.reasons);
  const howToUse = asStringArray(assessment.how_to_use ?? assessment.howToUse);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);

  const profileSkinType = typeof profile.skinType === 'string' ? profile.skinType.trim() : '';
  const profileSensitivity = typeof profile.sensitivity === 'string' ? profile.sensitivity.trim().toLowerCase() : '';
  const profileBarrier = typeof profile.barrierStatus === 'string' ? profile.barrierStatus.trim().toLowerCase() : '';
  const profileGoals = asStringArray(profile.goals);

  const riskJoined = uniqueStrings(riskNotes.map((x) => String(x || '').toLowerCase())).join(' | ');
  const hasIrritationRisk = /\birrit|sting|burn|high_irritation|刺激|刺痛|泛红/.test(riskJoined);
  const hasFragranceRisk = /\bfragrance|parfum|essential oil|香精|精油/.test(riskJoined);
  const isCautionVerdict = /\b(caution|avoid|mismatch|risky|unknown|不适配|谨慎|未知)\b/.test(verdict);

  const suitableFor = [];
  if (profileSkinType && !isCautionVerdict) suitableFor.push(profileSkinType);
  if (profileGoals.length && !isCautionVerdict) suitableFor.push(...profileGoals.map((g) => `goal:${g}`));

  const notRecommendedFor = [];
  if (hasIrritationRisk || profileSensitivity === 'high') notRecommendedFor.push('high_sensitivity');
  if (hasIrritationRisk || profileBarrier === 'impaired') notRecommendedFor.push('impaired_barrier');
  if (hasFragranceRisk) notRecommendedFor.push('fragrance_sensitive');

  const contraindications = [];
  if (hasIrritationRisk) {
    contraindications.push({
      condition: 'high_sensitivity_or_impaired_barrier',
      why: truncateText(
        reasons[0] || riskNotes[0] || 'Irritation signal found in science risk notes; ramp slowly and patch test.',
        200,
      ),
    });
  }
  if (hasFragranceRisk) {
    contraindications.push({
      condition: 'fragrance_sensitivity',
      why: truncateText(riskNotes.find((x) => /fragrance|parfum|香精|精油/i.test(String(x || ''))) || 'Fragrance-related risk token found.', 200),
    });
  }

  const routineTips = uniqueStrings([
    ...howToUse,
    ...(hasIrritationRisk ? ['Start with low frequency and pause if stinging/redness occurs.'] : []),
  ]).slice(0, 5);

  const missingFields = [];
  if (!profileSkinType) missingFields.push('profile.skinType');
  if (!profileSensitivity) missingFields.push('profile.sensitivity');
  if (!profileBarrier) missingFields.push('profile.barrierStatus');
  if (!reasons.length && !riskNotes.length) missingFields.push('assessment.reasons_or_science.risk_notes');

  const warnings = [];
  if (!profileGoals.length) warnings.push('profile.goals_missing');

  const evidenceItems = [];
  if (reasons.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_assessment',
        captured_at: generatedAt,
        excerpt: reasons.slice(0, 2).join(' | '),
        data: { assessment_reasons: reasons.slice(0, 6), verdict: assessment.verdict || null },
      }),
    );
  }
  if (riskNotes.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_science',
        captured_at: generatedAt,
        excerpt: `Risk notes: ${riskNotes.slice(0, 3).join(' | ')}`,
        data: { risk_notes: riskNotes.slice(0, 8) },
      }),
    );
  }
  if (profileSkinType || profileSensitivity || profileBarrier || profileGoals.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'catalog',
        source_name: 'user_profile',
        captured_at: generatedAt,
        excerpt: `Profile context: skinType=${profileSkinType || 'unknown'}, sensitivity=${profileSensitivity || 'unknown'}, barrier=${profileBarrier || 'unknown'}`,
        data: {
          skinType: profileSkinType || null,
          sensitivity: profileSensitivity || null,
          barrierStatus: profileBarrier || null,
          goals: profileGoals,
        },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: (reasons.length ? 0.4 : 0) + (riskNotes.length ? 0.25 : 0) + (profileSkinType || profileSensitivity || profileBarrier ? 0.35 : 0),
    source_quality: 0.74,
    freshness: 0.92,
    consistency: hasIrritationRisk && !isCautionVerdict ? 0.62 : 0.72,
    reasons: ['rules_first=skin_fit'],
    missing_fields: missingFields,
  });

  return {
    block: {
      suitable_for: uniqueStrings(suitableFor).slice(0, 8),
      not_recommended_for: uniqueStrings(notRecommendedFor).slice(0, 8),
      contraindications: contraindications.slice(0, 6),
      ...(routineTips.length ? { routine_tips: routineTips } : { routine_tips: [] }),
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 24 * 14,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildSocialSignalsBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const ev = asPlainObject(p.evidence) || {};
  const social = asPlainObject(ev.social_signals || ev.socialSignals) || {};

  const platformScores = asRecordOfNumbers(social.platform_scores ?? social.platformScores) || {};
  const positives = asStringArray(social.typical_positive ?? social.typicalPositive);
  const negatives = asStringArray(social.typical_negative ?? social.typicalNegative);
  const riskForGroups = asStringArray(social.risk_for_groups ?? social.riskForGroups);

  const platforms = [];
  for (const [rawName, rawScore] of Object.entries(platformScores)) {
    const name = normalizePlatformName(rawName);
    if (!name || String(rawName).toLowerCase() === 'burn_rate') continue;
    const score01 = rawScore > 1 ? clamp01(rawScore / 100) : clamp01(rawScore);
    platforms.push({
      name,
      mention_count: null,
      sample_size: null,
      time_window: null,
      sentiment: {
        pos: Number(score01.toFixed(3)),
        neu: Number(Math.max(0, 1 - score01).toFixed(3)),
        neg: 0,
      },
      top_topics: positives.slice(0, 4).map((topic) => ({ topic, count: null, polarity: 'pos' })),
      risk_terms: riskForGroups.slice(0, 4).map((term) => ({ term, count: null })),
    });
  }

  const missingFields = [];
  if (!Object.keys(platformScores).length) missingFields.push('evidence.social_signals.platform_scores');
  if (!positives.length && !negatives.length) missingFields.push('evidence.social_signals.topics');
  if (!riskForGroups.length) missingFields.push('evidence.social_signals.risk_for_groups');

  const warnings = [];
  if (platforms.length) warnings.push('social_sample_size_missing');
  warnings.push('social_time_window_missing');

  const evidenceItems = [];
  if (Object.keys(platformScores).length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'social',
        source_name: 'aurora_social_signals',
        captured_at: generatedAt,
        excerpt: `Platform scores: ${Object.entries(platformScores)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
        data: { platform_scores: platformScores },
      }),
    );
  }
  if (positives.length || negatives.length || riskForGroups.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'social',
        source_name: 'aurora_social_signals',
        captured_at: generatedAt,
        excerpt: uniqueStrings([
          positives.length ? `Positive: ${positives.slice(0, 3).join(', ')}` : '',
          negatives.length ? `Negative: ${negatives.slice(0, 3).join(', ')}` : '',
          riskForGroups.length ? `Risk groups: ${riskForGroups.slice(0, 2).join(', ')}` : '',
        ]).join(' | '),
        data: {
          typical_positive: positives.slice(0, 8),
          typical_negative: negatives.slice(0, 8),
          risk_for_groups: riskForGroups.slice(0, 8),
        },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: (Object.keys(platformScores).length ? 0.45 : 0) + (positives.length || negatives.length ? 0.3 : 0) + (riskForGroups.length ? 0.25 : 0),
    source_quality: Object.keys(platformScores).length ? 0.58 : 0.46,
    freshness: 0.7,
    consistency: 0.66,
    reasons: ['social_aggregation=partial'],
    missing_fields: missingFields,
  });

  return {
    block: {
      platforms,
      overall_summary: {
        top_pos_themes: positives.slice(0, 5),
        top_neg_themes: negatives.slice(0, 5),
        watchouts: riskForGroups.slice(0, 5),
      },
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 48,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildCompetitorsBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const candidatesIn = normalizeCompetitorCandidates(asPlainObject(p.competitors)?.candidates);
  const assessment = asPlainObject(p.assessment) || {};
  const anchor = asPlainObject(assessment.anchor_product || assessment.anchorProduct) || null;

  const missingFields = [];
  if (!candidatesIn.length) missingFields.push('competitors.candidates');

  const warnings = [];
  if (!candidatesIn.length && anchor) warnings.push('no_competitor_candidates_from_upstream');

  const evidenceItems = [];
  if (candidatesIn.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'catalog',
        source_name: 'aurora_alternatives',
        captured_at: generatedAt,
        excerpt: `Candidates: ${candidatesIn.slice(0, 3).map((x) => x.name).join(', ')}`,
        data: { candidates: candidatesIn.slice(0, 8) },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: candidatesIn.length ? Math.min(1, 0.5 + Math.min(0.5, candidatesIn.length * 0.1)) : 0.2,
    source_quality: candidatesIn.length ? 0.68 : 0.48,
    freshness: 0.86,
    consistency: 0.72,
    reasons: ['competitor_recall=upstream_alternatives'],
    missing_fields: missingFields,
  });

  return {
    block: {
      candidates: candidatesIn,
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 24 * 7,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildBlockMissingInfo(blockName, blockMeta) {
  const out = [];
  const meta = asPlainObject(blockMeta) || {};
  const missing = asStringArray(meta.missing_fields ?? meta.missingFields);
  if (missing.length) {
    for (const field of missing.slice(0, 5)) out.push(`${blockName}.${field}`);
  }
  const confidence = asPlainObject(meta.confidence) || {};
  const level = String(confidence.level || '').trim().toLowerCase();
  if (level === 'low') out.push(`${blockName}_low_confidence`);
  return uniqueStrings(out);
}

function buildProductIntelContract(payload, { lang = 'EN', profileSummary = null } = {}) {
  const p = asPlainObject(payload);
  if (!p) return null;
  const generatedAt = new Date().toISOString();

  const ingredientOut = buildIngredientIntelBlock(p, { generatedAt });
  const skinFitOut = buildSkinFitBlock(p, { profileSummary, generatedAt });
  const socialOut = buildSocialSignalsBlock(p, { generatedAt });
  const competitorsOut = buildCompetitorsBlock(p, { generatedAt });

  const assessment = asPlainObject(p.assessment) || {};
  const anchorProduct = asPlainObject(assessment.anchor_product || assessment.anchorProduct) || asPlainObject(p.product) || null;

  const confidenceByBlock = {
    ingredient_intel: ingredientOut.confidence,
    skin_fit: skinFitOut.confidence,
    social_signals: socialOut.confidence,
    competitors: competitorsOut.confidence,
  };

  const missingInfo = uniqueStrings([
    ...buildBlockMissingInfo('ingredient_intel', ingredientOut.block?._meta),
    ...buildBlockMissingInfo('skin_fit', skinFitOut.block?._meta),
    ...buildBlockMissingInfo('social_signals', socialOut.block?._meta),
    ...buildBlockMissingInfo('competitors', competitorsOut.block?._meta),
  ]);

  return {
    version: PRODUCT_INTEL_CONTRACT_VERSION,
    ...(anchorProduct ? { product: anchorProduct } : {}),
    ingredient_intel: ingredientOut.block,
    skin_fit: skinFitOut.block,
    social_signals: socialOut.block,
    competitors: competitorsOut.block,
    confidence_by_block: confidenceByBlock,
    missing_info: missingInfo,
    language: String(lang || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN',
  };
}

function attachProductIntelContract(payload, { lang = 'EN', profileSummary = null } = {}) {
  const p = asPlainObject(payload);
  if (!p) return payload;
  const intel = buildProductIntelContract(p, { lang, profileSummary });
  if (!intel) return payload;

  const mergedMissingInfo = uniqueStrings([
    ...asStringArray(p.missing_info ?? p.missingInfo),
    ...asStringArray(intel.missing_info),
  ]);

  return {
    ...p,
    ...(intel.product ? { product: intel.product } : {}),
    ingredient_intel: intel.ingredient_intel,
    skin_fit: intel.skin_fit,
    social_signals: intel.social_signals,
    competitors: intel.competitors,
    confidence_by_block: intel.confidence_by_block,
    product_intel_contract_version: intel.version,
    missing_info: mergedMissingInfo,
  };
}

function enrichProductAnalysisPayload(payload, { lang = 'EN', profileSummary = null } = {}) {
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

    const fallbackPayload = {
      ...p,
      assessment: {
        verdict: String(lang).toUpperCase() === 'CN' ? '未知' : 'Unknown',
        reasons: uniqueStrings(reasons).slice(0, 5),
      },
    };
    return attachProductIntelContract(fallbackPayload, { lang, profileSummary });
  }

  const verdict =
    typeof assessment.verdict === 'string' ? assessment.verdict.trim() : String(assessment.verdict || '').trim();

  const existingReasons = asStringArray(assessment.reasons);
  const keptReasons = existingReasons
    .filter((r) => !isGenericReason(r, lang))
    .map((r) => truncateText(r, 200))
    .filter(Boolean);

  const minReasons = 2;
  const maxReasons = 5;

  let reasons = keptReasons.slice();

  // Optional: inject profile-fit explanations when profile context is available (chat/product-analyze flows).
  const profileReasons = buildProfileFitReasons(profileSummary ?? p.profile_summary ?? p.profileSummary ?? null, p.evidence, { lang });
  let profileReasonsUsed = 0;
  if (profileReasons.length) {
    // CN users often receive mixed-language upstream reasons; prefer CN-ish reasons when we have them.
    if (String(lang).toUpperCase() === 'CN') {
      const hasCn = profileReasons.some((r) => /[\u4e00-\u9fff]/.test(String(r || '')));
      if (hasCn) reasons = reasons.filter((r) => !isMostlyEnglishText(r));
    }
    // Prepend, but keep room for the hero ingredient line (added later) when possible.
    const budget = Math.max(1, maxReasons - 1);
    const pre = profileReasons.slice(0, budget);
    profileReasonsUsed = pre.length;
    reasons = uniqueStrings([...pre, ...reasons]).slice(0, maxReasons);
  }

  // Remove raw risk-code fragments that are not user-readable.
  reasons = uniqueStrings(
    reasons
      .map((r) => {
        const hr = humanizeRiskLine(r, lang);
        return hr || r;
      })
      .filter((r) => {
        const t = String(r || '').trim();
        if (!t) return false;
        if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(t)) return false;
        return true;
      }),
  ).slice(0, maxReasons);

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
      // If we have profile-fit reasons, keep them as the top lines (more user-specific),
      // then insert hero ingredient after them.
      if (profileReasonsUsed > 0) {
        const idx = Math.max(0, Math.min(profileReasonsUsed, reasons.length));
        reasons.splice(idx, 0, heroLine);
      } else {
        reasons.unshift(heroLine);
      }
    }
  }

  const outAssessment = {
    ...assessment,
    ...(hero && typeof hero === 'object' ? { hero_ingredient: hero } : {}),
    reasons: uniqueStrings(reasons).slice(0, maxReasons),
  };
  return attachProductIntelContract({ ...p, assessment: outAssessment }, { lang, profileSummary });
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
