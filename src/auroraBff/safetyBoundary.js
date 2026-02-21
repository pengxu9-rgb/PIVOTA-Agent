const RED_FLAG_PATTERNS = Object.freeze([
  { id: 'severe_pain', severity: 'block', re: /\b(severe pain|intense pain|painful swelling)\b/i },
  { id: 'infection_signal', severity: 'block', re: /\b(pus|oozing|infection|fever|cellulitis)\b/i },
  { id: 'rapid_worsening', severity: 'block', re: /\b(sudden spread|rapidly spreading|worsening fast)\b/i },
  { id: 'bleeding_ulcer', severity: 'block', re: /\b(bleeding|open wound|ulcer)\b/i },
  { id: 'eye_swelling', severity: 'block', re: /\b(eye swelling|eyelid swelling|around my eye swollen)\b/i },
  { id: '剧痛', severity: 'block', re: /(剧痛|疼得厉害|刺痛很强)/ },
  { id: '感染迹象', severity: 'block', re: /(化脓|渗液|发烧|疑似感染)/ },
  { id: '快速恶化', severity: 'block', re: /(突然扩散|迅速加重|大面积恶化)/ },
  { id: '出血破溃', severity: 'block', re: /(出血|破溃|溃烂)/ },
  { id: '眼周严重', severity: 'block', re: /(眼周肿|眼皮肿|眼部肿胀)/ },
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function evaluateSafetyBoundary({ message, profile, artifact, language } = {}) {
  const text = String(message || '').trim();
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const flags = [];

  for (const rule of RED_FLAG_PATTERNS) {
    if (!rule || !rule.re) continue;
    if (!rule.re.test(text)) continue;
    flags.push({
      id: rule.id,
      severity: rule.severity || 'warn',
      source: 'message',
      snippet: text.slice(0, 120),
    });
  }

  const barrierStatus = normalizeToken(profile && profile.barrierStatus);
  const sensitivity = normalizeToken(profile && profile.sensitivity);
  const artifactSafetyFlags =
    asArray(artifact && artifact.safety && artifact.safety.red_flags)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || '').trim() || 'artifact_flag',
        severity: String(item.severity || 'warn').toLowerCase() === 'block' ? 'block' : 'warn',
        source: 'artifact',
      })) || [];

  for (const item of artifactSafetyFlags) flags.push(item);

  const highRiskProfile = (
    (barrierStatus === 'impaired' || barrierStatus === 'compromised' || barrierStatus === 'damaged') &&
    sensitivity === 'high'
  );
  if (highRiskProfile && text) {
    flags.push({
      id: 'fragile_profile_guard',
      severity: 'warn',
      source: 'profile',
    });
  }

  const hasBlock = flags.some((item) => item.severity === 'block');
  const uniqueFlags = [];
  const seen = new Set();
  for (const flag of flags) {
    const key = `${flag.id}|${flag.severity}|${flag.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueFlags.push(flag);
  }

  const assistantMessage = hasBlock
    ? (
        lang === 'CN'
          ? '你描述的症状存在医疗风险信号。我不能提供医疗诊断或继续商品推荐。建议先停用刺激性产品，并尽快咨询皮肤科或医疗机构。'
          : 'Your symptoms include medical risk signals. I cannot provide medical diagnosis or continue product recommendations. Please pause potentially irritating products and seek dermatology/medical care promptly.'
      )
    : (
        lang === 'CN'
          ? '我会保持非医疗建议范围，并优先给温和保守方案。'
          : 'I will stay within non-medical guidance and prioritize conservative options.'
      );

  const noticeBullets = hasBlock
    ? (
        lang === 'CN'
          ? ['停止新增强刺激活性（酸/维A/高浓功效）。', '若症状持续或加重，请及时就医。', '恢复后可再做护肤层面的温和评估。']
          : [
              'Pause strong actives (acids/retinoids/high-potency actives).',
              'If symptoms persist or worsen, seek professional care promptly.',
              'Resume skincare-only guidance after stabilization.',
            ]
      )
    : (
        lang === 'CN'
          ? ['本服务仅提供护肤建议，不提供医疗诊断。']
          : ['This service provides skincare guidance only, not medical diagnosis.']
      );

  return {
    block: hasBlock,
    flags: uniqueFlags.slice(0, 8),
    assistant_message: assistantMessage,
    notice_bullets: noticeBullets,
    disclaimer_version: 'v1',
  };
}

module.exports = {
  RED_FLAG_PATTERNS,
  evaluateSafetyBoundary,
};
