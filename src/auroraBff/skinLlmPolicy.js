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
  qualitySourceMode,
  detectorConfidenceLevel,
  uncertainty,
  visionAvailable,
  visionUnavailabilityReason,
  reportAvailable,
  degradedMode,
} = {}) {
  const k = normalizeToken(kind);
  const q = normalizeToken(quality && quality.grade ? quality.grade : quality);
  const confidence = normalizeToken(detectorConfidenceLevel);
  const uncertainFlag = typeof uncertainty === 'boolean' ? uncertainty : null;
  const degradeMode = normalizeToken(degradedMode) || 'report';
  const qualitySource = normalizeToken(qualitySourceMode) || 'legacy';

  const reasons = [];
  let downgrade_confidence = false;

  if (!hasPrimaryInput) {
    return { decision: 'skip', reasons: ['missing_primary_input'], downgrade_confidence: false };
  }

  if (k === 'vision') {
    if (!userRequestedPhoto) return { decision: 'skip', reasons: ['photo_not_requested'], downgrade_confidence: false };
    if (!visionAvailable) {
      const rawReason = String(visionUnavailabilityReason || '').trim();
      const normalizedReason = rawReason && /^VISION_[A-Z0-9_]+$/.test(rawReason) ? rawReason : 'vision_unavailable';
      return { decision: 'skip', reasons: [normalizedReason], downgrade_confidence: false };
    }

    if (qualitySource === 'upload_qc_only') {
      if (q === 'pass') {
        return { decision: 'call', reasons: ['upload_qc_pass'], downgrade_confidence: false };
      }
      if (q === 'degraded') {
        return { decision: 'skip', reasons: ['upload_qc_degraded_retake'], downgrade_confidence: true };
      }
      if (q === 'unknown') {
        return { decision: 'skip', reasons: ['upload_qc_unknown_retake'], downgrade_confidence: true };
      }
      if (q === 'fail') {
        return { decision: 'skip', reasons: ['photo_quality_fail_retake'], downgrade_confidence: true };
      }
    }

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

    if (qualitySource === 'upload_qc_only' && userRequestedPhoto) {
      if (q === 'pass') {
        return { decision: 'call', reasons: ['upload_qc_pass'], downgrade_confidence: false };
      }
      if (q === 'degraded') {
        return { decision: 'skip', reasons: ['upload_qc_degraded_retake'], downgrade_confidence: true };
      }
      if (q === 'unknown') {
        return { decision: 'skip', reasons: ['upload_qc_unknown_retake'], downgrade_confidence: true };
      }
      if (q === 'fail') {
        return { decision: 'skip', reasons: ['photo_quality_fail_retake'], downgrade_confidence: true };
      }
    }

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

const ISSUE_SPECIFIC_MESSAGES = Object.freeze({
  EN: Object.freeze({
    strong_light: 'Strong lighting may hide redness; focusing on texture and distribution.',
    specular_shine: 'Shine can exaggerate oiliness; cross-checking with pore contrast and texture.',
    motion_blur: 'Slight blur reduces detail; avoiding calls on tiny bumps.',
    white_balance_cast: 'Color cast may shift tone readings; focusing on texture over color.',
    low_coverage: 'Limited face coverage; focusing analysis on visible regions.',
  }),
  CN: Object.freeze({
    strong_light: '强光可能遮盖泛红，侧重纹理与分布分析。',
    specular_shine: '反光可能放大油腻感，将结合毛孔与纹理交叉验证。',
    motion_blur: '轻微模糊降低细节可见度，不会判断微小凸起。',
    white_balance_cast: '色偏可能影响色调判断，侧重纹理分析。',
    low_coverage: '面部覆盖有限，聚焦可见区域分析。',
  }),
});

function pickIssueMessage(issues, lang) {
  const msgs = ISSUE_SPECIFIC_MESSAGES[lang] || ISSUE_SPECIFIC_MESSAGES.EN;
  if (!Array.isArray(issues)) return '';
  for (const issue of issues) {
    const key = String(issue || '').trim().toLowerCase();
    if (msgs[key]) return msgs[key];
  }
  return '';
}

function stripQualityDisclaimerLines(input) {
  const text = typeof input === 'string' ? input : '';
  if (!text.trim()) return '';
  const lines = text.split(/\r?\n/);
  const keep = lines.filter((line) => {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return false;
    if (
      t.includes('photo quality') ||
      t.includes('degraded') ||
      t.includes('conservative') ||
      t.includes('保守') ||
      t.includes('照片质量')
    ) {
      return false;
    }
    return true;
  });
  return keep.join('\n').trim();
}

function downgradeSkinAnalysisConfidence(analysis, { language, qualityObject } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const a = analysis && typeof analysis === 'object' ? analysis : null;
  if (!a) return analysis;

  const qObj = qualityObject && typeof qualityObject === 'object' ? qualityObject : {};
  const issues = Array.isArray(qObj.issues) ? qObj.issues : [];

  const featuresRaw = Array.isArray(a.features) ? a.features : [];
  const features = featuresRaw.map((f) => {
    const obj = f && typeof f === 'object' ? f : null;
    if (!obj) return null;
    const observation = typeof obj.observation === 'string' ? obj.observation : '';
    const c = typeof obj.confidence === 'string' ? obj.confidence : '';
    const confidence = c === 'pretty_sure' ? 'somewhat_sure' : c === 'somewhat_sure' ? 'not_sure' : 'not_sure';
    return { observation, confidence };
  }).filter(Boolean);

  const strategyRaw = stripQualityDisclaimerLines(typeof a.strategy === 'string' ? a.strategy.trim() : '');
  const issueMsg = pickIssueMessage(issues, lang);
  const strategy = strategyRaw.slice(0, 1200);

  const qualityMessage = issueMsg || (lang === 'CN' ? '照片质量略有不足，已适当降低置信度。' : 'Photo quality is slightly reduced; confidence has been adjusted.');

  return { ...a, features, strategy, quality_message: qualityMessage };
}

const CONFIDENCE_CAP_BY_GRADE = { pass: 'high', degraded: 'med', fail: null };

function capConfidenceByGrade(confidence, qualityGrade) {
  const grade = String(qualityGrade || 'pass').toLowerCase();
  const cap = CONFIDENCE_CAP_BY_GRADE[grade];
  if (cap === null) return null;
  if (!cap) return confidence;
  const order = { low: 0, med: 1, high: 2 };
  const confVal = order[String(confidence || 'med').toLowerCase()];
  const capVal = order[cap];
  if (confVal == null || capVal == null) return confidence;
  return confVal > capVal ? cap : confidence;
}

function applyConfidenceCaps(analysis, qualityGrade) {
  const a = analysis && typeof analysis === 'object' ? analysis : null;
  if (!a) return analysis;
  const grade = String(qualityGrade || 'pass').toLowerCase();

  if (grade === 'fail') {
    return { ...a, findings: [], features: [], insufficient_visual_detail: true };
  }

  const findings = Array.isArray(a.findings) ? a.findings.map((f) => {
    if (!f || typeof f !== 'object') return f;
    return { ...f, confidence: capConfidenceByGrade(f.confidence, grade) };
  }) : a.findings;

  const features = Array.isArray(a.features) ? a.features.map((f) => {
    if (!f || typeof f !== 'object') return f;
    const conf = String(f.confidence || '').toLowerCase();
    if (grade === 'degraded') {
      const capped = conf === 'pretty_sure' ? 'somewhat_sure' : conf;
      return { ...f, confidence: capped };
    }
    return f;
  }) : a.features;

  return { ...a, findings, features };
}

function detectInsufficientVisualDetail(observations) {
  const obs = Array.isArray(observations) ? observations : [];
  if (!obs.length) return true;
  const lowCount = obs.filter((o) => o && String(o.confidence || '').toLowerCase() === 'low').length;
  return lowCount / obs.length >= 0.8;
}

function enforceQualityNarrative(analysis, { language, qualityObject } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const a = analysis && typeof analysis === 'object' ? { ...analysis } : null;
  if (!a) return analysis;

  const q = qualityObject && typeof qualityObject === 'object' ? qualityObject : {};
  const rawGrade = String(q.grade || '').trim().toLowerCase();
  const grade = rawGrade === 'pass' || rawGrade === 'degraded' || rawGrade === 'fail' ? rawGrade : 'degraded';

  const degradedMessage =
    pickIssueMessage(Array.isArray(q.issues) ? q.issues : [], lang) ||
    (lang === 'CN' ? '照片质量一般，分析已按可见区域做保守处理。' : 'Photo quality is degraded; analysis is limited to reliably visible cues.');
  const failMessage =
    lang === 'CN'
      ? '照片质量不足，当前不输出观察结论，请按提示重拍。'
      : 'Photo quality is insufficient; no findings are shown for this turn. Please retake and retry.';

  if (grade === 'pass') {
    a.strategy = stripQualityDisclaimerLines(typeof a.strategy === 'string' ? a.strategy : '');
    if (Array.isArray(a.features)) {
      a.features = a.features.filter((row) => {
        if (!row || typeof row !== 'object') return false;
        const obs = String(row.observation || '').trim();
        if (!obs) return false;
        const token = obs.toLowerCase();
        return !(
          token.includes('degraded') ||
          token.includes('conservative') ||
          token.includes('photo quality') ||
          token.includes('照片质量') ||
          token.includes('保守')
        );
      });
    }
    delete a.quality_message;
    return a;
  }

  if (grade === 'degraded') {
    a.strategy = stripQualityDisclaimerLines(typeof a.strategy === 'string' ? a.strategy : '');
    a.quality_message = degradedMessage;
    return a;
  }

  a.features = [];
  a.findings = [];
  a.strategy =
    lang === 'CN'
      ? '请重拍一张自然光、无滤镜、清晰对焦、正脸无遮挡的照片，然后我再继续分析。'
      : 'Please retake one clear front-facing photo in natural light (no filter, no occlusion), then I can continue the analysis.';
  a.guidance_brief =
    lang === 'CN'
      ? ['靠近窗边自然光', '镜头对焦后再拍', '确保脸部完整入镜且无遮挡']
      : ['Use natural daylight near a window', 'Wait for focus lock before capture', 'Keep your full face in frame without occlusion'];
  a.quality_message = failMessage;
  a.insufficient_visual_detail = true;
  return a;
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
    photo_fetch_failed_force_report: 'Photo upload passed but image bytes were unavailable; forcing report LLM for conservative guidance.',
    photo_upload_force_report: 'Photo upload detected; forcing report LLM for a consolidated explanation.',
    upload_qc_pass: 'Upload QC passed: forcing Vision + Report calls in QC-only mode.',
    upload_qc_degraded_retake: 'Upload QC is degraded: block LLM calls and ask for a retake.',
    upload_qc_unknown_retake: 'Upload QC is unknown: block LLM calls and ask for a retake.',
    quality_pass: 'Photo quality passed.',
    vision_missing_key: 'Photo model key is missing.',
    vision_disabled_by_flag: 'Photo model is disabled by feature flag.',
    vision_rate_limited: 'Photo model is temporarily rate-limited.',
    vision_quota_exceeded: 'Photo model quota is exhausted.',
    vision_timeout: 'Photo model timed out.',
    vision_upstream_4xx: 'Photo model request was rejected (4xx).',
    vision_upstream_5xx: 'Photo model upstream failed (5xx).',
    vision_schema_invalid: 'Photo model output schema is invalid.',
    vision_image_fetch_failed: 'Photo image download or decode failed.',
    vision_unknown: 'Photo model failed for an unknown reason.',
    vision_cv_fallback_used: 'Photo model unavailable; CV fallback was used.',
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
    photo_fetch_failed_force_report: '照片上传通过但图像字节不可用：强制调用报告模型给出保守建议。',
    photo_upload_force_report: '检测到用户上传照片：强制调用报告模型做汇总解释。',
    upload_qc_pass: '上传质检通过：QC-only 模式下强制调用 Vision + Report。',
    upload_qc_degraded_retake: '上传质检为 degraded：阻断 LLM 调用并建议重拍。',
    upload_qc_unknown_retake: '上传质检为 unknown：阻断 LLM 调用并建议重拍。',
    quality_pass: '照片质量通过。',
    vision_missing_key: '照片模型密钥缺失。',
    vision_disabled_by_flag: '照片模型被开关禁用。',
    vision_rate_limited: '照片模型触发限流。',
    vision_quota_exceeded: '照片模型配额已耗尽。',
    vision_timeout: '照片模型调用超时。',
    vision_upstream_4xx: '照片模型请求被拒绝（4xx）。',
    vision_upstream_5xx: '照片模型上游故障（5xx）。',
    vision_schema_invalid: '照片模型输出不符合结构化格式。',
    vision_image_fetch_failed: '照片下载或解码失败。',
    vision_unknown: '照片模型失败（未知原因）。',
    vision_cv_fallback_used: '照片模型不可用，已使用 CV 兜底。',
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

function shouldFireDeepening({ qualityObject, observations, userReportedSymptoms } = {}) {

  const q = qualityObject && typeof qualityObject === 'object' ? qualityObject : {};
  const grade = String(q.grade || 'pass').toLowerCase();

  if (grade !== 'pass') return { fire: true, reason: 'quality_not_pass' };

  const obs = Array.isArray(observations) ? observations : [];
  const lowConfCount = obs.filter((o) => o && String(o.confidence || '').toLowerCase() === 'low').length;
  if (lowConfCount >= 2) return { fire: true, reason: 'multiple_low_confidence_observations' };

  const symptoms = Array.isArray(userReportedSymptoms) ? userReportedSymptoms : [];
  const hasActionableSymptom = symptoms.some((s) => {
    const token = String(s || '').toLowerCase();
    return token.includes('sting') || token.includes('itch') || token.includes('burn') ||
      token.includes('flak') || token.includes('tight') || token.includes('刺') ||
      token.includes('痒') || token.includes('灼') || token.includes('脱皮') || token.includes('紧绷');
  });
  if (hasActionableSymptom) return { fire: true, reason: 'user_symptoms_may_change_plan' };

  return { fire: false, reason: 'no_deepening_trigger' };
}

module.exports = {
  classifyPhotoQuality,
  inferDetectorConfidence,
  shouldCallLlm,
  should_call_llm: shouldCallLlm,
  downgradeSkinAnalysisConfidence,
  enforceQualityNarrative,
  humanizeLlmReasons,
  shouldFireDeepening,
  capConfidenceByGrade,
  applyConfidenceCaps,
  detectInsufficientVisualDetail,
};
