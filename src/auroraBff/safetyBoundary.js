const RED_FLAG_PATTERNS = Object.freeze([
  { id: 'severe_pain', severity: 'block', re: /\b(severe pain|intense pain|throbbing pain|burning pain|painful swelling)\b/i },
  { id: 'infection_signal', severity: 'block', re: /\b(pus|oozing|discharge|infection|infected|fever|feverish|cellulitis)\b/i },
  { id: 'rapid_worsening', severity: 'block', re: /\b(sudden spread|rapidly spreading|spreading fast|get(?:ting)? worse quickly|worsening fast)\b/i },
  { id: 'bleeding_ulcer', severity: 'block', re: /\b(bleeding|open wound|open sore|ulcer|ulceration)\b/i },
  { id: 'eye_swelling', severity: 'block', re: /\b(eye swelling|eyelid swelling|around my eye swollen|eye area swollen|puffy eyelid)\b/i },
  { id: '剧痛', severity: 'block', re: /(剧痛|疼得厉害|刺痛很强|灼痛明显)/ },
  { id: '感染迹象', severity: 'block', re: /(化脓|渗液|流脓|发烧|发热|疑似感染|感染了)/ },
  { id: '快速恶化', severity: 'block', re: /(突然扩散|迅速加重|恶化很快|大面积恶化|越来越严重)/ },
  { id: '出血破溃', severity: 'block', re: /(出血|破溃|溃烂|开放性伤口)/ },
  { id: '眼周严重', severity: 'block', re: /(眼周肿|眼皮肿|眼部肿胀|眼周浮肿)/ },
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

function normalizeSafetyText(value) {
  return String(value || '')
    .replace(/[，。；、！？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyNegated(text, matchIndex) {
  const idx = Number.isFinite(Number(matchIndex)) ? Math.max(0, Math.trunc(Number(matchIndex))) : 0;
  const left = text.slice(Math.max(0, idx - 20), idx).toLowerCase();
  const leftCn = text.slice(Math.max(0, idx - 12), idx);
  if (/\b(no|not|without|never|none|deny|denies|denied|dont|don't|didnt|didn't|isnt|isn't)\b/.test(left)) return true;
  if (/(无|没有|并无|未见|不是|并非|未出现|不再)/.test(leftCn)) return true;
  return false;
}

function evaluateSafetyBoundary({ message, profile, artifact, language } = {}) {
  const text = normalizeSafetyText(message);
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const flags = [];

  for (const rule of RED_FLAG_PATTERNS) {
    if (!rule || !rule.re) continue;
    const matched = text.match(rule.re);
    if (!matched) continue;
    if (isLikelyNegated(text, matched.index)) continue;
    const matchStart = Number.isFinite(Number(matched.index)) ? Math.max(0, Math.trunc(Number(matched.index))) : 0;
    const snippet = text.slice(Math.max(0, matchStart - 30), Math.min(text.length, matchStart + 120)).trim();
    flags.push({
      id: rule.id,
      severity: rule.severity || 'warn',
      source: 'message',
      snippet: snippet || text.slice(0, 120),
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
