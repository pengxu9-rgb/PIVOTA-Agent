const RECO_UI_STATES = new Set(['RECO_GATE', 'RECO_CONSTRAINTS', 'RECO_RESULTS']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value) {
  if (value == null) return '';
  return String(value);
}

function normalizeLang(ctx) {
  const acceptLanguage = safeString(ctx && (ctx.accept_language || ctx.locale || '')).trim().toLowerCase();
  if (acceptLanguage.startsWith('en')) return 'en';

  const lang = safeString(ctx && ctx.lang).trim().toLowerCase();
  if (lang.startsWith('en')) return 'en';
  if (lang === 'cn' || lang.startsWith('zh')) return 'zh';
  return 'zh';
}

function getCards(envelope) {
  return Array.isArray(envelope && envelope.cards) ? envelope.cards : [];
}

function hasCardType(cards, type) {
  const target = safeString(type).trim().toLowerCase();
  if (!target) return false;
  return cards.some((card) => safeString(card && card.type).trim().toLowerCase() === target);
}

function findCard(cards, type) {
  const target = safeString(type).trim().toLowerCase();
  if (!target) return null;
  return cards.find((card) => safeString(card && card.type).trim().toLowerCase() === target) || null;
}

function getSessionPatch(envelope) {
  if (isPlainObject(envelope && envelope.session_patch)) return envelope.session_patch;
  return {};
}

function getPendingClarification(envelope) {
  const patch = getSessionPatch(envelope);
  const state = isPlainObject(patch.state) ? patch.state : {};
  const pending = isPlainObject(state.pending_clarification) ? state.pending_clarification : null;
  if (!pending) return { pending: null, currentNormId: '', unknownCount: 0 };

  const currentNormId = safeString(
    pending.current && (pending.current.norm_id || pending.current.normId || pending.current.id),
  ).trim();
  const history = Array.isArray(pending.history) ? pending.history : [];
  const unknownCount = history.reduce((acc, item) => {
    const token = safeString(item && (item.value || item.option || item.answer || item.reply)).trim().toLowerCase();
    if (!token) return acc;
    if (token === 'unknown' || token === 'not sure' || token === 'unsure' || token === '不确定') return acc + 1;
    return acc;
  }, 0);
  return { pending, currentNormId, unknownCount };
}

function getFirstMissingFieldFromGate(cards) {
  const gate = findCard(cards, 'diagnosis_gate');
  if (!gate || !isPlainObject(gate.payload)) return '';
  const payload = gate.payload;
  const fromCurrent = safeString(
    payload.current && (payload.current.norm_id || payload.current.normId || payload.current.id || payload.current),
  ).trim();
  if (fromCurrent) return fromCurrent;
  const missing = Array.isArray(payload.missing_fields) ? payload.missing_fields : [];
  return safeString(missing[0]).trim();
}

function profileMissingCoreFields(envelope) {
  const patch = getSessionPatch(envelope);
  const profile = isPlainObject(patch.profile) ? patch.profile : {};
  const missing = [];
  if (!safeString(profile.skinType).trim()) missing.push('skinType');
  if (!safeString(profile.sensitivity).trim()) missing.push('sensitivity');
  if (!safeString(profile.barrierStatus).trim()) missing.push('barrierStatus');
  if (!(Array.isArray(profile.goals) ? profile.goals.length > 0 : safeString(profile.goals).trim())) missing.push('goals');
  return missing;
}

function getAnalysisNoPhotoSignal(cards) {
  const analysis = findCard(cards, 'analysis_summary');
  if (!analysis || !isPlainObject(analysis.payload)) return { noPhoto: false, degraded: false };
  const payload = analysis.payload;
  const noPhoto = payload.used_photos === false || payload.photos_provided === false;
  const criticalMissing = payload.used_photos == null || payload.low_confidence == null;
  const degraded = criticalMissing;
  return { noPhoto, degraded };
}

function isWeatherIntent({ envelope, ctx }) {
  const events = Array.isArray(envelope && envelope.events) ? envelope.events : [];
  const weatherEvent = events.some((evt) => {
    const kind = safeString(evt && evt.data && evt.data.kind).trim().toLowerCase();
    return kind === 'weather_advice';
  });
  if (weatherEvent) return true;

  const assistantText =
    safeString(
      envelope &&
      envelope.assistant_message &&
      (typeof envelope.assistant_message === 'string'
        ? envelope.assistant_message
        : envelope.assistant_message.content),
    )
      .trim()
      .toLowerCase();
  if (
    /\bweather\b|\bsnow\b|\brain\b|\buv\b|\bcold\b|\bdry\b|\bhumid\b/.test(assistantText) ||
    /(天气|雪天|雨天|紫外线|寒冷|干燥|潮湿)/.test(assistantText)
  ) {
    return true;
  }

  const routeHint = safeString(ctx && ctx.intent).trim().toLowerCase();
  return routeHint === 'weather' || routeHint === 'weather_env';
}

function selectTemplate({ envelope, ctx } = {}) {
  const cards = getCards(envelope);
  const sessionPatch = getSessionPatch(envelope);
  const nextState = safeString(sessionPatch.next_state).trim();
  const { pending, currentNormId, unknownCount } = getPendingClarification(envelope);

  if (pending || hasCardType(cards, 'diagnosis_gate')) {
    return unknownCount >= 2 ? 'diagnosis_clarification.degraded' : 'diagnosis_clarification.standard';
  }

  if (hasCardType(cards, 'recommendations')) {
    return 'recommendations_output.standard';
  }

  const analysisSignal = getAnalysisNoPhotoSignal(cards);
  if (analysisSignal.noPhoto) {
    return analysisSignal.degraded ? 'no_photo_analysis_degrade.degraded' : 'no_photo_analysis_degrade.standard';
  }

  if (hasCardType(cards, 'env_stress') || isWeatherIntent({ envelope, ctx })) {
    return hasCardType(cards, 'env_stress') ? 'env_weather_qa.standard' : 'env_weather_qa.degraded';
  }

  if (
    nextState === 'PRODUCT_LINK_EVAL' ||
    hasCardType(cards, 'product_parse') ||
    hasCardType(cards, 'product_analysis')
  ) {
    const parseCard = findCard(cards, 'product_parse');
    const payload = parseCard && isPlainObject(parseCard.payload) ? parseCard.payload : {};
    const hasProductRef = safeString(payload.product_ref || payload.productRef).trim() || isPlainObject(payload.product);
    const hasAnchor = safeString(payload.anchor_product_id || payload.anchorProductId).trim();
    if (parseCard && !hasProductRef && !hasAnchor) return 'product_evaluation.degraded';
    return 'product_evaluation.standard';
  }

  if (currentNormId) {
    return 'diagnosis_clarification.standard';
  }

  return 'default.keep';
}

function buildClarificationMeta(normId, lang) {
  const id = safeString(normId).trim();
  const isZh = lang === 'zh';
  if (id === 'skinType') {
    return {
      prompt: isZh
        ? '为把清洁和保湿强度配准，我先确认 1 个问题：你更偏油、偏干，还是混合？'
        : 'To tune cleanser and moisturizer strength, one quick check: is your skin oily, dry, or combination?',
      promptDegraded: isZh
        ? '我们先按低刺激基线继续；为避免误配，我再确认 1 个问题：你更偏油、偏干，还是混合？'
        : 'We can continue with a low-irritation baseline; one key check: is your skin oily, dry, or combination?',
      options: [
        ['oily', isZh ? '偏油' : 'Oily'],
        ['dry', isZh ? '偏干' : 'Dry'],
        ['combination', isZh ? '混合' : 'Combination'],
        ['unknown', isZh ? '不确定' : 'Not sure'],
      ],
      patch: (value) => ({ skinType: value }),
    };
  }

  if (id === 'sensitivity') {
    return {
      prompt: isZh
        ? '为控制活性强度和引入频次，我先确认 1 个问题：你的皮肤更接近低敏、中敏，还是高敏？'
        : 'To set active strength and intro frequency, one check: is your skin low, medium, or high sensitivity?',
      promptDegraded: isZh
        ? '先按低刺激方案继续；为避免刺激叠加，我再确认 1 个问题：你的皮肤更接近低敏、中敏，还是高敏？'
        : 'We can keep a low-irritation baseline; one check to avoid over-irritation: low, medium, or high sensitivity?',
      options: [
        ['low', isZh ? '低敏' : 'Low'],
        ['medium', isZh ? '中敏' : 'Medium'],
        ['high', isZh ? '高敏' : 'High'],
        ['unknown', isZh ? '不确定' : 'Not sure'],
      ],
      patch: (value) => ({ sensitivity: value }),
    };
  }

  if (id === 'barrierStatus') {
    return {
      prompt: isZh
        ? '为判断修护优先级，我先确认 1 个问题：你的屏障状态更接近稳定、偏弱，还是受损？'
        : 'To set repair priority, one check: is your barrier stable, weakened, or damaged?',
      promptDegraded: isZh
        ? '我们先按修护优先继续；为避免误配，我再确认 1 个问题：你的屏障状态更接近稳定、偏弱，还是受损？'
        : 'We can continue repair-first; one key check: is your barrier stable, weakened, or damaged?',
      options: [
        ['stable', isZh ? '稳定' : 'Stable'],
        ['weakened', isZh ? '偏弱' : 'Weakened'],
        ['damaged', isZh ? '受损' : 'Damaged'],
        ['unknown', isZh ? '不确定' : 'Not sure'],
      ],
      patch: (value) => ({ barrierStatus: value }),
    };
  }

  if (id === 'goals') {
    return {
      prompt: isZh
        ? '为缩小推荐范围，我先确认 1 个问题：你想先解决痘痘、暗沉，还是保湿修护？'
        : 'To narrow the plan, one quick check: what comes first for you, acne, dark spots, or hydration/repair?',
      promptDegraded: isZh
        ? '可以先走低刺激基线；为更贴合目标，我再确认 1 个问题：你想先解决痘痘、暗沉，还是保湿修护？'
        : 'We can start from a low-irritation baseline; one key check: prioritize acne, dark spots, or hydration/repair?',
      options: [
        ['acne', isZh ? '先祛痘' : 'Acne first'],
        ['dark_spots', isZh ? '先淡印' : 'Dark spots first'],
        ['hydration', isZh ? '先保湿' : 'Hydration first'],
        ['barrier_repair', isZh ? '先修护屏障' : 'Barrier repair first'],
        ['unknown', isZh ? '不确定' : 'Not sure'],
      ],
      patch: (value) => ({ goals: [value] }),
    };
  }

  return buildClarificationMeta('skinType', lang);
}

function makeClarificationChips(normId, lang) {
  const meta = buildClarificationMeta(normId, lang);
  return meta.options.map(([value, label], idx) => {
    const patch = meta.patch(value);
    return {
      chip_id: `tpl.clarify.${normId}.${value}.${idx + 1}`,
      label,
      kind: 'quick_reply',
      data: {
        norm_id: normId,
        value,
        profile_patch: patch,
      },
    };
  });
}

function makeRecoActionChips(lang) {
  const isZh = lang === 'zh';
  return [
    {
      chip_id: 'tpl.action.routine_generate',
      label: isZh ? '生成 AM/PM' : 'Generate AM/PM',
      kind: 'action',
      data: {
        requested_transition: 'action',
        action_id: 'routine_generate',
      },
    },
    {
      chip_id: 'tpl.action.checkin',
      label: isZh ? '一周后复盘' : 'Check in after 1 week',
      kind: 'action',
      data: {
        requested_transition: 'action',
        action_id: 'checkin_prompt',
      },
    },
  ];
}

function makeEnvActionChips(lang) {
  const isZh = lang === 'zh';
  return [
    {
      chip_id: 'tpl.action.env.am_pm',
      label: isZh ? '生成 AM/PM' : 'Generate AM/PM',
      kind: 'action',
      data: { requested_transition: 'action', action_id: 'routine_generate' },
    },
  ];
}

function makeProductGoalChips(lang) {
  const isZh = lang === 'zh';
  return [
    {
      chip_id: 'tpl.product.goal.acne',
      label: isZh ? '按祛痘评估' : 'Evaluate for acne',
      kind: 'quick_reply',
      data: { norm_id: 'evalGoal', value: 'acne' },
    },
    {
      chip_id: 'tpl.product.goal.spots',
      label: isZh ? '按淡印评估' : 'Evaluate for dark spots',
      kind: 'quick_reply',
      data: { norm_id: 'evalGoal', value: 'dark_spots' },
    },
    {
      chip_id: 'tpl.product.goal.barrier',
      label: isZh ? '按修护评估' : 'Evaluate for barrier repair',
      kind: 'quick_reply',
      data: { norm_id: 'evalGoal', value: 'barrier_repair' },
    },
  ];
}

function makeNoPhotoGoalChips(lang) {
  const isZh = lang === 'zh';
  return [
    {
      chip_id: 'tpl.goal.barrier',
      label: isZh ? '先修护屏障' : 'Barrier repair first',
      kind: 'quick_reply',
      data: { norm_id: 'goals', value: 'barrier_repair', profile_patch: { goals: ['barrier_repair'] } },
    },
    {
      chip_id: 'tpl.goal.acne',
      label: isZh ? '先祛痘' : 'Acne first',
      kind: 'quick_reply',
      data: { norm_id: 'goals', value: 'acne', profile_patch: { goals: ['acne'] } },
    },
    {
      chip_id: 'tpl.action.photo',
      label: isZh ? '补充照片' : 'Upload photo',
      kind: 'action',
      data: { requested_transition: 'action', action_id: 'photo_confirm' },
    },
  ];
}

function renderTemplate({ template_id, params } = {}) {
  const templateId = safeString(template_id).trim();
  const lang = params && params.lang === 'en' ? 'en' : 'zh';
  const isZh = lang === 'zh';
  const pendingNormId = safeString(params && params.pendingCurrentNormId).trim();
  const fallbackNormId = pendingNormId || safeString(params && params.gateCurrentNormId).trim() || 'skinType';
  const missingCore = Array.isArray(params && params.missingCore) ? params.missingCore : [];
  const firstMissingCore = safeString(missingCore[0]).trim() || 'skinType';

  if (templateId === 'diagnosis_clarification.standard' || templateId === 'diagnosis_clarification.degraded') {
    const meta = buildClarificationMeta(fallbackNormId, lang);
    return {
      assistant_message: {
        role: 'assistant',
        format: 'text',
        content: templateId.endsWith('.degraded') ? meta.promptDegraded : meta.prompt,
      },
      suggested_chips_patch: makeClarificationChips(fallbackNormId, lang),
      session_patch_patch: {},
    };
  }

  if (templateId === 'env_weather_qa.standard') {
    const content = isZh
      ? '**结论：先减刺激，再加强保湿封闭。**\n- 温和清洁，减少去脂\n- 先补水，再面霜封层\n- 外出做好防晒与物理遮挡\n\n下一步：要我按你的肤质生成 AM/PM 吗？'
      : '**Bottom line: reduce irritation, then increase hydration + seal.**\n- Cleanse gently; avoid over-stripping\n- Hydrate first, then seal with cream\n- Use sunscreen and physical cover outdoors\n\nNext: want an AM/PM routine tailored to your skin type?';
    return {
      assistant_message: { role: 'assistant', format: 'markdown', content },
      suggested_chips_patch: makeEnvActionChips(lang),
      session_patch_patch: {},
    };
  }

  if (templateId === 'env_weather_qa.degraded') {
    const content = isZh
      ? '当前环境卡数据不可用。先按冷干场景做低刺激修护：温和清洁、提高保湿、暂停高频去角质。你更偏油还是偏干？'
      : 'Environment-card data is unavailable right now. Use a low-irritation cold/dry baseline: gentle cleanse, richer moisturizer, and pause frequent exfoliation. Are you more oily or dry?';
    return {
      assistant_message: { role: 'assistant', format: 'text', content },
      suggested_chips_patch: makeClarificationChips('skinType', lang),
      session_patch_patch: {},
    };
  }

  if (templateId === 'product_evaluation.standard') {
    const productParseCard = findCard(getCards(params && params.envelope), 'product_parse');
    const payload = productParseCard && isPlainObject(productParseCard.payload) ? productParseCard.payload : {};
    const productName = safeString(
      payload.product_name ||
      payload.name ||
      payload.display_name ||
      payload.product_ref ||
      payload.anchor_product_id,
    ).trim();
    const content = isZh
      ? `我已先对齐${productName ? `“${productName}”` : '到该产品'}。为给你更准确的评估，我只确认一个目标：你更关注祛痘、淡印，还是保湿修护？`
      : `I aligned ${productName ? `"${productName}"` : 'this product'} first. To evaluate it precisely, one quick goal check: acne, dark spots, or barrier repair?`;
    return {
      assistant_message: { role: 'assistant', format: 'text', content },
      suggested_chips_patch: makeProductGoalChips(lang),
      session_patch_patch: {},
    };
  }

  if (templateId === 'product_evaluation.degraded') {
    const content = isZh
      ? '我还不能确定具体是哪一款。请补充系列/规格或再发链接，我再继续做成分与适配评估。'
      : 'I can’t identify the exact variant yet. Share the line/size or send the link again, and I’ll continue ingredient-fit evaluation.';
    return {
      assistant_message: { role: 'assistant', format: 'text', content },
      suggested_chips_patch: [],
      session_patch_patch: {},
    };
  }

  if (templateId === 'recommendations_output.standard') {
    const content = isZh
      ? '**结论：先稳屏障，再上功效。**\n- 最小清单：洁面 / 修护面霜 / 防晒 /（可选）温和功效\n- 依据：按你的肤质与敏感度，先低刺激起步\n- 下一步：我可以生成 AM/PM，并标注引入频次'
      : '**Bottom line: stabilize barrier first, then add actives.**\n- Minimal set: cleanser / barrier cream / sunscreen / (optional) gentle active\n- Why: based on your profile, start low-irritation first\n- Next: I can generate an AM/PM plan with introduction frequency';
    return {
      assistant_message: { role: 'assistant', format: 'markdown', content },
      suggested_chips_patch: makeRecoActionChips(lang),
      session_patch_patch: { next_state: 'RECO_RESULTS' },
    };
  }

  if (templateId === 'recommendations_output.degraded') {
    const meta = buildClarificationMeta(firstMissingCore, lang);
    return {
      assistant_message: {
        role: 'assistant',
        format: 'text',
        content: isZh
          ? `先不直接给具体清单，避免误配。还缺 1 个关键信息：${meta.prompt}`
          : `I won’t output a specific list yet to avoid mismatch. One key detail is still missing: ${meta.prompt}`,
      },
      suggested_chips_patch: makeClarificationChips(firstMissingCore, lang),
      session_patch_patch: { next_state: 'RECO_GATE' },
    };
  }

  if (templateId === 'no_photo_analysis_degrade.standard') {
    const content = isZh
      ? '说明一下：目前没有可用照片，我不会给出基于照片的结论。先按两步低风险基线：1) 温和清洁+修护保湿；2) 暂停高刺激活性。你想先解决屏障修护还是痘印？'
      : 'Quick note: no usable photos are available, so I will not make photo-based conclusions. Start with a 2-step low-risk baseline: 1) gentle cleanse + repair moisturizer; 2) pause high-irritation actives. Do you want to prioritize barrier repair or dark spots first?';
    return {
      assistant_message: { role: 'assistant', format: 'text', content },
      suggested_chips_patch: makeNoPhotoGoalChips(lang),
      session_patch_patch: {},
    };
  }

  if (templateId === 'no_photo_analysis_degrade.degraded') {
    const content = isZh
      ? '抱歉，我现在拿不到完整分析字段。先给你最小修护基线：温和清洁+修护保湿；你可以补充清晰照片，或先回答一个关键问题（偏油/偏干）。'
      : 'Sorry, I can’t retrieve complete analysis fields right now. Use a minimal repair baseline first: gentle cleanse + repair moisturizer. You can upload a clear photo, or answer one key question first (oily vs dry).';
    return {
      assistant_message: { role: 'assistant', format: 'text', content },
      suggested_chips_patch: makeClarificationChips('skinType', lang),
      session_patch_patch: {},
    };
  }

  return {
    assistant_message: null,
    suggested_chips_patch: [],
    session_patch_patch: {},
  };
}

function mergeObjects(base, patch) {
  const left = isPlainObject(base) ? base : {};
  const right = isPlainObject(patch) ? patch : {};
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (isPlainObject(value) && isPlainObject(left[key])) out[key] = mergeObjects(left[key], value);
    else out[key] = value;
  }
  return out;
}

function normalizeAssistantMessage(message) {
  if (typeof message === 'string') {
    return { role: 'assistant', format: 'text', content: message };
  }
  if (!isPlainObject(message)) return null;
  const content = safeString(message.content).trim();
  if (!content) return null;
  const format = safeString(message.format).trim().toLowerCase() === 'markdown' ? 'markdown' : 'text';
  return { role: 'assistant', format, content };
}

function countQuestionMarks(text) {
  return (safeString(text).match(/[?？]/g) || []).length;
}

function countBullets(text) {
  return safeString(text)
    .split(/\r?\n/)
    .filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line.trim())).length;
}

function stripMarkdownToText(text) {
  return safeString(text)
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function dedupeLeadingPrefix(text) {
  let out = safeString(text).trim();
  out = out.replace(/^(收到|明白|可以|好，我们继续)[，,。\s]*\1[，,。\s]*/u, '$1，');
  out = out.replace(/^(got it\.?|understood\.?|sure\.?)\s+\1\s+/i, '$1 ');
  return out;
}

function hasUnsafeClaim(text) {
  const raw = safeString(text).toLowerCase();
  return (
    /(definitely cure|guaranteed cure|cure you for sure)/.test(raw) ||
    /(一定治好|包治|百分之百治愈|确诊为|诊断为)/.test(raw)
  );
}

function looksDuplicativeForEnv(text) {
  return /(\bess\b|\btier\b|\bradar\b|雷达|分层数值)/i.test(safeString(text));
}

function looksDuplicativeForReco(text) {
  const raw = safeString(text);
  if (/recommendations?_count|items?\[\d+\]|sku\.|merchant_id|product_id/i.test(raw)) return true;
  const bulletCount = countBullets(raw);
  return bulletCount >= 6;
}

function enforceMessageLimits(message, { allowMarkdown }) {
  const msg = normalizeAssistantMessage(message);
  if (!msg) return null;
  let format = msg.format;
  let content = dedupeLeadingPrefix(msg.content);

  if (format === 'markdown' && !allowMarkdown) {
    format = 'text';
    content = stripMarkdownToText(content);
  }

  if (format === 'markdown') {
    const lines = content.split(/\r?\n/);
    let bulletSeen = 0;
    const kept = [];
    for (const line of lines) {
      const isBullet = /^\s*([-*]|\d+\.)\s+/.test(line.trim());
      if (isBullet) {
        bulletSeen += 1;
        if (bulletSeen > 6) continue;
      }
      kept.push(line);
    }
    content = kept.join('\n').trim();
    if (content.length > 520) content = `${content.slice(0, 519).trim()}…`;
  } else {
    if (content.length > 280) content = `${content.slice(0, 279).trim()}…`;
  }

  return { role: 'assistant', format, content };
}

function normalizeChip(chip, idx) {
  if (!isPlainObject(chip)) return null;
  const chipId = safeString(chip.chip_id || chip.id).trim() || `tpl.chip.${idx + 1}`;
  const label = safeString(chip.label || chip.title).trim();
  if (!label) return null;
  const kindRaw = safeString(chip.kind).trim().toLowerCase();
  const kind = kindRaw === 'action' ? 'action' : 'quick_reply';
  const rawData = isPlainObject(chip.data) ? chip.data : {};
  const data = { ...rawData };
  const normId =
    data.norm_id ||
    data.normId ||
    data.clarification_norm_id ||
    data.clarificationNormId ||
    data.clarification_id ||
    data.clarificationId;
  if (normId && !data.norm_id) data.norm_id = normId;
  const value = data.value ?? data.reply_text ?? data.replyText;
  if (value != null && data.value == null) data.value = value;
  return { chip_id: chipId, label, kind, data };
}

function mergeChips(preferred, existing) {
  const out = [];
  const seen = new Set();
  const push = (raw, idx) => {
    const chip = normalizeChip(raw, idx);
    if (!chip) return;
    const key = `${chip.chip_id}|${chip.kind}|${chip.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(chip);
  };
  (Array.isArray(preferred) ? preferred : []).forEach((chip, idx) => push(chip, idx));
  (Array.isArray(existing) ? existing : []).forEach((chip, idx) => push(chip, idx + out.length));
  return out;
}

function normalizeNormId(value) {
  return safeString(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function chipMatchesNormId(chip, normId) {
  const target = normalizeNormId(normId);
  if (!target) return false;
  const dataNorm = normalizeNormId(
    chip &&
      chip.data &&
      (chip.data.norm_id ||
        chip.data.normId ||
        chip.data.clarification_norm_id ||
        chip.data.clarificationNormId ||
        chip.data.clarification_id ||
        chip.data.clarificationId),
  );
  if (dataNorm && dataNorm === target) return true;

  const chipId = normalizeNormId(chip && chip.chip_id);
  if (chipId.includes(target)) return true;

  const aliases = {
    skintype: ['skintype', 'skin_type'],
    sensitivity: ['sensitivity'],
    barrierstatus: ['barrierstatus', 'barrier_status'],
    goals: ['goals', 'goal'],
  };
  const aliasList = aliases[target] || [target];
  return aliasList.some((alias) => chipId.includes(normalizeNormId(alias)));
}

function ensurePendingChipRules(chips, normId, lang) {
  const currentNorm = safeString(normId).trim() || 'skinType';
  const base = mergeChips(chips, []);
  const quickReply = base.filter((chip) => chip.kind === 'quick_reply');
  const hasTargetNorm = quickReply.some((chip) => chipMatchesNormId(chip, currentNorm));

  let selected = quickReply;
  if (selected.length === 0) selected = makeClarificationChips(currentNorm, lang);

  const hasUnknown = selected.some((chip) => {
    const value = safeString(chip.data && chip.data.value).trim().toLowerCase();
    const label = safeString(chip.label).trim().toLowerCase();
    return value === 'unknown' || label === '不确定' || label === 'not sure';
  });
  if (!hasUnknown) {
    const unknownChip = makeClarificationChips(currentNorm, lang).find(
      (chip) => safeString(chip.data && chip.data.value).trim().toLowerCase() === 'unknown',
    );
    if (unknownChip) selected.push(unknownChip);
  }

  if (!hasTargetNorm) {
    selected = mergeChips(selected, makeClarificationChips(currentNorm, lang));
  }

  if (selected.length > 8) selected = selected.slice(0, 8);
  return selected;
}

function prioritizeAndClampChips(chips, { pendingNormId, max = 10 } = {}) {
  const list = mergeChips(chips, []);
  const withPriority = list.map((chip, idx) => {
    const norm = safeString(chip.data && chip.data.norm_id).trim();
    const value = safeString(chip.data && chip.data.value).trim().toLowerCase();
    let priority = 10;
    if (pendingNormId && chip.kind === 'quick_reply' && norm === pendingNormId) priority = 100;
    if (pendingNormId && (value === 'unknown' || /不确定|not sure/i.test(chip.label))) priority = 99;
    if (chip.kind === 'action') priority = Math.max(priority, 60);
    if (/am\/pm|check-?in|复盘/i.test(chip.label)) priority = Math.max(priority, 70);
    return { chip, idx, priority };
  });
  withPriority.sort((a, b) => b.priority - a.priority || a.idx - b.idx);
  return withPriority.slice(0, Math.max(1, max)).map((entry) => entry.chip);
}

function applyReplyTemplates({ envelope, ctx } = {}) {
  if (!isPlainObject(envelope)) return envelope;

  const env = envelope;
  if (!Array.isArray(env.cards)) env.cards = [];
  if (!Array.isArray(env.suggested_chips)) env.suggested_chips = [];
  if (!isPlainObject(env.session_patch)) env.session_patch = {};

  const cards = getCards(env);
  const { pending, currentNormId } = getPendingClarification(env);
  const gateCurrentNormId = getFirstMissingFieldFromGate(cards);
  const templateId = selectTemplate({ envelope: env, ctx });
  const lang = normalizeLang(ctx);
  const missingCore = profileMissingCoreFields(env);

  if (hasCardType(cards, 'recommendations') && !RECO_UI_STATES.has(safeString(env.session_patch.next_state).trim())) {
    env.session_patch.next_state = 'RECO_RESULTS';
  }

  const rendered = renderTemplate({
    template_id: templateId,
    params: {
      envelope: env,
      ctx,
      lang,
      pending,
      pendingCurrentNormId: currentNormId,
      gateCurrentNormId,
      missingCore,
    },
  });

  if (isPlainObject(rendered.session_patch_patch)) {
    env.session_patch = mergeObjects(env.session_patch, rendered.session_patch_patch);
  }

  const currentMessage = normalizeAssistantMessage(env.assistant_message);
  const pendingNeedsSingleQuestion = Boolean(currentNormId);
  const existingText = safeString(currentMessage && currentMessage.content);
  const existingFormat = safeString(currentMessage && currentMessage.format).trim().toLowerCase();
  const allowMarkdown = templateId === 'env_weather_qa.standard' || templateId === 'recommendations_output.standard';

  const violations = [];
  if (!currentMessage) violations.push('missing_message');
  if (pendingNeedsSingleQuestion && countQuestionMarks(existingText) !== 1) violations.push('pending_multi_question');
  if (hasUnsafeClaim(existingText)) violations.push('unsafe_claim');

  let replacedByTemplate = false;
  if (violations.length > 0 && normalizeAssistantMessage(rendered.assistant_message)) {
    env.assistant_message = rendered.assistant_message;
    replacedByTemplate = true;
  } else if (!currentMessage && normalizeAssistantMessage(rendered.assistant_message)) {
    env.assistant_message = rendered.assistant_message;
    replacedByTemplate = true;
  }

  let finalizedMessage = null;
  if (replacedByTemplate) {
    finalizedMessage = enforceMessageLimits(env.assistant_message, { allowMarkdown });
    if (finalizedMessage && hasUnsafeClaim(finalizedMessage.content)) {
      finalizedMessage = {
        role: 'assistant',
        format: 'text',
        content:
          lang === 'zh'
            ? '我只能提供非医疗护肤建议：先采用低刺激方案并观察反应；若症状持续或加重，请咨询专业医生。'
            : 'I can only provide non-medical skincare guidance: use a low-irritation baseline and monitor response; if symptoms persist or worsen, consult a clinician.',
      };
    }
    if (
      pendingNeedsSingleQuestion &&
      finalizedMessage &&
      countQuestionMarks(finalizedMessage.content) !== 1 &&
      normalizeAssistantMessage(rendered.assistant_message)
    ) {
      finalizedMessage = enforceMessageLimits(rendered.assistant_message, { allowMarkdown: false });
    }
  } else {
    finalizedMessage = normalizeAssistantMessage(env.assistant_message);
  }
  if (finalizedMessage) env.assistant_message = finalizedMessage;

  const renderedChips = Array.isArray(rendered.suggested_chips_patch) ? rendered.suggested_chips_patch : [];
  const existingChips = Array.isArray(env.suggested_chips) ? env.suggested_chips : [];
  const hasExistingQuickReply = existingChips.some((chip, idx) => {
    const normalized = normalizeChip(chip, idx);
    return Boolean(normalized && normalized.kind === 'quick_reply');
  });
  const seedChips =
    pendingNeedsSingleQuestion && hasExistingQuickReply
      ? mergeChips(existingChips, [])
      : mergeChips(renderedChips, existingChips);
  let chips = seedChips;

  if (pendingNeedsSingleQuestion) {
    chips = ensurePendingChipRules(chips, currentNormId || gateCurrentNormId || 'skinType', lang);
  } else if (templateId === 'recommendations_output.standard' || hasCardType(env.cards, 'recommendations')) {
    chips = mergeChips(chips, makeRecoActionChips(lang));
  }

  chips = prioritizeAndClampChips(chips, { pendingNormId: pendingNeedsSingleQuestion ? (currentNormId || gateCurrentNormId || 'skinType') : null, max: 10 });
  env.suggested_chips = chips;

  return env;
}

module.exports = {
  selectTemplate,
  renderTemplate,
  applyReplyTemplates,
};
