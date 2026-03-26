function createPhotoFallbackRuntime() {
  function normalizePhotoFailureCodeForFallback(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return '';
    if (
      normalized === 'DOWNLOAD_URL_GENERATE_FAILED' ||
      normalized === 'DOWNLOAD_URL_FETCH_4XX' ||
      normalized === 'DOWNLOAD_URL_FETCH_5XX' ||
      normalized === 'DOWNLOAD_URL_TIMEOUT' ||
      normalized === 'DOWNLOAD_URL_EXPIRED' ||
      normalized === 'DOWNLOAD_URL_DNS' ||
      normalized === 'MISSING_PRIMARY_INPUT'
    ) {
      return normalized;
    }
    return '';
  }

  function buildPhotoFallbackActionCard({
    language,
    qualityFail,
    failureCode,
    photosProvided,
  } = {}) {
    const lang = language === 'CN' ? 'CN' : 'EN';
    const normalizedFailure = normalizePhotoFailureCodeForFallback(failureCode);
    const reasonByCodeEn = {
      DOWNLOAD_URL_GENERATE_FAILED: "We couldn't generate a secure photo download link.",
      DOWNLOAD_URL_FETCH_4XX: 'Photo access was rejected while fetching bytes (4xx).',
      DOWNLOAD_URL_FETCH_5XX: 'Photo storage returned a server error while fetching bytes (5xx).',
      DOWNLOAD_URL_TIMEOUT: 'Photo download timed out before bytes were received.',
      DOWNLOAD_URL_EXPIRED: 'The signed photo link expired before analysis could start.',
      DOWNLOAD_URL_DNS: 'Photo storage host lookup failed (DNS/network resolution).',
      MISSING_PRIMARY_INPUT:
        'Routine/recent logs are missing, so this run starts from a conservative photo-first baseline before deeper personalization.',
    };
    const reasonByCodeZh = {
      DOWNLOAD_URL_GENERATE_FAILED: '系统未能生成可用的照片下载链接。',
      DOWNLOAD_URL_FETCH_4XX: '下载照片时访问被拒绝（4xx）。',
      DOWNLOAD_URL_FETCH_5XX: '下载照片时存储服务返回服务器错误（5xx）。',
      DOWNLOAD_URL_TIMEOUT: '下载照片超时，未能及时拿到图像字节。',
      DOWNLOAD_URL_EXPIRED: '签名照片链接已过期，分析前无法继续读取。',
      DOWNLOAD_URL_DNS: '照片存储域名解析失败（DNS/网络异常）。',
      MISSING_PRIMARY_INPUT: '缺少 routine/recent logs，本次先走“照片优先 + 保守基线”，再逐步个性化。',
    };

    let primaryReason = '';
    if (qualityFail) {
      primaryReason =
        lang === 'CN'
          ? '照片质量未通过（光线/清晰度/覆盖不足），本次无法做可靠的图像分析。'
          : 'Photo quality failed (lighting/focus/coverage), so image-based analysis is unavailable for this run.';
    } else if (normalizedFailure) {
      primaryReason = lang === 'CN' ? reasonByCodeZh[normalizedFailure] || '' : reasonByCodeEn[normalizedFailure] || '';
    } else if (photosProvided === false) {
      primaryReason =
        lang === 'CN' ? '本次没有可用照片，因此无法进行图像分析。' : 'No photo was provided in this run, so image-based analysis is unavailable.';
    } else {
      primaryReason =
        lang === 'CN'
          ? '本次未能成功读取照片字节，因此无法进行图像分析。'
          : "We couldn't read photo bytes for this run, so image-based analysis is unavailable.";
    }

    const guardrailReason =
      lang === 'CN'
        ? '为避免误导，本次结果仅基于问卷/历史信息，不会输出照片结论。'
        : 'To avoid misleading conclusions, this run is questionnaire/history-only.';

    const retakeGuide =
      lang === 'CN'
        ? [
            '自然光拍摄：正对窗户，避免背光与强阴影。',
            '距离 30–50cm，正脸平视，按引导框对齐：额头和下巴都在框内，鼻子尽量在中心线附近。',
            '关闭美颜/滤镜，确保对焦清晰且无遮挡（头发/口罩/手）。',
          ]
        : [
            'Use daylight facing a window; avoid backlight and strong shadows.',
            'Keep 30–50cm distance and align with the guide frame: forehead/chin inside the frame and nose near center line.',
            'Turn off beauty filters, keep sharp focus, and remove obstructions (hair/mask/hand).',
          ];

    const meanwhilePlan =
      lang === 'CN'
        ? [
            '如果有刺痛或泛红：暂停潜在刺激活性 5–7 天，仅保留温和洁面 + 保湿 + 白天防晒。',
            '如果出油但同时紧绷：减少清洁强度/次数，补一层轻薄保湿。',
            '如果连续 3 天稳定：仅恢复 1 个产品，每周 1–2 次，出现不适立即停用。',
          ]
        : [
            'If stinging or redness appears: pause potentially irritating actives for 5–7 days; keep gentle cleanser + moisturizer + daytime SPF only.',
            'If skin feels oily but tight: reduce cleansing intensity/frequency and add a light moisturizer layer.',
            'If stable for 3 straight days: re-introduce only one product at 1–2 nights/week; stop immediately if irritation returns.',
          ];

    const ask3 =
      lang === 'CN'
        ? [
            '最近 72 小时是否有刺痛/灼热？通常发生在第几步之后？',
            '你当前 AM/PM 每一步具体用了什么产品？各自频率是多少？',
            '最近是否有环境变化（出差/气候/作息/压力）影响皮肤状态？',
          ]
        : [
            'Any stinging or burning in the last 72 hours, and after which routine step?',
            'What exact products are you using in AM/PM, and how often for each?',
            'Any recent environment/lifestyle shift (travel, climate, sleep, stress) affecting your skin?',
          ];

    return {
      why_i_cant_analyze: [primaryReason, guardrailReason].filter(Boolean).slice(0, 2),
      retake_guide: retakeGuide.slice(0, 3),
      meanwhile_plan: meanwhilePlan.slice(0, 3),
      ask_3_questions: ask3.slice(0, 3),
    };
  }

  function renderPhotoFallbackStrategy({ language, photoNotice, actionCard } = {}) {
    const lang = language === 'CN' ? 'CN' : 'EN';
    const card = actionCard && typeof actionCard === 'object' ? actionCard : null;
    if (!card) return '';
    const lines = [];
    if (photoNotice) lines.push(photoNotice);
    lines.push(lang === 'CN' ? '为何暂时无法分析' : "Why I can't analyze");
    for (const item of Array.isArray(card.why_i_cant_analyze) ? card.why_i_cant_analyze.slice(0, 2) : []) lines.push(`- ${item}`);
    lines.push(lang === 'CN' ? '重拍指引' : 'Retake guide');
    for (const item of Array.isArray(card.retake_guide) ? card.retake_guide.slice(0, 3) : []) lines.push(`- ${item}`);
    lines.push(lang === 'CN' ? '7 天临时方案' : 'Meanwhile plan (7 days)');
    for (const item of Array.isArray(card.meanwhile_plan) ? card.meanwhile_plan.slice(0, 3) : []) lines.push(`- ${item}`);
    lines.push(lang === 'CN' ? '补充 3 个问题' : 'Ask-3 questions');
    for (const item of Array.isArray(card.ask_3_questions) ? card.ask_3_questions.slice(0, 3) : []) lines.push(`- ${item}`);
    return lines.join('\n').slice(0, 1200);
  }

  return {
    normalizePhotoFailureCodeForFallback,
    buildPhotoFallbackActionCard,
    renderPhotoFallbackStrategy,
  };
}

module.exports = {
  createPhotoFallbackRuntime,
};
