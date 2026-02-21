const UI_RECO_STATES = new Set(['RECO_GATE', 'RECO_CONSTRAINTS', 'RECO_RESULTS']);

const FIELD_MISSING_REASON_ENUM = Object.freeze([
  'not_provided_by_user',
  'parse_failed',
  'needs_disambiguation',
  'catalog_not_available',
  'feature_flag_disabled',
  'low_confidence',
  'frontend_disallows_external_seed',
  'upstream_timeout',
  'analysis_budget_timeout',
  'low_confidence_treatment_filtered',
]);

const TEXT_MAX_CHARS = 280;
const MARKDOWN_MAX_CHARS = 520;
const DEFAULT_MAX_CHIPS = 10;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLanguage(language) {
  return String(language || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeMessageContent(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (isPlainObject(message) && typeof message.content === 'string') return message.content;
  return '';
}

function normalizeMessageFormat(message, fallback = 'text') {
  if (typeof message === 'string') return fallback;
  if (isPlainObject(message) && typeof message.format === 'string') {
    const format = message.format.trim().toLowerCase();
    if (format === 'text' || format === 'markdown') return format;
  }
  return fallback;
}

function cardTypeSet(cards) {
  const set = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    const type = String(card && card.type ? card.type : '').trim().toLowerCase();
    if (type) set.add(type);
  }
  return set;
}

function findCard(cards, type) {
  const target = String(type || '').trim().toLowerCase();
  if (!target) return null;
  return (Array.isArray(cards) ? cards : []).find(
    (card) => String(card && card.type ? card.type : '').trim().toLowerCase() === target,
  ) || null;
}

function trimToLimit(text, maxChars) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function isGenericAssistantMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  return (
    lower.includes('structured cards below') ||
    lower.includes('see the cards below') ||
    lower.includes('did not receive any renderable structured cards') ||
    raw.includes('见下方卡片') ||
    raw.includes('结构化卡片')
  );
}

function extractCurrentClarificationNormId(context) {
  const pending = context && context.pending_clarification;
  if (pending && isPlainObject(pending.current)) {
    const normId = String(
      pending.current.norm_id || pending.current.normId || pending.current.id || '',
    ).trim();
    if (normId) return normId;
  }

  const sessionPatchState =
    context && isPlainObject(context.session_patch) && isPlainObject(context.session_patch.state)
      ? context.session_patch.state
      : null;
  const pendingFromPatch =
    sessionPatchState && isPlainObject(sessionPatchState.pending_clarification)
      ? sessionPatchState.pending_clarification
      : null;
  if (pendingFromPatch && isPlainObject(pendingFromPatch.current)) {
    const normId = String(
      pendingFromPatch.current.norm_id || pendingFromPatch.current.normId || pendingFromPatch.current.id || '',
    ).trim();
    if (normId) return normId;
  }

  return null;
}

function selectTemplate(context = {}) {
  const cards = Array.isArray(context.cards) ? context.cards : [];
  const types = cardTypeSet(cards);
  const sessionPatch = isPlainObject(context.session_patch) ? context.session_patch : {};
  const nextState = String(sessionPatch.next_state || '').trim();

  const has = (type) => types.has(String(type || '').trim().toLowerCase());
  const gateCard = findCard(cards, 'diagnosis_gate');
  const gateWants = String(gateCard && gateCard.payload && gateCard.payload.wants ? gateCard.payload.wants : '').trim().toLowerCase();

  if (has('recommendations') && UI_RECO_STATES.has(nextState || 'RECO_RESULTS')) {
    return {
      id: 'recommendations_output.standard',
      module: 'recommendations_output',
      variant: 'standard',
      reason: 'recommendations_card_present',
      message_format: 'markdown',
    };
  }

  const pendingNormId = extractCurrentClarificationNormId(context);
  if (pendingNormId || gateCard) {
    const variant = context && context.clarification_unknown_streak >= 2 ? 'degraded' : 'standard';
    return {
      id: `diagnosis_clarification.${variant}`,
      module: 'diagnosis_clarification',
      variant,
      reason: pendingNormId ? 'pending_clarification_current' : 'diagnosis_gate',
      message_format: 'text',
      current_norm_id: pendingNormId || null,
      wants: gateWants || null,
    };
  }

  if (has('analysis_summary')) {
    const analysis = findCard(cards, 'analysis_summary');
    const payload = isPlainObject(analysis && analysis.payload) ? analysis.payload : {};
    if (payload.used_photos === false || payload.photos_provided === false) {
      return {
        id: 'no_photo_analysis_degrade.standard',
        module: 'no_photo_analysis_degrade',
        variant: 'standard',
        reason: 'analysis_summary_no_photo',
        message_format: 'text',
      };
    }
  }

  if (has('env_stress')) {
    return {
      id: 'env_weather_qa.standard',
      module: 'env_weather_qa',
      variant: 'standard',
      reason: 'env_stress_present',
      message_format: 'markdown',
    };
  }

  if (context.intent === 'weather_env') {
    return {
      id: 'env_weather_qa.degraded',
      module: 'env_weather_qa',
      variant: 'degraded',
      reason: 'env_stress_missing',
      message_format: 'markdown',
    };
  }

  if (has('product_parse') || has('product_analysis') || nextState === 'PRODUCT_LINK_EVAL') {
    const parseCard = findCard(cards, 'product_parse');
    const parseMissing = Array.isArray(parseCard && parseCard.field_missing) ? parseCard.field_missing : [];
    const parseFailed = parseMissing.some((fm) => fm && fm.field === 'payload.product_ref');
    return {
      id: `product_evaluation.${parseFailed ? 'degraded' : 'standard'}`,
      module: 'product_evaluation',
      variant: parseFailed ? 'degraded' : 'standard',
      reason: parseFailed ? 'product_parse_missing_ref' : 'product_eval_route',
      message_format: 'text',
    };
  }

  if (gateWants === 'recommendation' && !has('recommendations')) {
    return {
      id: 'recommendations_output.degraded',
      module: 'recommendations_output',
      variant: 'degraded',
      reason: 'reco_gate_without_recommendations',
      message_format: 'text',
    };
  }

  return {
    id: 'global.default',
    module: 'global',
    variant: 'default',
    reason: 'no_template_match',
    message_format: 'text',
  };
}

function renderDiagnosisMessage({ lang, variant, currentNormId }) {
  const norm = String(currentNormId || '').trim().toLowerCase();
  if (lang === 'CN') {
    if (variant === 'degraded') {
      return {
        format: 'text',
        content: '没关系，我们先按低刺激通用方案走。为了更贴合你，我先确认一个问题：你最近更容易刺痛或泛红吗？',
      };
    }
    if (norm === 'sensitivity') {
      return {
        format: 'text',
        content: '可以。为了给到准确建议，我先确认 1 个问题：你更偏低敏、中敏还是高敏？（会影响活性强度和引入频率）',
      };
    }
    if (norm === 'barrierstatus' || norm === 'barrier_status') {
      return {
        format: 'text',
        content: '可以。我先确认 1 个问题：你现在的屏障状态更像稳定、偶尔刺痛，还是经常泛红刺痛？（决定先修护还是先上功效）',
      };
    }
    if (norm === 'goals') {
      return {
        format: 'text',
        content: '可以。我先确认 1 个问题：你现在最优先想解决什么？例如控痘、淡印、修护或抗老。',
      };
    }
    return {
      format: 'text',
      content: '可以。为了给到准确建议，我先确认 1 个问题：你更偏干、偏油，还是混合？（会决定清洁和保湿强度）',
    };
  }

  if (variant === 'degraded') {
    return {
      format: 'text',
      content: 'No worries. We can start with a low-irritation baseline. One quick check to personalize it: do you sting or flush easily?',
    };
  }

  if (norm === 'sensitivity') {
    return {
      format: 'text',
      content: 'Sure. One quick check so I can be precise: would you describe your skin as low, medium, or high sensitivity?',
    };
  }

  if (norm === 'barrierstatus' || norm === 'barrier_status') {
    return {
      format: 'text',
      content: 'Sure. One quick check first: is your barrier mostly stable, occasionally stings, or often red/stings?',
    };
  }

  if (norm === 'goals') {
    return {
      format: 'text',
      content: 'Sure. One quick check first: what is your top goal now, acne control, dark spots, barrier repair, or anti-aging?',
    };
  }

  return {
    format: 'text',
    content: 'Sure. One quick check so I can be precise: is your skin more oily, dry, or combination?',
  };
}

function renderEnvMessage({ lang, variant }) {
  if (lang === 'CN') {
    if (variant === 'degraded') {
      return {
        format: 'markdown',
        content: '**结论：先稳屏障再谈功效**\n- 减少去角质/刷酸频次\n- 面霜可更厚一点，必要时薄涂封闭\n- 室内加湿并避免过热洗浴\n\n告诉我偏干还是偏油，我可给你 AM/PM 版本。',
      };
    }
    return {
      format: 'markdown',
      content: '**结论：此类天气优先减刺激+加封闭**\n- 洁面更温和，避免过度去脂\n- 先补水再封闭，减少干痒\n- 外出加强防晒和物理遮挡\n\n要不要我按你的肤质生成 AM/PM 流程？',
    };
  }

  if (variant === 'degraded') {
    return {
      format: 'markdown',
      content: '**Bottom line: stabilize barrier first**\n- Reduce acids/exfoliation\n- Use a richer moisturizer; add a thin occlusive layer if needed\n- Humidify indoors and avoid very hot showers\n\nTell me oily vs dry and I can tailor an AM/PM version.',
    };
  }
  return {
    format: 'markdown',
    content: '**Bottom line: less irritation + more seal**\n- Cleanse gently and avoid over-stripping\n- Hydrate first, then seal\n- Add sunscreen + physical cover outdoors\n\nWant an AM/PM plan based on your skin type?',
  };
}

function renderProductMessage({ lang, variant }) {
  if (lang === 'CN') {
    if (variant === 'degraded') {
      return {
        format: 'text',
        content: '我暂时无法确定你指的是哪一款。请补充规格/系列名，或再发链接/图片，我就能继续做成分与适配评估。',
      };
    }
    return {
      format: 'text',
      content: '我先对齐产品并看关键成分。你更关心控痘、淡印还是保湿修护？我会按目标给出可执行结论。',
    };
  }

  if (variant === 'degraded') {
    return {
      format: 'text',
      content: 'I cannot pin down the exact variant yet. Share the line/size or another link/photo, and I will continue with ingredient-fit evaluation.',
    };
  }
  return {
    format: 'text',
    content: 'I will align the product first and check key ingredients. Do you want the evaluation focused on acne, dark spots, or barrier repair?',
  };
}

function renderRecommendationMessage({ lang, variant }) {
  if (lang === 'CN') {
    if (variant === 'degraded') {
      return {
        format: 'text',
        content: '我可以先给品类级最小清单，但要输出可买清单还差 1 个关键信息。你现在的屏障更像稳定、偶尔刺痛，还是经常泛红刺痛？',
      };
    }
    return {
      format: 'markdown',
      content: '**结论：先稳屏障，再推进目标功效**\n- 最小清单：洁面 / 修护面霜 / 防晒 / 可选功效位\n- 选择依据：按你的敏感度优先低刺激路线\n- 下一步：我可以排成 AM/PM 并标注引入频次',
    };
  }

  if (variant === 'degraded') {
    return {
      format: 'text',
      content: 'I can give a category-level shortlist now, but to output buyable picks I still need one detail: is your barrier stable, occasional sting, or frequent red/sting?',
    };
  }

  return {
    format: 'markdown',
    content: '**Bottom line: stabilize barrier first, then target concerns**\n- Minimal set: cleanser / barrier cream / sunscreen / optional treatment\n- Why: based on your sensitivity, start low-irritation\n- Next: I can turn this into an AM/PM plan with onboarding frequency',
  };
}

function renderNoPhotoMessage({ lang, variant }) {
  if (lang === 'CN') {
    if (variant === 'degraded') {
      return {
        format: 'text',
        content: '我现在拿不到可用分析结果。我们可以先走安全的最小修护方案，或你补充一张清晰照片后我继续。',
      };
    }
    return {
      format: 'text',
      content: '说明一下：这次没有可用照片，我只能基于问卷和历史给低风险建议。你想先做修护屏障，还是先处理痘痘/淡印？',
    };
  }

  if (variant === 'degraded') {
    return {
      format: 'text',
      content: 'I cannot retrieve a usable analysis result right now. We can start with a safe minimal repair plan, or you can upload a clear photo and I will continue.',
    };
  }

  return {
    format: 'text',
    content: 'Quick note: without usable photos, I can only give low-risk guidance from your history. Do you want to start with barrier repair or acne/dark spots?',
  };
}

function renderFromTemplate(decision, context = {}) {
  const lang = normalizeLanguage(context.language || context.lang);
  const moduleName = String(decision && decision.module ? decision.module : '').trim();
  const variant = String(decision && decision.variant ? decision.variant : 'standard').trim();

  if (moduleName === 'diagnosis_clarification') {
    return renderDiagnosisMessage({ lang, variant, currentNormId: decision.current_norm_id });
  }
  if (moduleName === 'env_weather_qa') {
    return renderEnvMessage({ lang, variant });
  }
  if (moduleName === 'product_evaluation') {
    return renderProductMessage({ lang, variant });
  }
  if (moduleName === 'recommendations_output') {
    return renderRecommendationMessage({ lang, variant });
  }
  if (moduleName === 'no_photo_analysis_degrade') {
    return renderNoPhotoMessage({ lang, variant });
  }
  return null;
}

function shouldReplaceExistingMessage(existingText, decision) {
  const text = String(existingText || '').trim();
  if (!text) return true;
  if (isGenericAssistantMessage(text)) return true;
  const moduleName = String(decision && decision.module ? decision.module : '').trim();
  if (moduleName === 'diagnosis_clarification' && text.length > TEXT_MAX_CHARS) return true;
  if ((moduleName === 'env_weather_qa' || moduleName === 'recommendations_output') && text.length > MARKDOWN_MAX_CHARS) return true;
  return false;
}

function renderAssistantMessage(decision, context = {}) {
  const existingMessage = context.assistant_message || context.assistantMessage || null;
  const existingText = normalizeMessageContent(existingMessage);
  const existingFormat = normalizeMessageFormat(existingMessage, decision && decision.message_format ? decision.message_format : 'text');

  if (!decision || typeof decision !== 'object') {
    return {
      format: existingFormat,
      content: existingText,
      applied: false,
      reason: 'missing_decision',
    };
  }

  if (!shouldReplaceExistingMessage(existingText, decision)) {
    return {
      format: existingFormat,
      content: existingText,
      applied: false,
      reason: 'keep_existing',
    };
  }

  const rendered = renderFromTemplate(decision, context);
  if (!rendered || !String(rendered.content || '').trim()) {
    return {
      format: existingFormat,
      content: existingText,
      applied: false,
      reason: 'template_empty',
    };
  }

  const format = rendered.format === 'markdown' ? 'markdown' : 'text';
  const maxChars = format === 'markdown' ? MARKDOWN_MAX_CHARS : TEXT_MAX_CHARS;
  return {
    format,
    content: trimToLimit(rendered.content, maxChars),
    applied: true,
    reason: 'template_rendered',
  };
}

function normalizeCanonicalChip(chip, index) {
  const source = isPlainObject(chip) ? chip : {};
  const chipId = String(source.chip_id || source.id || `chip.template.${index + 1}`).trim();
  const label = String(source.label || source.text || '').trim();
  if (!chipId || !label) return null;

  const kindRaw = String(source.kind || source.type || '').trim().toLowerCase();
  const kind = kindRaw === 'action' ? 'action' : 'quick_reply';
  const data = isPlainObject(source.data) ? { ...source.data } : {};

  if (kind === 'quick_reply') {
    if (!data.norm_id && typeof source.norm_id === 'string') data.norm_id = source.norm_id;
    if (data.value === undefined && source.value !== undefined) data.value = source.value;
  }

  if (kind === 'action') {
    if (!data.requested_transition && typeof source.requested_transition === 'string') {
      data.requested_transition = source.requested_transition;
    }
    if (!data.action_id && typeof source.action_id === 'string') data.action_id = source.action_id;
  }

  const priority = String(source.priority || '').trim().toLowerCase();
  return {
    chip_id: chipId,
    label,
    kind,
    data,
    _priority: priority,
  };
}

function inferChipPriority(chip, currentNormId) {
  const priority = String(chip && chip._priority ? chip._priority : '').trim().toLowerCase();
  if (priority === 'advance_current') return 0;
  if (priority === 'narrow_scope') return 1;
  if (priority === 'next_action') return 2;
  if (priority === 'low') return 3;

  const data = isPlainObject(chip && chip.data) ? chip.data : {};
  const normId = String(data.norm_id || '').trim().toLowerCase();
  const current = String(currentNormId || '').trim().toLowerCase();

  if (chip && chip.kind === 'quick_reply' && normId && current && normId === current) return 0;
  if (chip && chip.kind === 'quick_reply' && normId) return 1;
  if (chip && chip.kind === 'action') return 2;
  return 3;
}

function normalizeExistingChip(chip, index) {
  const normalized = normalizeCanonicalChip(chip, index);
  if (!normalized) return null;
  delete normalized._priority;
  return normalized;
}

function adaptChips({ canonicalChips = [], existingChips = [], maxChips = DEFAULT_MAX_CHIPS, currentNormId = null } = {}) {
  const capRaw = Number(maxChips);
  const cap = Number.isFinite(capRaw) ? Math.max(1, Math.min(20, Math.trunc(capRaw))) : DEFAULT_MAX_CHIPS;

  const all = [];
  for (const [idx, chip] of (Array.isArray(canonicalChips) ? canonicalChips : []).entries()) {
    const normalized = normalizeCanonicalChip(chip, idx);
    if (!normalized) continue;
    all.push({ ...normalized, _from: 'canonical' });
  }
  for (const [idx, chip] of (Array.isArray(existingChips) ? existingChips : []).entries()) {
    const normalized = normalizeExistingChip(chip, idx);
    if (!normalized) continue;
    all.push({ ...normalized, _from: 'existing' });
  }

  const deduped = [];
  const seen = new Set();
  for (const chip of all) {
    const key = `${chip.chip_id}|${chip.kind}|${String(chip.label || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(chip);
  }

  deduped.sort((a, b) => {
    const pa = inferChipPriority(a, currentNormId);
    const pb = inferChipPriority(b, currentNormId);
    if (pa !== pb) return pa - pb;
    if (a._from !== b._from) return a._from === 'canonical' ? -1 : 1;
    return String(a.chip_id).localeCompare(String(b.chip_id));
  });

  const out = deduped.slice(0, cap).map((chip) => ({
    chip_id: chip.chip_id,
    label: chip.label,
    kind: chip.kind,
    data: isPlainObject(chip.data) ? chip.data : {},
  }));

  return {
    chips: out,
    truncated: deduped.length > cap,
    from_count: deduped.length,
    to_count: out.length,
  };
}

function detectDuplicatePrefix(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const line = raw.split(/\r?\n/)[0] || '';
  const normalized = line.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return false;
  if (/(下午好.{0,10}下午好|早上好.{0,10}早上好|晚上好.{0,10}晚上好)/.test(normalized)) return true;
  if (/(gotit\.?\s*gotit\.?|understood\.?\s*understood\.?)/i.test(line)) return true;
  return false;
}

function detectMissingAction({ content, chips }) {
  const text = String(content || '').trim();
  if (!text) return false;
  if (Array.isArray(chips) && chips.length > 0) return false;
  if (/[?？]$/.test(text) || /[?？]/.test(text)) return false;
  if (/(点击|选择|告诉我|回复|下一步|想要我|tap|choose|tell me|reply|next step|want me)/i.test(text)) return false;
  return true;
}

function validateTemplateOutput(envelope, { warnOnly = true } = {}) {
  const env = isPlainObject(envelope) ? envelope : {};
  const cards = Array.isArray(env.cards) ? env.cards : [];
  const chips = Array.isArray(env.suggested_chips) ? env.suggested_chips : [];
  const patch = isPlainObject(env.session_patch) ? env.session_patch : {};
  const nextState = String(patch.next_state || '').trim();
  const assistant = isPlainObject(env.assistant_message) ? env.assistant_message : null;
  const content = normalizeMessageContent(assistant);
  const violations = [];

  const types = cardTypeSet(cards);
  const hasRecommendations = types.has('recommendations');
  if (hasRecommendations && !UI_RECO_STATES.has(nextState)) {
    violations.push({
      rule: 'recommendations_state_mismatch',
      severity: 'warn',
      message: 'recommendations card appears outside RECO_* UI states',
    });
  }

  if (detectDuplicatePrefix(content)) {
    violations.push({
      rule: 'duplicate_prefix',
      severity: 'warn',
      message: 'assistant_message contains repeated greeting/prefix',
    });
  }

  if (types.has('env_stress') && /(\bess\b|\btier\b|\bradar\b|axis\b)/i.test(content)) {
    violations.push({
      rule: 'card_duplicate_env',
      severity: 'warn',
      message: 'assistant_message duplicates env_stress structured details',
    });
  }

  if (hasRecommendations && /recommendations?_count\s*[:=]|items?\[\d+\]|sku\./i.test(content)) {
    violations.push({
      rule: 'card_duplicate_recommendations',
      severity: 'warn',
      message: 'assistant_message duplicates recommendations payload fields',
    });
  }

  if (detectMissingAction({ content, chips })) {
    violations.push({
      rule: 'missing_action',
      severity: 'warn',
      message: 'assistant_message has no direct next action and no chips',
    });
  }

  for (const card of cards) {
    const missing = Array.isArray(card && card.field_missing) ? card.field_missing : [];
    for (const item of missing) {
      const reason = String(item && item.reason ? item.reason : '').trim();
      if (!reason) continue;
      if (!FIELD_MISSING_REASON_ENUM.includes(reason)) {
        violations.push({
          rule: 'field_missing_reason_unknown',
          severity: 'warn',
          message: `field_missing.reason is not in enum: ${reason}`,
        });
      }
    }
  }

  const actionable = !detectMissingAction({ content, chips });

  return {
    ok: violations.length === 0,
    warn_only: Boolean(warnOnly),
    actionable,
    violations,
  };
}

module.exports = {
  FIELD_MISSING_REASON_ENUM,
  selectTemplate,
  renderAssistantMessage,
  adaptChips,
  validateTemplateOutput,
};
