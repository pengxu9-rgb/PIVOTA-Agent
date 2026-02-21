const BLOCK_LEVEL = Object.freeze({
  INFO: 'INFO',
  WARN: 'WARN',
  REQUIRE_INFO: 'REQUIRE_INFO',
  BLOCK: 'BLOCK',
});

const LEVEL_WEIGHT = Object.freeze({
  INFO: 0,
  WARN: 1,
  REQUIRE_INFO: 2,
  BLOCK: 3,
});

function normalizeLanguage(language) {
  return String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizePregnancyStatus(value) {
  const raw = lowerText(value);
  if (!raw) return 'unknown';
  if (/(not[_\s-]?pregnan|未怀孕|没有怀孕|非孕)/i.test(raw)) return 'not_pregnant';
  if (/(pregnan|怀孕|孕期)/i.test(raw)) return 'pregnant';
  if (/(trying|conceiv|备孕)/i.test(raw)) return 'trying';
  if (/(unknown|不确定|未知|not sure|unsure)/i.test(raw)) return 'unknown';
  return raw;
}

function normalizeLactationStatus(value) {
  const raw = lowerText(value);
  if (!raw) return 'unknown';
  if (/(not[_\s-]?lactat|非哺乳|未哺乳|不哺乳)/i.test(raw)) return 'not_lactating';
  if (/(lactat|breastfeed|哺乳|母乳)/i.test(raw)) return 'lactating';
  if (/(unknown|不确定|未知|not sure|unsure)/i.test(raw)) return 'unknown';
  return raw;
}

function normalizeAgeBand(value) {
  const raw = lowerText(value);
  if (!raw) return 'unknown';
  if (/(under[_\s-]?13|13[_\s-]?17|18[_\s-]?24|25[_\s-]?34|35[_\s-]?44|45[_\s-]?54|55)/i.test(raw)) {
    return raw.replace(/\s+/g, '_');
  }
  if (/(unknown|不确定|未知|not sure|unsure)/i.test(raw)) return 'unknown';
  return raw;
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function hasAny(text, patterns) {
  const raw = String(text || '');
  return patterns.some((re) => re.test(raw));
}

function normalizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const pregnancyRaw = p.pregnancy_status ?? p.pregnancyStatus;
  const lactationRaw = p.lactation_status ?? p.lactationStatus;
  const ageBandRaw = p.age_band ?? p.ageBand;
  const medsRaw = p.high_risk_medications ?? p.highRiskMedications;
  return {
    age_band: normalizeAgeBand(ageBandRaw || 'unknown') || 'unknown',
    pregnancy_status: normalizePregnancyStatus(pregnancyRaw || 'unknown') || 'unknown',
    lactation_status: normalizeLactationStatus(lactationRaw || 'unknown') || 'unknown',
    high_risk_medications: Array.isArray(medsRaw)
      ? medsRaw.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    barrierStatus: normalizeText(p.barrierStatus || ''),
    sensitivity: normalizeText(p.sensitivity || ''),
  };
}

function inferPregnancyStatusFromMessage(message) {
  const raw = normalizeText(message);
  const lower = raw.toLowerCase();
  if (!raw) return 'unknown';
  if (/\b(i('| a)?m|i am|currently)\s+(not\s+pregnant)\b/i.test(raw) || /我(现在)?(没有|未)怀孕/.test(raw)) {
    return 'not_pregnant';
  }
  if (/\b(i('| a)?m|i am|currently)\s+(trying(\s+to\s+conceive)?|ttc)\b/i.test(raw) || /我(现在)?(在)?备孕/.test(raw)) {
    return 'trying';
  }
  if (/\b(i('| a)?m|i am|currently)\s+pregnan/i.test(raw) || /我(现在)?(在)?怀孕|我孕期/.test(raw)) {
    return 'pregnant';
  }
  if (
    /\b(while|during)\s+pregnan/i.test(raw) ||
    /\bpregnan(t|cy)\b/i.test(raw) ||
    /(孕期|怀孕期间|孕妇)/.test(raw)
  ) {
    return 'pregnant';
  }
  if (/(pregnan|怀孕|备孕)/i.test(lower)) return 'unknown';
  return 'unknown';
}

function inferLactationStatusFromMessage(message) {
  const raw = normalizeText(message);
  const lower = raw.toLowerCase();
  if (!raw) return 'unknown';
  if (/\b(i('| a)?m|i am|currently)\s+(not\s+lactating|not\s+breastfeeding)\b/i.test(raw) || /我(现在)?不(在)?哺乳/.test(raw)) {
    return 'not_lactating';
  }
  if (/\b(i('| a)?m|i am|currently)\s+(lactating|breastfeeding)\b/i.test(raw) || /我(现在)?(在)?哺乳|我(现在)?母乳/.test(raw)) {
    return 'lactating';
  }
  if (
    /\b(while|during)\s+(lactating|breastfeeding|lactation)\b/i.test(raw) ||
    /\b(lactat|breastfeed)\b/i.test(raw) ||
    /(哺乳期|母乳期)/.test(raw)
  ) {
    return 'lactating';
  }
  if (/(lactat|breastfeed|哺乳|母乳)/i.test(lower)) return 'unknown';
  return 'unknown';
}

function buildCtx({ intent, message, profile, language }) {
  const text = normalizeText(message);
  const lower = lowerText(text);
  const lang = normalizeLanguage(language);
  const p = normalizeProfile(profile);
  if (p.pregnancy_status === 'unknown') {
    const inferredPregnancy = inferPregnancyStatusFromMessage(text);
    if (inferredPregnancy !== 'unknown') p.pregnancy_status = inferredPregnancy;
  }
  if (p.lactation_status === 'unknown') {
    const inferredLactation = inferLactationStatusFromMessage(text);
    if (inferredLactation !== 'unknown') p.lactation_status = inferredLactation;
  }
  const medsLower = p.high_risk_medications.map((m) => m.toLowerCase());

  const mentions = {
    oralIsotretinoin: hasAny(lower, [/\b(accutane|isotretinoin|oral\s+isotretinoin|口服异维a酸|异维a酸)\b/i]),
    retinoid: hasAny(lower, [/\b(retinoid|retinol|retinal|tretinoin|adapalene|tazarotene|维a|a醇|维甲酸|阿达帕林)\b/i]),
    hydroquinone: hasAny(lower, [/\b(hydroquinone|氢醌)\b/i]),
    strongSalicylic: hasAny(lower, [/(salicylic\s*acid\s*(30|20|high|strong)|高浓度水杨酸|水杨酸焕肤|bha\s*peel)/i]),
    aggressivePeel: hasAny(lower, [/(chemical\s*peel|peel\s*kit|焕肤|刷酸换肤|剥脱)/i]),
    prescription: hasAny(lower, [/(prescription|rx|处方|医生开|药膏)/i]),
    essentialOilHeavy: hasAny(lower, [/(essential\s*oil|香精精油|精油类)/i]),
    acneAsk: hasAny(lower, [/(acne|breakout|控痘|痘痘|闭口|粉刺)/i]),
    chestArea: hasAny(lower, [/(breast|chest|areola|乳房|胸前|乳晕)/i]),
    strongExfoliant: hasAny(lower, [/(aha|bha|pha|glycolic|lactic|mandelic|果酸|水杨酸|酸类去角质)/i]),
    dailyExfoliation: hasAny(lower, [/(every\s*day|daily|天天|每天).{0,12}(acid|exfoliat|刷酸|果酸|水杨酸)/i]),
    multiActivesRequest:
      hasAny(lower, [/(add|stack|combine|mix|叠加|一起用|同晚).{0,20}/i]) &&
      [
        /retinoid|retinol|tretinoin|adapalene|维a|a醇|维甲酸/i,
        /aha|bha|pha|glycolic|salicylic|果酸|水杨酸|酸类/i,
        /benzoyl\s*peroxide|过氧化苯甲酰/i,
        /hydroquinone|氢醌/i,
      ].filter((re) => re.test(lower)).length >= 2,
    travelHighUv: hasAny(lower, [/(travel|trip|outdoor|beach|sun|uv|出差|旅行|户外|海边|暴晒|紫外线)/i]),
    wantsExfoliation: hasAny(lower, [/(exfoliat|acid|peel|刷酸|去角质|焕肤)/i]),
    overnightFast: hasAny(lower, [/(overnight|fastest|quickest|立刻见效|一夜见效|最快见效)/i]),
    tretinoinRx: hasAny(lower, [/(tretinoin|维甲酸|阿维a酸).{0,12}(rx|prescription|处方)?/i]),
    steroidFace: hasAny(lower, [/(steroid|激素).{0,12}(face|脸)/i]),
    strongAntiAging: hasAny(lower, [/(strong\s*active|high\s*strength|retinoid|hydroquinone|高强度活性|猛药抗老|高浓度)/i]),
    breastfeedingSafeAsk: hasAny(lower, [/(breastfeeding|lactating|哺乳|母乳).{0,20}(safe|可以用|安全)/i]),
  };

  const meds = {
    isotretinoin: medsLower.some((m) => /(isotretinoin|accutane|异维a酸)/i.test(m)),
  };

  return {
    intent: String(intent || ''),
    message: text,
    lower,
    lang,
    profile: p,
    mentions,
    meds,
  };
}

function enReason(text) {
  return { EN: text, CN: null };
}

function cnReason(text) {
  return { EN: null, CN: text };
}

function bilingual(en, cn) {
  return { EN: en, CN: cn };
}

const SAFETY_RULES = [
  {
    id: 'P1',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.oralIsotretinoin,
    reason: bilingual('Oral isotretinoin is contraindicated during pregnancy.', '孕期禁用口服异维A酸。'),
    alternatives: bilingual('Use gentle cleanser + azelaic-acid-centered routine and consult your clinician.', '建议改为温和清洁+壬二酸方向，并咨询医生。'),
  },
  {
    id: 'P2',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.retinoid,
    reason: bilingual('Avoid retinoids during pregnancy as a precaution.', '孕期建议避免维A类。'),
    alternatives: bilingual('Consider azelaic acid, barrier repair, and strict sunscreen.', '可考虑壬二酸+屏障修护+严格防晒。'),
  },
  {
    id: 'P3',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.hydroquinone,
    reason: bilingual('Hydroquinone is better avoided during pregnancy.', '孕期建议避免氢醌。'),
    alternatives: bilingual('Use vitamin C or azelaic acid with tinted mineral sunscreen.', '可改维C/壬二酸+有色矿物防晒。'),
  },
  {
    id: 'P4',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.strongSalicylic,
    reason: bilingual('High-strength salicylic peels are not first-line in pregnancy.', '孕期不建议高浓度水杨酸焕肤。'),
    alternatives: bilingual('Prefer low-strength options and clinician-guided use.', '建议低浓度且在医生指导下使用。'),
  },
  {
    id: 'P5',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.aggressivePeel,
    reason: bilingual('Avoid aggressive chemical peel plans during pregnancy.', '孕期避免激进刷酸/焕肤方案。'),
    alternatives: bilingual('Switch to gentle barrier-focused routine.', '改为温和修护型方案。'),
  },
  {
    id: 'P6',
    level: BLOCK_LEVEL.REQUIRE_INFO,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.prescription,
    reason: bilingual('Prescription active requested during pregnancy needs a quick safety check.', '孕期涉及处方活性，需先补充安全信息。'),
    required_fields: ['high_risk_medications'],
    required_questions: ['Are you currently using any prescription acne medication?'],
    required_questions_cn: ['你当前是否在使用处方祛痘药？'],
  },
  {
    id: 'P7',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.essentialOilHeavy,
    reason: bilingual('Essential-oil-heavy leave-ons can increase irritation risk.', '精油/重香精留敷类可能提高刺激风险。'),
    alternatives: bilingual('Prefer fragrance-free products.', '建议优先无香精方案。'),
  },
  {
    id: 'P8',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.pregnancy_status === 'trying' && ctx.mentions.retinoid,
    reason: bilingual('Avoid retinoids while trying to conceive.', '备孕阶段建议避免维A类。'),
    alternatives: bilingual('Use safer alternatives (azelaic acid / barrier support).', '可选壬二酸/屏障修护替代。'),
  },
  {
    id: 'P9',
    level: BLOCK_LEVEL.INFO,
    when: (ctx) => ctx.profile.pregnancy_status === 'pregnant' && ctx.mentions.acneAsk,
    reason: bilingual('Keep acne care conservative during pregnancy.', '孕期痘痘护理建议保守方案。'),
    alternatives: bilingual('Gentle cleanse + azelaic acid + sunscreen can be considered.', '可考虑温和清洁+壬二酸+防晒。'),
  },
  {
    id: 'L1',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.lactation_status === 'lactating' && ctx.mentions.oralIsotretinoin,
    reason: bilingual('Do not use oral isotretinoin during breastfeeding.', '哺乳期不建议口服异维A酸。'),
    alternatives: bilingual('Use conservative topical options and consult clinician.', '建议保守外用并咨询医生。'),
  },
  {
    id: 'L2',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.profile.lactation_status === 'lactating' && ctx.mentions.retinoid && ctx.mentions.chestArea,
    reason: bilingual('Avoid applying retinoids on chest/areola while breastfeeding.', '哺乳期避免在胸前/乳晕区域使用维A类。'),
    alternatives: bilingual('Use non-retinoid barrier products for that area.', '该区域优先使用非维A修护品。'),
  },
  {
    id: 'L3',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.profile.lactation_status === 'lactating' && ctx.mentions.aggressivePeel,
    reason: bilingual('Strong peel routines can increase irritation during lactation.', '哺乳期激进焕肤更易刺激。'),
    alternatives: bilingual('Prefer gentle routine and reduce active overlap.', '建议温和流程并减少活性叠加。'),
  },
  {
    id: 'L4',
    level: BLOCK_LEVEL.INFO,
    when: (ctx) => ctx.profile.lactation_status === 'lactating' && ctx.mentions.breastfeedingSafeAsk,
    reason: bilingual('A conservative breastfeeding-safe skincare path will be used.', '将按哺乳期保守路径给出建议。'),
  },
  {
    id: 'I1',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => /(impaired|damaged|不稳定|受损)/i.test(ctx.profile.barrierStatus) && ctx.mentions.retinoid,
    reason: bilingual('Compromised barrier + retinoid increases irritation risk.', '屏障受损叠加维A类会明显增加刺激风险。'),
    alternatives: bilingual('Repair barrier for 2-4 weeks before re-introduction.', '建议先修护2-4周再考虑重启。'),
  },
  {
    id: 'I2',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => /(impaired|damaged|不稳定|受损)/i.test(ctx.profile.barrierStatus) && ctx.mentions.dailyExfoliation,
    reason: bilingual('Daily exfoliation is not safe with a compromised barrier.', '屏障受损时不建议每天刷酸。'),
    alternatives: bilingual('Stop acids temporarily and focus on barrier repair.', '建议暂停酸类，优先屏障修护。'),
  },
  {
    id: 'I3',
    level: BLOCK_LEVEL.REQUIRE_INFO,
    when: (ctx) => /(high|sensitive|高|敏感)/i.test(ctx.profile.sensitivity) && ctx.mentions.multiActivesRequest,
    reason: bilingual('High sensitivity with multiple new actives needs one-priority goal first.', '高敏+多活性叠加需先确定单一目标。'),
    required_questions: ['Which one is your top goal first (acne / dark spots / anti-aging / redness)?'],
    required_questions_cn: ['你当前最优先目标是哪一个（控痘/淡斑/抗老/泛红）？'],
  },
  {
    id: 'I4',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.mentions.travelHighUv && ctx.mentions.wantsExfoliation,
    reason: bilingual('High UV exposure + exfoliation can raise irritation/pigment risk.', '高UV暴露时叠加刷酸会提高刺激和色沉风险。'),
    alternatives: bilingual('Pause exfoliation before peak sun days and prioritize SPF.', '建议高晒前暂停刷酸并优先防晒。'),
  },
  {
    id: 'I5',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.mentions.overnightFast,
    reason: bilingual('Overnight fast-result requests often lead to over-irritation.', '追求一夜见效通常会导致过度刺激。'),
    alternatives: bilingual('Use incremental frequency and tolerance-first plan.', '建议按耐受逐步加频。'),
  },
  {
    id: 'M1',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.meds.isotretinoin && ctx.mentions.retinoid,
    reason: bilingual('Oral isotretinoin + topical retinoid stacking is high risk.', '口服异维A酸期间叠加维A外用风险高。'),
    alternatives: bilingual('Use gentle hydration and sunscreen only unless clinician approves.', '除医生建议外，优先温和保湿+防晒。'),
  },
  {
    id: 'M2',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.meds.isotretinoin && ctx.mentions.strongExfoliant,
    reason: bilingual('Oral isotretinoin + strong exfoliants is high irritation risk.', '口服异维A酸期间叠加强酸风险高。'),
    alternatives: bilingual('Avoid strong exfoliants and keep routine minimal.', '建议停强酸并保持最简流程。'),
  },
  {
    id: 'M3',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ctx.mentions.tretinoinRx && ctx.mentions.aggressivePeel,
    reason: bilingual('Prescription tretinoin should not be combined with aggressive peels.', '处方维甲酸不应与激进焕肤同用。'),
    alternatives: bilingual('Choose one active path at a time.', '建议一次只走一条活性路径。'),
  },
  {
    id: 'M4',
    level: BLOCK_LEVEL.REQUIRE_INFO,
    when: (ctx) => ctx.mentions.steroidFace && ctx.mentions.strongExfoliant,
    reason: bilingual('Facial steroid context + acids needs clinical safety confirmation.', '面部激素使用场景下叠加酸类需先确认安全。'),
    required_fields: ['high_risk_medications'],
    required_questions: ['Is the facial steroid currently prescribed by a clinician?'],
    required_questions_cn: ['面部激素是否为医生当前处方？'],
  },
  {
    id: 'M5',
    level: BLOCK_LEVEL.REQUIRE_INFO,
    when: (ctx) => ctx.profile.pregnancy_status === 'unknown' && ctx.mentions.retinoid,
    reason: bilingual('Pregnancy status is needed before retinoid guidance.', '给维A建议前需先确认孕期状态。'),
    required_fields: ['pregnancy_status'],
    required_questions: ['Are you currently pregnant or trying to conceive?'],
    required_questions_cn: ['你当前是否怀孕或备孕？'],
    alternatives: bilingual('Until confirmed, use conservative non-retinoid options.', '未确认前先走非维A保守方案。'),
  },
  {
    id: 'M6',
    level: BLOCK_LEVEL.REQUIRE_INFO,
    when: (ctx) => ctx.profile.age_band === 'unknown' && ctx.mentions.strongAntiAging,
    reason: bilingual('Age band is needed before strong anti-aging actives.', '给高强度抗老活性前需先确认年龄段。'),
    required_fields: ['age_band'],
    required_questions: ['Which age band are you in?'],
    required_questions_cn: ['请问你的年龄段是？'],
  },
];

function selectText(multilang, lang) {
  if (!multilang || typeof multilang !== 'object') return '';
  if (lang === 'CN') return String(multilang.CN || multilang.EN || '').trim();
  return String(multilang.EN || multilang.CN || '').trim();
}

function dedupeStrings(values, max = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function mergeBlockLevel(a, b) {
  const left = LEVEL_WEIGHT[a] ?? 0;
  const right = LEVEL_WEIGHT[b] ?? 0;
  return right > left ? b : a;
}

function evaluateSafety({ intent, message, profile, language } = {}) {
  const ctx = buildCtx({ intent, message, profile, language });
  const matched = [];

  for (const rule of SAFETY_RULES) {
    let ok = false;
    try {
      ok = Boolean(rule.when(ctx));
    } catch {
      ok = false;
    }
    if (!ok) continue;
    matched.push(rule);
  }

  let blockLevel = BLOCK_LEVEL.INFO;
  for (const rule of matched) {
    blockLevel = mergeBlockLevel(blockLevel, rule.level);
  }

  const reasons = dedupeStrings(matched.map((rule) => selectText(rule.reason, ctx.lang)), 10);
  const safeAlternatives = dedupeStrings(matched.map((rule) => selectText(rule.alternatives, ctx.lang)), 10);

  const requiredQuestions = dedupeStrings(
    matched.flatMap((rule) => {
      if (ctx.lang === 'CN') {
        return Array.isArray(rule.required_questions_cn) ? rule.required_questions_cn : [];
      }
      return Array.isArray(rule.required_questions) ? rule.required_questions : [];
    }),
    4,
  );
  const requiredFields = dedupeStrings(
    matched.flatMap((rule) => (Array.isArray(rule.required_fields) ? rule.required_fields : [])),
    4,
  );

  return {
    block_level: blockLevel,
    reasons,
    required_fields: requiredFields,
    required_questions: requiredQuestions,
    safe_alternatives: safeAlternatives,
    matched_rules: matched.map((rule) => ({ id: rule.id, level: rule.level })),
  };
}

module.exports = {
  BLOCK_LEVEL,
  evaluateSafety,
  __internal: {
    SAFETY_RULES,
    buildCtx,
  },
};
