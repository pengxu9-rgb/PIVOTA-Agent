const { getAuroraKbV0 } = require('./kbV0/loader');
const { collectConceptIdsFromText, matchIngredientOntology } = require('./kbV0/conceptMatcher');
const {
  recordAuroraKbV0RuleMatch,
  recordAuroraKbV0LegacyFallback,
} = require('./visionMetrics');

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

const MEDICATION_ISOTRETINOIN_CONCEPT = 'MEDICATION_ISOTRETINOIN';
const KB_ISOTRETINOIN_PARITY_BLOCK_RULE_IDS = new Set([
  'MED_ISOTRETINOIN_X_AHA_WARN',
  'MED_ISOTRETINOIN_X_BHA_WARN',
  'MED_ISOTRETINOIN_X_RETINOID_WARN',
  'MED_ISOTRETINOIN_X_BPO_WARN',
  'MED_ISOTRETINOIN_X_PHYSICAL_EXFOLIANT_WARN',
]);
const ISOTRETINOIN_SPECIFIC_TOKEN_RE = /\b(isotretinoin|accutane|roaccutane)\b|异维a酸|罗可坦|泰尔丝/i;
const ISOTRETINOIN_ORAL_HINT_RE = /\boral\b|\brx\b|\bprescription\b|口服|吃药|服用|处方药|医生开药/i;

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
  if (/(lactat|breastfeed|哺乳|母乳|nursing)/i.test(raw)) return 'breastfeeding';
  if (/(unknown|不确定|未知|not sure|unsure)/i.test(raw)) return 'unknown';
  return raw;
}

function normalizeAgeBand(value) {
  const raw = lowerText(value);
  if (!raw) return 'unknown';
  if (/(under[_\s-]?13|child|kid|children|infant|toddler|baby|儿童|小孩|婴儿|幼儿|宝宝)/i.test(raw)) return 'child';
  if (/(13[_\s-]?17|teen|minor|未成年|青少年)/i.test(raw)) return 'teen';
  if (/(adult|18[_\s-]?24|25[_\s-]?34|35[_\s-]?44|45[_\s-]?54|55|成年)/i.test(raw)) return 'adult';
  if (/(unknown|不确定|未知|not sure|unsure)/i.test(raw)) return 'unknown';
  return raw;
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeMedicationToken(value) {
  const raw = lowerText(value);
  if (!raw) return '';
  if (/(isotretinoin|accutane|roaccutane|异维a酸|罗可坦|泰尔丝)/i.test(raw)) return 'isotretinoin';
  if (raw === 'medication_isotretinoin') return 'isotretinoin';
  return raw.replace(/\s+/g, '_');
}

function medicationTokenMatchesIsotretinoin(value) {
  return normalizeMedicationToken(value) === 'isotretinoin';
}

function hasExplicitOralIsotretinoinSignal(text) {
  const raw = normalizeText(text);
  if (!raw) return false;
  // Deterministic guardrail: only isotretinoin-specific tokens can promote medication context.
  // Generic topical retinoid mentions (e.g., adapalene/tretinoin cream) must not be treated as oral isotretinoin.
  if (ISOTRETINOIN_SPECIFIC_TOKEN_RE.test(raw)) return true;
  if (ISOTRETINOIN_ORAL_HINT_RE.test(raw) && /\b(isotretinoin|accutane|roaccutane)\b|异维a酸|罗可坦|泰尔丝/i.test(raw)) {
    return true;
  }
  return false;
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
    return 'breastfeeding';
  }
  if (
    /\b(while|during)\s+(lactating|breastfeeding|lactation)\b/i.test(raw) ||
    /\b(lactat|breastfeed)\b/i.test(raw) ||
    /(哺乳期|母乳期)/.test(raw)
  ) {
    return 'breastfeeding';
  }
  if (/(lactat|breastfeed|哺乳|母乳)/i.test(lower)) return 'unknown';
  return 'unknown';
}

function buildCtx({
  intent,
  message,
  profile,
  language,
  conceptIds = [],
  contraindicationTags = [],
  hasProductAnchor = false,
} = {}) {
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
    oralIsotretinoin: hasExplicitOralIsotretinoinSignal(text),
    retinoid: hasAny(lower, [/\b(retinoid|retinol|retinal|tretinoin|adapalene|tazarotene|维a|a醇|维甲酸|阿达帕林)\b/i]),
    hydroquinone: hasAny(lower, [/\b(hydroquinone|氢醌)\b/i]),
    strongSalicylic: hasAny(lower, [/(salicylic\s*acid\s*(30|20|high|strong)|高浓度水杨酸|水杨酸焕肤|bha\s*peel)/i]),
    aggressivePeel: hasAny(lower, [/(chemical\s*peel|peel\s*kit|焕肤|刷酸换肤|剥脱)/i]),
    prescription: hasAny(lower, [/(prescription|rx|处方|医生开|药膏)/i]),
    essentialOilHeavy: hasAny(lower, [/(essential\s*oil|香精精油|精油类)/i]),
    fragrance: hasAny(lower, [/(fragrance|parfum|perfume|香精|香料)/i]),
    benzoylPeroxide: hasAny(lower, [/(benzoyl\s*peroxide|bpo|过氧化苯甲酰)/i]),
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

  const conceptSet = new Set(
    (Array.isArray(conceptIds) ? conceptIds : [])
      .map((value) => normalizeText(value).toUpperCase())
      .filter(Boolean),
  );
  if (mentions.retinoid) conceptSet.add('RETINOID');
  if (mentions.benzoylPeroxide) conceptSet.add('BENZOYL_PEROXIDE');
  if (mentions.hydroquinone) conceptSet.add('HYDROQUINONE');
  if (mentions.strongSalicylic) {
    conceptSet.add('BHA');
    conceptSet.add('SALICYLIC_ACID');
    conceptSet.add('HIGH_STRENGTH');
  }
  if (mentions.aggressivePeel) conceptSet.add('CHEMICAL_PEEL');
  if (mentions.prescription) conceptSet.add('PRESCRIPTION_MEDICATION');
  if (mentions.essentialOilHeavy) conceptSet.add('ESSENTIAL_OIL');
  if (mentions.fragrance) conceptSet.add('FRAGRANCE');
  if (mentions.strongExfoliant) conceptSet.add('EXFOLIANT');
  if (mentions.dailyExfoliation) conceptSet.add('DAILY_EXFOLIATION');
  if (mentions.travelHighUv) {
    conceptSet.add('TRAVEL');
    conceptSet.add('HIGH_UV');
    conceptSet.add('SUN_EXPOSURE');
  }
  if (mentions.wantsExfoliation) conceptSet.add('EXFOLIANT');
  if (mentions.tretinoinRx) {
    conceptSet.add('TRETINOIN');
    conceptSet.add('PRESCRIPTION_MEDICATION');
  }
  if (mentions.breastfeedingSafeAsk) conceptSet.add('BREASTFEEDING');
  if (p.pregnancy_status === 'pregnant') conceptSet.add('PREGNANT');
  if (p.pregnancy_status === 'trying') conceptSet.add('TRYING_TO_CONCEIVE');
  if (p.lactation_status === 'breastfeeding') conceptSet.add('BREASTFEEDING');
  if (p.age_band === 'child') conceptSet.add('AGE_UNDER_13');
  if (p.age_band === 'teen') conceptSet.add('AGE_13_17');
  if (/(impaired|damaged|不稳定|受损)/i.test(p.barrierStatus)) conceptSet.add('BARRIER_COMPROMISED');
  if (/(high|sensitive|高|敏感)/i.test(p.sensitivity)) conceptSet.add('SENSITIVE_SKIN');

  const medicationsAnySet = new Set(
    p.high_risk_medications.map((value) => normalizeMedicationToken(value)).filter(Boolean),
  );
  if (conceptSet.has(MEDICATION_ISOTRETINOIN_CONCEPT) || mentions.oralIsotretinoin) {
    medicationsAnySet.add('isotretinoin');
    medicationsAnySet.add('medication_isotretinoin');
  }

  const meds = {
    isotretinoin:
      medsLower.some((m) => medicationTokenMatchesIsotretinoin(m)) ||
      medicationsAnySet.has('isotretinoin') ||
      conceptSet.has(MEDICATION_ISOTRETINOIN_CONCEPT),
  };
  if (meds.isotretinoin) {
    conceptSet.add(MEDICATION_ISOTRETINOIN_CONCEPT);
    medicationsAnySet.add('isotretinoin');
    medicationsAnySet.add('medication_isotretinoin');
    if (!p.high_risk_medications.some((m) => medicationTokenMatchesIsotretinoin(m))) {
      p.high_risk_medications = [...p.high_risk_medications, 'isotretinoin'];
    }
  }

  const normalizedContraindicationTags = Array.from(
    new Set(
      (Array.isArray(contraindicationTags) ? contraindicationTags : [])
        .map((value) => normalizeText(value).toLowerCase())
        .filter(Boolean),
    ),
  );

  return {
    intent: String(intent || ''),
    message: text,
    lower,
    lang,
    profile: p,
    mentions,
    meds,
    medications_any: Array.from(medicationsAnySet),
    concept_ids: Array.from(conceptSet),
    contraindication_tags: normalizedContraindicationTags,
    has_product_anchor: Boolean(hasProductAnchor),
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
    when: (ctx) => ['breastfeeding', 'lactating'].includes(ctx.profile.lactation_status) && ctx.mentions.oralIsotretinoin,
    reason: bilingual('Do not use oral isotretinoin during breastfeeding.', '哺乳期不建议口服异维A酸。'),
    alternatives: bilingual('Use conservative topical options and consult clinician.', '建议保守外用并咨询医生。'),
  },
  {
    id: 'L2',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ['breastfeeding', 'lactating'].includes(ctx.profile.lactation_status) && ctx.mentions.retinoid && ctx.mentions.chestArea,
    reason: bilingual('Avoid applying retinoids on chest/areola while breastfeeding.', '哺乳期避免在胸前/乳晕区域使用维A类。'),
    alternatives: bilingual('Use non-retinoid barrier products for that area.', '该区域优先使用非维A修护品。'),
  },
  {
    id: 'L3',
    level: BLOCK_LEVEL.WARN,
    when: (ctx) => ['breastfeeding', 'lactating'].includes(ctx.profile.lactation_status) && ctx.mentions.aggressivePeel,
    reason: bilingual('Strong peel routines can increase irritation during lactation.', '哺乳期激进焕肤更易刺激。'),
    alternatives: bilingual('Prefer gentle routine and reduce active overlap.', '建议温和流程并减少活性叠加。'),
  },
  {
    id: 'L4',
    level: BLOCK_LEVEL.INFO,
    when: (ctx) => ['breastfeeding', 'lactating'].includes(ctx.profile.lactation_status) && ctx.mentions.breastfeedingSafeAsk,
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
    id: 'M2B',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.meds.isotretinoin && ctx.mentions.benzoylPeroxide,
    reason: bilingual('Oral isotretinoin + benzoyl peroxide is high irritation risk.', '口服异维A酸期间叠加过氧化苯甲酰风险高。'),
    alternatives: bilingual('Pause benzoyl peroxide and keep a gentle routine unless clinician advised.', '除医生特别建议外，建议暂停过氧化苯甲酰并保持温和流程。'),
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
  {
    id: 'C1',
    level: BLOCK_LEVEL.BLOCK,
    when: (ctx) => ctx.profile.age_band === 'child' && (ctx.mentions.essentialOilHeavy || ctx.mentions.fragrance),
    reason: bilingual(
      'For infant/toddler skin, avoid fragrance or essential-oil-heavy products.',
      '婴幼儿皮肤建议避免香精或高精油配方。',
    ),
    alternatives: bilingual(
      'Use fragrance-free, minimal-ingredient products designed for children.',
      '建议改用无香精、成分精简的儿童友好配方。',
    ),
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

const CONTEXT_ANCHOR_CONCEPTS = new Set([
  'BARRIER_COMPROMISED',
  'SUNBURN',
  'PROCEDURE_RECENT',
  'EYE_AREA',
  'CONTACT_ALLERGY_HISTORY',
  'SENSITIVE_SKIN',
  'TRAVEL',
  'HIGH_UV',
  'PRODUCT_EVAL_REQUEST',
]);

function normalizeBlockLevel(level) {
  const value = String(level || '').trim().toUpperCase();
  if (value === BLOCK_LEVEL.BLOCK || value === BLOCK_LEVEL.REQUIRE_INFO || value === BLOCK_LEVEL.WARN || value === BLOCK_LEVEL.INFO) {
    return value;
  }
  return BLOCK_LEVEL.INFO;
}

function normalizeConceptIds(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalizeText(raw).toUpperCase();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function statusMatches(allowedRaw, currentRaw, synonyms = {}) {
  const allowed = normalizeText(allowedRaw).toLowerCase();
  const current = normalizeText(currentRaw).toLowerCase();
  if (!allowed) return true;
  if (!current) return false;
  if (allowed === current) return true;
  const currentSyn = Array.isArray(synonyms[current]) ? synonyms[current] : [];
  const allowedSyn = Array.isArray(synonyms[allowed]) ? synonyms[allowed] : [];
  if (currentSyn.includes(allowed) || allowedSyn.includes(current)) return true;
  return false;
}

function countConceptHits(requiredConcepts, presentSet) {
  const required = normalizeConceptIds(requiredConcepts);
  if (!required.length) return 0;
  let hits = 0;
  for (const conceptId of required) {
    if (presentSet.has(conceptId)) hits += 1;
  }
  return hits;
}

function matchPrimaryConceptSet(requiredConcepts, presentSet) {
  const required = normalizeConceptIds(requiredConcepts);
  if (!required.length) return true;
  const hits = countConceptHits(required, presentSet);
  if (required.length === 1) return hits >= 1;

  const anchors = required.filter((conceptId) => CONTEXT_ANCHOR_CONCEPTS.has(conceptId));
  if (anchors.length > 0) {
    const anchorHits = anchors.filter((conceptId) => presentSet.has(conceptId)).length;
    return anchorHits >= 1 && hits >= 2;
  }

  if (required.length === 2) return hits >= 2;
  return hits >= 2;
}

function matchSecondaryConceptSet(requiredConcepts, presentSet) {
  const required = normalizeConceptIds(requiredConcepts);
  if (!required.length) return true;
  for (const conceptId of required) {
    if (presentSet.has(conceptId)) return true;
  }
  return false;
}

function profileFieldMissing(ctx, field) {
  const key = normalizeText(field).toLowerCase();
  if (!key) return false;
  if (key === 'pregnancy_status') return normalizeText(ctx.profile && ctx.profile.pregnancy_status).toLowerCase() === 'unknown';
  if (key === 'lactation_status') return normalizeText(ctx.profile && ctx.profile.lactation_status).toLowerCase() === 'unknown';
  if (key === 'age_band') return normalizeText(ctx.profile && ctx.profile.age_band).toLowerCase() === 'unknown';
  if (key === 'high_risk_medications') return !Array.isArray(ctx.profile && ctx.profile.high_risk_medications) || ctx.profile.high_risk_medications.length === 0;
  if (key === 'product_anchor') return !ctx.has_product_anchor;
  const direct = ctx.profile && typeof ctx.profile === 'object' ? ctx.profile[key] : undefined;
  if (Array.isArray(direct)) return direct.length === 0;
  return !normalizeText(direct);
}

function questionForRequiredField(field, lang) {
  const key = normalizeText(field).toLowerCase();
  if (key === 'pregnancy_status') return lang === 'CN' ? '你当前是否怀孕或备孕？' : 'Are you currently pregnant or trying to conceive?';
  if (key === 'lactation_status') return lang === 'CN' ? '你当前是否在哺乳期？' : 'Are you currently breastfeeding?';
  if (key === 'age_band') return lang === 'CN' ? '请问你的年龄段是？' : 'Which age band are you in?';
  if (key === 'high_risk_medications') return lang === 'CN' ? '你当前是否在使用处方/口服治疗药物？' : 'Are you currently using any prescription or oral treatment medication?';
  if (key === 'product_anchor') return lang === 'CN' ? '请提供要评估的产品链接或完整产品名。' : 'Please share the product link or full product name to evaluate.';
  return '';
}

function resolveConceptLabel(kb, conceptId, lang) {
  const id = normalizeText(conceptId).toUpperCase();
  if (!id) return '';
  const concept = kb && kb.concepts_by_id && kb.concepts_by_id[id] ? kb.concepts_by_id[id] : null;
  if (!concept || typeof concept !== 'object') return id;
  const labels = concept.labels && typeof concept.labels === 'object' ? concept.labels : {};
  if (lang === 'CN') return normalizeText(labels.zh || labels.en || id);
  return normalizeText(labels.en || labels.zh || id);
}

function evaluateKbRules({ ctx, kb }) {
  const matched = [];
  if (!kb || kb.ok === false) return matched;
  const presentConcepts = new Set(normalizeConceptIds(ctx.concept_ids));
  const rules = Array.isArray(kb.safety_rules && kb.safety_rules.rules) ? kb.safety_rules.rules : [];
  const templates = kb.templates_by_id && typeof kb.templates_by_id === 'object' ? kb.templates_by_id : {};
  const medsLower = Array.isArray(ctx.profile && ctx.profile.high_risk_medications)
    ? ctx.profile.high_risk_medications.map((m) => normalizeText(m).toLowerCase())
    : [];
  const medsAnySet = new Set([
    ...medsLower.map((value) => normalizeMedicationToken(value)),
    ...((Array.isArray(ctx.medications_any) ? ctx.medications_any : []).map((value) => normalizeMedicationToken(value))),
  ].filter(Boolean));

  for (const rule of rules) {
    const trigger = rule && typeof rule.trigger === 'object' ? rule.trigger : {};
    const lifeStage = trigger.life_stage && typeof trigger.life_stage === 'object' ? trigger.life_stage : {};
    const pregnancyAllowed = Array.isArray(lifeStage.pregnancy_status) ? lifeStage.pregnancy_status : [];
    const lactationAllowed = Array.isArray(lifeStage.lactation_status) ? lifeStage.lactation_status : [];
    const ageAllowed = Array.isArray(lifeStage.age_band) ? lifeStage.age_band : [];
    const medicationsAny = Array.isArray(lifeStage.medications_any) ? lifeStage.medications_any : [];
    const requiredContextMissing = Array.isArray(trigger.required_context_missing) ? trigger.required_context_missing : [];
    const primaryConcepts = Array.isArray(trigger.concepts_any) ? trigger.concepts_any : [];
    const secondaryConcepts = Array.isArray(trigger.concepts_any_2) ? trigger.concepts_any_2 : [];

    if (pregnancyAllowed.length > 0) {
      const ok = pregnancyAllowed.some((value) =>
        statusMatches(value, ctx.profile.pregnancy_status, {
          pregnant: ['pregnant'],
          trying: ['trying', 'trying_to_conceive'],
          unknown: ['unknown'],
        }));
      if (!ok) continue;
    }
    if (lactationAllowed.length > 0) {
      const ok = lactationAllowed.some((value) =>
        statusMatches(value, ctx.profile.lactation_status, {
          breastfeeding: ['breastfeeding', 'lactating'],
          lactating: ['breastfeeding', 'lactating'],
          unknown: ['unknown'],
        }));
      if (!ok) continue;
    }
    if (ageAllowed.length > 0) {
      const ok = ageAllowed.some((value) =>
        statusMatches(value, ctx.profile.age_band, {
          child: ['child', 'under_13', 'minor'],
          teen: ['teen', '13_17', 'minor'],
          unknown: ['unknown'],
        }));
      if (!ok) continue;
    }
    if (medicationsAny.length > 0) {
      const medsOk = medicationsAny.some((required) => {
        const req = normalizeMedicationToken(required);
        if (!req) return false;
        if (req === 'isotretinoin') return ctx.meds.isotretinoin || medsAnySet.has('isotretinoin');
        return medsAnySet.has(req) || medsLower.some((med) => med.includes(req));
      });
      if (!medsOk) continue;
    }
    if (requiredContextMissing.length > 0) {
      const missingAny = requiredContextMissing.some((field) => profileFieldMissing(ctx, field));
      if (!missingAny) continue;
    }
    if (!matchPrimaryConceptSet(primaryConcepts, presentConcepts)) continue;
    if (!matchSecondaryConceptSet(secondaryConcepts, presentConcepts)) continue;

    const decision = rule && typeof rule.decision === 'object' ? rule.decision : {};
    const blockLevelRaw = normalizeBlockLevel(decision.block_level);
    const ruleIdUpper = normalizeText(rule.rule_id).toUpperCase();
    const blockLevel = (blockLevelRaw === BLOCK_LEVEL.WARN && ctx.meds.isotretinoin && KB_ISOTRETINOIN_PARITY_BLOCK_RULE_IDS.has(ruleIdUpper))
      ? BLOCK_LEVEL.BLOCK
      : blockLevelRaw;
    const requiredFields = dedupeStrings(Array.isArray(decision.required_fields) ? decision.required_fields : [], 8);
    const templateId = normalizeText(decision.template_id);
    const template = templateId && templates[templateId] ? templates[templateId] : null;
    const templateText = normalizeText(ctx.lang === 'CN' ? template && template.text_zh : template && template.text_en) ||
      normalizeText(ctx.lang === 'CN' ? template && template.text_en : template && template.text_zh);
    const reasonText = templateText || normalizeText(rule && rule.rationale);

    const requiredQuestions = dedupeStrings([
      ...(blockLevel === BLOCK_LEVEL.REQUIRE_INFO && templateText ? [templateText] : []),
      ...requiredFields.map((field) => questionForRequiredField(field, ctx.lang)).filter(Boolean),
    ], 4);

    const safeAlternatives = dedupeStrings(
      (Array.isArray(decision.safe_alternatives_concepts) ? decision.safe_alternatives_concepts : [])
        .map((conceptId) => resolveConceptLabel(kb, conceptId, ctx.lang))
        .filter(Boolean),
      8,
    );
    const triggeredBy = dedupeStrings([
      ...(primaryConcepts.length > 0 || secondaryConcepts.length > 0 ? ['concepts'] : []),
      ...(pregnancyAllowed.length > 0 || lactationAllowed.length > 0 || ageAllowed.length > 0 ? ['life_stage'] : []),
      ...(medicationsAny.length > 0 ? ['medications'] : []),
    ], 4);

    recordAuroraKbV0RuleMatch({ source: 'kb_v0', ruleId: rule.rule_id, level: blockLevel });
    matched.push({
      id: `kb_v0:${normalizeText(rule.rule_id)}`,
      level: blockLevel,
      reason: reasonText,
      alternatives: safeAlternatives,
      required_fields: requiredFields,
      required_questions: requiredQuestions,
      _triggered_by: triggeredBy,
    });
  }

  return matched;
}

function evaluateOntologyContraindications(ctx) {
  const matched = [];
  const tags = new Set(
    (Array.isArray(ctx.contraindication_tags) ? ctx.contraindication_tags : [])
      .map((tag) => normalizeText(tag).toLowerCase())
      .filter(Boolean),
  );
  const preg = ctx.profile && ctx.profile.pregnancy_status;
  const isPregOrTrying = preg === 'pregnant' || preg === 'trying';
  const barrierCompromised = /(impaired|damaged|不稳定|受损)/i.test(normalizeText(ctx.profile && ctx.profile.barrierStatus));

  if (isPregOrTrying && (tags.has('pregnancy_strict_avoid') || tags.has('trying_strict_avoid'))) {
    recordAuroraKbV0RuleMatch({ source: 'kb_v0', ruleId: 'ONTOLOGY_PREGNANCY_STRICT_AVOID', level: BLOCK_LEVEL.BLOCK });
    matched.push({
      id: 'kb_v0:ONTOLOGY_PREGNANCY_STRICT_AVOID',
      level: BLOCK_LEVEL.BLOCK,
      reason: ctx.lang === 'CN' ? '该成分在孕期/备孕阶段应严格避免。' : 'This ingredient should be strictly avoided during pregnancy/trying to conceive.',
      alternatives: [],
      required_fields: [],
      required_questions: [],
      _triggered_by: ['ingredients', 'life_stage'],
    });
  } else if (isPregOrTrying && (tags.has('pregnancy_avoid') || tags.has('trying_avoid'))) {
    recordAuroraKbV0RuleMatch({ source: 'kb_v0', ruleId: 'ONTOLOGY_PREGNANCY_AVOID', level: BLOCK_LEVEL.BLOCK });
    matched.push({
      id: 'kb_v0:ONTOLOGY_PREGNANCY_AVOID',
      level: BLOCK_LEVEL.BLOCK,
      reason: ctx.lang === 'CN' ? '该成分在孕期/备孕阶段建议避免。' : 'This ingredient is generally avoided during pregnancy/trying to conceive.',
      alternatives: [],
      required_fields: [],
      required_questions: [],
      _triggered_by: ['ingredients', 'life_stage'],
    });
  }

  if (barrierCompromised && tags.has('barrier_compromised_caution')) {
    recordAuroraKbV0RuleMatch({ source: 'kb_v0', ruleId: 'ONTOLOGY_BARRIER_CAUTION', level: BLOCK_LEVEL.WARN });
    matched.push({
      id: 'kb_v0:ONTOLOGY_BARRIER_CAUTION',
      level: BLOCK_LEVEL.WARN,
      reason: ctx.lang === 'CN' ? '屏障受损状态下该成分可能增加刺激风险。' : 'This ingredient can increase irritation risk when the skin barrier is compromised.',
      alternatives: [],
      required_fields: [],
      required_questions: [],
      _triggered_by: ['ingredients', 'concepts'],
    });
  }

  if (tags.has('rx_only_consult') && !ctx.mentions.prescription) {
    recordAuroraKbV0RuleMatch({ source: 'kb_v0', ruleId: 'ONTOLOGY_RX_CONSULT', level: BLOCK_LEVEL.REQUIRE_INFO });
    matched.push({
      id: 'kb_v0:ONTOLOGY_RX_CONSULT',
      level: BLOCK_LEVEL.REQUIRE_INFO,
      reason: ctx.lang === 'CN' ? '该成分通常涉及处方场景，建议先确认是否在医生指导下使用。' : 'This ingredient is commonly prescription-context; confirm clinician guidance before use.',
      alternatives: [],
      required_fields: ['high_risk_medications'],
      required_questions: [questionForRequiredField('high_risk_medications', ctx.lang)].filter(Boolean),
      _triggered_by: ['ingredients', 'medications'],
    });
  }

  return matched;
}

function inferLegacyTriggeredBy(ctx) {
  const triggered = [];
  if (Array.isArray(ctx && ctx.concept_ids) && ctx.concept_ids.length > 0) triggered.push('concepts');
  if (
    ctx &&
    ctx.profile &&
    (
      normalizeText(ctx.profile.pregnancy_status).toLowerCase() !== 'unknown' ||
      normalizeText(ctx.profile.lactation_status).toLowerCase() !== 'unknown' ||
      normalizeText(ctx.profile.age_band).toLowerCase() !== 'unknown'
    )
  ) {
    triggered.push('life_stage');
  }
  if ((ctx && ctx.meds && ctx.meds.isotretinoin) || (ctx && ctx.profile && Array.isArray(ctx.profile.high_risk_medications) && ctx.profile.high_risk_medications.length > 0)) {
    triggered.push('medications');
  }
  if (ctx && ctx.mentions && (ctx.mentions.essentialOilHeavy || ctx.mentions.fragrance)) {
    triggered.push('ingredients');
  }
  return dedupeStrings(triggered, 4);
}

function evaluateLegacyRules(ctx) {
  const matched = [];
  for (const rule of SAFETY_RULES) {
    let ok = false;
    try {
      ok = Boolean(rule.when(ctx));
    } catch {
      ok = false;
    }
    if (!ok) continue;
    recordAuroraKbV0RuleMatch({ source: 'legacy', ruleId: rule.id, level: rule.level });
    matched.push({
      id: `legacy:${rule.id}`,
      level: rule.level,
      reason: selectText(rule.reason, ctx.lang),
      alternatives: selectText(rule.alternatives, ctx.lang) ? [selectText(rule.alternatives, ctx.lang)] : [],
      required_fields: Array.isArray(rule.required_fields) ? rule.required_fields : [],
      required_questions: ctx.lang === 'CN'
        ? (Array.isArray(rule.required_questions_cn) ? rule.required_questions_cn : [])
        : (Array.isArray(rule.required_questions) ? rule.required_questions : []),
      _triggered_by: inferLegacyTriggeredBy(ctx),
    });
  }
  return matched;
}

function evaluateSafety({
  intent,
  message,
  profile,
  language,
  matched_concepts,
  matched_concepts_debug,
  ingredient_ontology_hits,
  contraindication_tags,
  has_product_anchor,
} = {}) {
  const lang = normalizeLanguage(language);
  const messageText = normalizeText(message);
  const kbDetectedConcepts = collectConceptIdsFromText({
    text: messageText,
    language: lang,
    max: 96,
    includeSubstring: true,
  });
  const ontologyHits = Array.isArray(ingredient_ontology_hits)
    ? ingredient_ontology_hits
    : matchIngredientOntology({ text: messageText, language: lang, max: 32 });
  const ontologyConcepts = normalizeConceptIds(
    (Array.isArray(ontologyHits) ? ontologyHits : []).flatMap((item) => (Array.isArray(item && item.classes) ? item.classes : [])),
  );
  const ontologyContraindicationTags = dedupeStrings(
    (Array.isArray(ontologyHits) ? ontologyHits : []).flatMap((item) => (Array.isArray(item && item.contraindication_tags) ? item.contraindication_tags : [])),
    48,
  );
  const mergedConcepts = normalizeConceptIds([
    ...(Array.isArray(matched_concepts) ? matched_concepts : []),
    ...kbDetectedConcepts,
    ...ontologyConcepts,
  ]);
  const mergedContraindicationTags = dedupeStrings([
    ...(Array.isArray(contraindication_tags) ? contraindication_tags : []),
    ...ontologyContraindicationTags,
  ], 64);
  const conceptDebugRows = Array.isArray(matched_concepts_debug) ? matched_concepts_debug : [];

  const ctx = buildCtx({
    intent,
    message: messageText,
    profile,
    language: lang,
    conceptIds: mergedConcepts,
    contraindicationTags: mergedContraindicationTags,
    hasProductAnchor: Boolean(has_product_anchor),
  });

  const kb = getAuroraKbV0();
  const kbAvailable = Boolean(kb && kb.ok && !kb.disabled);

  const kbMatches = kbAvailable
    ? [
      ...evaluateKbRules({ ctx, kb }),
      ...evaluateOntologyContraindications(ctx),
    ]
    : [];
  const legacyMatches = evaluateLegacyRules(ctx);

  if (!kbAvailable && legacyMatches.length > 0) {
    recordAuroraKbV0LegacyFallback({ reason: (kb && kb.reason) || 'loader_unavailable' });
  } else if (kbAvailable && kbMatches.length === 0 && legacyMatches.length > 0) {
    recordAuroraKbV0LegacyFallback({ reason: 'no_kb_match' });
  }

  const matched = [...kbMatches, ...legacyMatches];
  let blockLevel = BLOCK_LEVEL.INFO;
  for (const rule of matched) {
    blockLevel = mergeBlockLevel(blockLevel, normalizeBlockLevel(rule.level));
  }

  const reasons = dedupeStrings(matched.map((rule) => normalizeText(rule.reason)).filter(Boolean), 10);
  const safeAlternatives = dedupeStrings(matched.flatMap((rule) => (Array.isArray(rule.alternatives) ? rule.alternatives : [])), 10);
  const requiredQuestions = dedupeStrings(matched.flatMap((rule) => (Array.isArray(rule.required_questions) ? rule.required_questions : [])), 6);
  const requiredFields = dedupeStrings(matched.flatMap((rule) => (Array.isArray(rule.required_fields) ? rule.required_fields : [])), 6);
  const decisiveRules = matched.filter((rule) => normalizeBlockLevel(rule.level) === blockLevel);
  const decisionSource = decisiveRules.some((rule) => String(rule.id || '').startsWith('kb_v0:')) || (kbMatches.length > 0 && legacyMatches.length === 0)
    ? 'kb_v0'
    : 'legacy';
  const triggeredBy = dedupeStrings([
    ...matched.flatMap((rule) => (Array.isArray(rule._triggered_by) ? rule._triggered_by : [])),
    ...(conceptDebugRows.length > 0 ? ['concepts'] : []),
    ...(ontologyHits.length > 0 || mergedContraindicationTags.length > 0 ? ['ingredients'] : []),
    ...((ctx.profile.pregnancy_status !== 'unknown' || ctx.profile.lactation_status !== 'unknown' || ctx.profile.age_band !== 'unknown') ? ['life_stage'] : []),
    ...((ctx.meds.isotretinoin || (Array.isArray(ctx.profile.high_risk_medications) && ctx.profile.high_risk_medications.length > 0)) ? ['medications'] : []),
  ], 4);

  return {
    block_level: blockLevel,
    decision_source: decisionSource,
    triggered_by: triggeredBy,
    reasons,
    required_fields: requiredFields,
    required_questions: requiredQuestions,
    safe_alternatives: safeAlternatives,
    matched_rules: matched.map((rule) => ({ id: rule.id, level: normalizeBlockLevel(rule.level) })),
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
