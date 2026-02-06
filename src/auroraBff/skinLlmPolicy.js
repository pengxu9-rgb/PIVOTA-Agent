function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function classifyPhotoQuality(photos) {
  const list = Array.isArray(photos) ? photos : [];
  if (!list.length) return { grade: 'unknown', reasons: ['no_photos'] };

  let hasPassed = false;
  let hasDegraded = false;
  let hasFailed = false;
  let hasUnknown = false;

  for (const p of list) {
    const qc = normalizeToken(p && typeof p === 'object' ? p.qc_status : '');
    if (!qc) {
      hasUnknown = true;
      continue;
    }
    if (qc === 'passed' || qc === 'pass' || qc === 'ok') {
      hasPassed = true;
      continue;
    }
    if (qc === 'degraded' || qc === 'warn' || qc === 'warning' || qc === 'low') {
      hasDegraded = true;
      continue;
    }
    if (qc === 'fail' || qc === 'failed' || qc === 'reject' || qc === 'rejected' || qc === 'bad') {
      hasFailed = true;
      continue;
    }
    // Conservative: unknown QC tokens behave like degraded (avoid overconfident analysis).
    hasDegraded = true;
    hasUnknown = true;
  }

  // Use the "best available" quality for decisioning:
  // - If any photo passed, prefer pass (ignore failed extras).
  // - Else if any degraded/unknown exists, treat as degraded.
  // - Else if only failed photos exist, treat as fail.
  if (hasPassed) {
    return { grade: 'pass', reasons: ['qc_passed'] };
  }
  if (hasDegraded) {
    const reasons = ['qc_degraded'];
    if (hasUnknown) reasons.push('qc_unknown_token');
    return { grade: 'degraded', reasons };
  }
  if (hasFailed) {
    return { grade: 'fail', reasons: ['qc_failed'] };
  }
  return { grade: 'unknown', reasons: ['qc_missing_or_unknown'] };
}

function inferDetectorConfidence({ profileSummary, recentLogsSummary, routineCandidate } = {}) {
  const p = profileSummary && typeof profileSummary === 'object' ? profileSummary : {};
  const logs = Array.isArray(recentLogsSummary) ? recentLogsSummary : [];
  const routineRaw = routineCandidate;
  const routineText =
    typeof routineRaw === 'string'
      ? routineRaw
      : routineRaw && typeof routineRaw === 'object'
        ? JSON.stringify(routineRaw)
        : '';
  const routineLower = String(routineText || '').toLowerCase();

  const signals = [];
  const strong = [];

  if (p.skinType && String(p.skinType).trim()) signals.push('skin_type');
  if (p.barrierStatus && String(p.barrierStatus).trim()) {
    signals.push('barrier_status');
    if (String(p.barrierStatus).trim() === 'impaired') strong.push('barrier_status');
  }
  if (p.sensitivity && String(p.sensitivity).trim()) signals.push('sensitivity');
  if (routineLower) {
    signals.push('routine');
    if (/\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b|\bglycolic\b|\blactic\b|\bmandelic\b|\bsalicylic\b|\baha\b|\bbha\b|\bbpo\b/.test(routineLower)) {
      strong.push('actives_in_routine');
    }
  }
  if (logs.length) {
    signals.push('recent_logs');
    const latest = logs[0] && typeof logs[0] === 'object' ? logs[0] : null;
    if (latest && Object.values(latest).some((v) => typeof v === 'number' && Number.isFinite(v))) strong.push('recent_logs');
  }

  const level = strong.length >= 1 && signals.length >= 3 ? 'high' : signals.length >= 2 ? 'medium' : 'low';
  return { level, signals, strong };
}

function shouldCallLlm({
  kind,
  quality,
  hasPrimaryInput,
  userRequestedPhoto,
  detectorConfidenceLevel,
  uncertainty,
  visionAvailable,
  reportAvailable,
  degradedMode,
} = {}) {
  const k = normalizeToken(kind);
  const q = normalizeToken(quality && quality.grade ? quality.grade : quality);
  const confidence = normalizeToken(detectorConfidenceLevel);
  const uncertainFlag = typeof uncertainty === 'boolean' ? uncertainty : null;
  const degradeMode = normalizeToken(degradedMode) || 'report';

  const reasons = [];
  let downgrade_confidence = false;

  if (!hasPrimaryInput) {
    return { decision: 'skip', reasons: ['missing_primary_input'], downgrade_confidence: false };
  }

  if (k === 'vision') {
    if (!userRequestedPhoto) return { decision: 'skip', reasons: ['photo_not_requested'], downgrade_confidence: false };
    if (!visionAvailable) return { decision: 'skip', reasons: ['vision_unavailable'], downgrade_confidence: false };

    if (q === 'fail') return { decision: 'skip', reasons: ['photo_quality_fail_retake'], downgrade_confidence: true };

    if (q === 'degraded' || q === 'unknown') {
      downgrade_confidence = true;
      if (degradeMode === 'vision') {
        reasons.push('degraded_mode_vision');
        return { decision: 'call', reasons, downgrade_confidence };
      }
      reasons.push('degraded_skip_vision');
      return { decision: 'skip', reasons, downgrade_confidence };
    }

    // Pass quality: If the deterministic detector is confident *and* explicitly not uncertain,
    // skip the photo LMM to reduce cost / avoid redundant analysis.
    if (uncertainFlag === false && confidence === 'high') {
      return { decision: 'skip', reasons: ['detector_confident_template'], downgrade_confidence: false };
    }

    return { decision: 'call', reasons: ['quality_pass'], downgrade_confidence: false };
  }

  if (k === 'report') {
    if (!reportAvailable) return { decision: 'skip', reasons: ['report_unavailable'], downgrade_confidence: false };

    if (q === 'fail') {
      return { decision: 'skip', reasons: ['photo_quality_fail_retake'], downgrade_confidence: true };
    }

    if (q === 'degraded' || q === 'unknown') {
      downgrade_confidence = true;
      if (degradeMode === 'report') {
        reasons.push('degraded_mode_report');
        return { decision: 'call', reasons, downgrade_confidence };
      }
      reasons.push('degraded_skip_report');
      return { decision: 'skip', reasons, downgrade_confidence };
    }

    // Pass quality: only escalate to report LLM when the deterministic detector is uncertain.
    if (uncertainFlag === false) {
      return { decision: 'skip', reasons: ['detector_confident_template'], downgrade_confidence: false };
    }
    if (uncertainFlag === true) {
      return { decision: 'call', reasons: ['detector_uncertain'], downgrade_confidence: false };
    }

    // Fallback when uncertainty is unknown: preserve legacy behavior.
    if (confidence === 'high') {
      return { decision: 'skip', reasons: ['detector_confident_template'], downgrade_confidence: false };
    }
    return { decision: 'call', reasons: ['detector_uncertain'], downgrade_confidence: false };
  }

  return { decision: 'skip', reasons: ['unknown_kind'], downgrade_confidence: false };
}

function downgradeSkinAnalysisConfidence(analysis, { language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const a = analysis && typeof analysis === 'object' ? analysis : null;
  if (!a) return analysis;
  const featuresRaw = Array.isArray(a.features) ? a.features : [];
  const features = featuresRaw.map((f) => {
    const obj = f && typeof f === 'object' ? f : null;
    if (!obj) return null;
    const observation = typeof obj.observation === 'string' ? obj.observation : '';
    const c = typeof obj.confidence === 'string' ? obj.confidence : '';
    const confidence = c === 'pretty_sure' ? 'somewhat_sure' : c === 'somewhat_sure' ? 'not_sure' : 'not_sure';
    return { observation, confidence };
  }).filter(Boolean);

  const strategyRaw = typeof a.strategy === 'string' ? a.strategy.trim() : '';
  const prefix =
    /^(?:\u2705|\u26a0|\ud83d\udccd|\*\*)/.test(strategyRaw) || strategyRaw.toLowerCase().startsWith('note:')
      ? ''
      : lang === 'CN'
        ? '提示：照片质量一般，我会更保守一些，避免误判。\n'
        : 'Note: photo quality is degraded, so keep expectations conservative.\n';

  const strategy = `${prefix}${strategyRaw}`.slice(0, 1200);
  return { ...a, features, strategy };
}

const REASON_TEXT = Object.freeze({
  EN: Object.freeze({
    llm_kill_switch: 'LLM kill switch is enabled; skipping all model calls.',
    missing_primary_input: 'Missing routine / recent logs; returning a conservative baseline first.',
    photo_not_requested: 'Photo analysis was not requested.',
    vision_unavailable: 'Photo model is unavailable (missing key or disabled).',
    report_unavailable: 'Report model is unavailable (upstream not configured).',
    photo_quality_fail_retake: 'Photo quality failed; skip AI analysis and retake to avoid wrong guesses.',
    degraded_mode_vision: 'Photo quality is degraded: only using the photo model and downgrading confidence.',
    degraded_mode_report: 'Photo quality is degraded: only using the report model and downgrading confidence.',
    degraded_skip_vision: 'Photo quality is degraded: skipping the photo model to avoid unstable results.',
    degraded_skip_report: 'Photo quality is degraded: skipping the report model to avoid unstable results.',
    detector_confident_template: 'Signals are strong enough; using a deterministic template instead of calling an LLM.',
    detector_uncertain: 'Signals are uncertain; calling an LLM to explain / arbitrate.',
    quality_pass: 'Photo quality passed.',
    unknown_kind: 'Unknown LLM kind.',
  }),
  CN: Object.freeze({
    llm_kill_switch: '已开启 LLM 总开关：强制跳过所有模型调用。',
    missing_primary_input: '缺少当前流程/最近打卡等关键信息；我会先给更保守的基线。',
    photo_not_requested: '你没有选择使用照片解析。',
    vision_unavailable: '照片解析模型不可用（缺少 key 或未启用）。',
    report_unavailable: '报告模型不可用（上游未配置或不可达）。',
    photo_quality_fail_retake: '照片未通过质量检查；为避免误判我会跳过 AI 结论，建议重拍。',
    degraded_mode_vision: '照片质量一般：只调用照片解析模型，并强制降低置信度。',
    degraded_mode_report: '照片质量一般：只调用报告模型，并强制降低置信度。',
    degraded_skip_vision: '照片质量一般：为避免不稳定结果，跳过照片解析模型。',
    degraded_skip_report: '照片质量一般：为避免不稳定结果，跳过报告模型。',
    detector_confident_template: '已有足够确定的信号：用确定性模板生成更稳的报告（不再调用模型）。',
    detector_uncertain: '信号不确定：调用模型做解释/仲裁。',
    quality_pass: '照片质量通过。',
    unknown_kind: '未知模型类型。',
  }),
});

function humanizeLlmReasons(reasons, { language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const map = REASON_TEXT[lang] || REASON_TEXT.EN;
  const list = Array.isArray(reasons) ? reasons : [];
  const out = [];
  for (const raw of list) {
    const key = normalizeToken(raw);
    if (!key) continue;
    out.push(map[key] || String(raw));
  }
  return out;
}

module.exports = {
  classifyPhotoQuality,
  inferDetectorConfidence,
  shouldCallLlm,
  should_call_llm: shouldCallLlm,
  downgradeSkinAnalysisConfidence,
  humanizeLlmReasons,
};
