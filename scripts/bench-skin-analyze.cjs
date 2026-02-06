#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

const { createStageProfiler } = require('../src/auroraBff/skinAnalysisProfiling');
const { __internal } = require('../src/auroraBff/routes');
const { buildSkinReportPrompt } = require('../src/auroraBff/skinLlmPrompts');
const { parseJsonOnlyObject } = require('../src/auroraBff/jsonExtract');
const {
  inferDetectorConfidence,
  shouldCallLlm,
  humanizeLlmReasons,
  downgradeSkinAnalysisConfidence,
} = require('../src/auroraBff/skinLlmPolicy');
const {
  runSkinDiagnosisV1,
  summarizeDiagnosisForPolicy,
  buildSkinAnalysisFromDiagnosisV1,
} = require('../src/auroraBff/skinDiagnosisV1');
const { auroraChat } = require('../src/auroraBff/auroraDecisionClient');

function unwrapCodeFence(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('```')) return t;
  const firstNewline = t.indexOf('\n');
  const lastFence = t.lastIndexOf('```');
  if (firstNewline === -1 || lastFence === -1 || lastFence <= firstNewline) return t;
  return t.slice(firstNewline + 1, lastFence).trim();
}

function parseArgs(argv) {
  const out = { lang: 'EN', repeat: 5, qc: 'pass', primary: 'routine', detector: 'auto', degradedMode: null, images: [] };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--lang' && args[i + 1]) {
      out.lang = String(args[i + 1]).toUpperCase() === 'CN' ? 'CN' : 'EN';
      i += 1;
      continue;
    }
    if (a === '--qc' && args[i + 1]) {
      const v = String(args[i + 1]).trim().toLowerCase();
      out.qc =
        v === 'fail' || v === 'failed'
          ? 'fail'
          : v === 'degraded' || v === 'warn' || v === 'warning'
            ? 'degraded'
            : v === 'unknown'
              ? 'unknown'
              : 'pass';
      i += 1;
      continue;
    }
    if (a === '--primary' && args[i + 1]) {
      const v = String(args[i + 1]).trim().toLowerCase();
      out.primary = v === 'none' ? 'none' : v === 'logs' ? 'logs' : 'routine';
      i += 1;
      continue;
    }
    if (a === '--detector' && args[i + 1]) {
      const v = String(args[i + 1]).trim().toLowerCase();
      out.detector = v === 'high' || v === 'medium' || v === 'low' ? v : 'auto';
      i += 1;
      continue;
    }
    if (a === '--degraded-mode' && args[i + 1]) {
      const v = String(args[i + 1]).trim().toLowerCase();
      out.degradedMode = v === 'vision' ? 'vision' : v === 'report' ? 'report' : null;
      i += 1;
      continue;
    }
    if (a === '--repeat' && args[i + 1]) {
      const n = Number(args[i + 1]);
      out.repeat = Number.isFinite(n) ? Math.max(1, Math.min(200, Math.trunc(n))) : out.repeat;
      i += 1;
      continue;
    }
    if (a === '--') {
      out.images.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) continue;
    out.images.push(a);
  }
  return out;
}

function isImagePath(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp';
}

function clampByte(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(255, Math.round(x)));
}

function makeRng(seed) {
  let s = Number.isFinite(seed) ? seed >>> 0 : 0x12345678;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function ensureDefaultImage() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora_bench_'));
  const outPath = path.join(tmpDir, 'synthetic_skin.png');

  const width = 256;
  const height = 256;
  const baseR = 180;
  const baseG = 170;
  const baseB = 160;

  const rng = makeRng(42);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const shade = (x / (width - 1) - 0.5) * 10 + (y / (height - 1) - 0.5) * 6;
      const noise = (rng() - 0.5) * 24;
      raw[i] = clampByte(baseR + shade + noise);
      raw[i + 1] = clampByte(baseG + shade * 0.9 + noise * 0.9);
      raw[i + 2] = clampByte(baseB + shade * 0.8 + noise * 0.8);
    }
  }

  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(outPath);
  return outPath;
}

function safeName(p) {
  const base = path.basename(String(p || ''));
  return base.length ? base : 'image';
}

async function runOne(imagePath, { lang, qc, primary, detector, degradedMode } = {}) {
  const profiler = createStageProfiler();
  profiler.skip('face', 'not_implemented');

  let imageBuffer = null;
  try {
    profiler.start('decode', { kind: 'fs_read' });
    imageBuffer = fs.readFileSync(imagePath);
    profiler.end('decode', { kind: 'fs_read', bytes: imageBuffer.length });
  } catch (err) {
    profiler.fail('decode', err, { kind: 'fs_read' });
    const report = profiler.report();
    return {
      ok: false,
      image: safeName(imagePath),
      error_reason: 'read_failed',
      report,
    };
  }

  const qcGrade = qc === 'fail' || qc === 'degraded' || qc === 'unknown' ? qc : 'pass';
  const primaryMode = primary === 'none' || primary === 'logs' ? primary : 'routine';
  const detectorOverride = detector === 'high' || detector === 'medium' || detector === 'low' ? detector : 'auto';

  const baseProfile = {
    skinType: 'oily',
    barrierStatus: 'healthy',
    sensitivity: 'low',
    currentRoutine: null,
  };
  const hasPrimaryInput = primaryMode !== 'none';
  const routineCandidate =
    primaryMode === 'routine'
      ? {
          am: { cleanser: 'gentle', spf: 'spf' },
          pm: { cleanser: 'gentle', moisturizer: 'basic' },
        }
      : null;
  const recentLogsSummary =
    primaryMode === 'logs'
      ? [
          {
            redness: 2,
            acne: 2,
            hydration: 3,
          },
        ]
      : [];
  const profileSummary = { ...baseProfile, ...(routineCandidate ? { currentRoutine: routineCandidate } : {}) };

  profiler.timeSync('quality', () => null, { kind: 'bench_context', primary: primaryMode, qc: qcGrade });

  const detectorConfidenceAuto = inferDetectorConfidence({ profileSummary, recentLogsSummary, routineCandidate });
  const detectorConfidenceLevel = detectorOverride !== 'auto' ? detectorOverride : detectorConfidenceAuto.level;

  const degradedModeEnv = String(process.env.AURORA_SKIN_DEGRADED_MODE || '').trim().toLowerCase() === 'vision' ? 'vision' : 'report';
  const degradedModeFinal = degradedMode === 'vision' || degradedMode === 'report' ? degradedMode : degradedModeEnv;

  const visionAvailable =
    String(process.env.AURORA_SKIN_VISION_ENABLED || '').trim().toLowerCase() === 'true' && Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  const reportAvailable =
    Boolean(String(process.env.AURORA_DECISION_BASE_URL || '').trim()) && String(process.env.AURORA_BFF_USE_MOCK || '').trim().toLowerCase() !== 'true';

  const photosProvided = Boolean(imageBuffer && imageBuffer.length);
  const userRequestedPhoto = true;
  const photoQuality = { grade: qcGrade, reasons: ['bench_qc'] };

  let diagnosisV1 = null;
  let diagnosisPolicy = null;

  function mergePhotoQuality(baseQuality, extraQuality, { extraPrefix } = {}) {
    const base = baseQuality && typeof baseQuality === 'object' ? baseQuality : { grade: 'unknown', reasons: [] };
    const extra = extraQuality && typeof extraQuality === 'object' ? extraQuality : null;
    if (!extra) return base;
    const order = { unknown: 0, pass: 1, degraded: 2, fail: 3 };
    const g0 = String(base.grade || 'unknown').trim().toLowerCase();
    const g1 = String(extra.grade || 'unknown').trim().toLowerCase();
    const grade0 = order[g0] != null ? g0 : 'unknown';
    const grade1 = order[g1] != null ? g1 : 'unknown';
    const mergedGrade = order[grade1] > order[grade0] ? grade1 : grade0;
    const r0 = Array.isArray(base.reasons) ? base.reasons : [];
    const r1raw = Array.isArray(extra.reasons) ? extra.reasons : [];
    const r1 = extraPrefix ? r1raw.map((r) => `${extraPrefix}${r}`) : r1raw;
    const mergedReasons = Array.from(new Set([...r0, ...r1])).slice(0, 10);
    return { grade: mergedGrade, reasons: mergedReasons };
  }

  if (userRequestedPhoto && photosProvided && hasPrimaryInput && photoQuality.grade !== 'fail') {
    try {
      const diag = await runSkinDiagnosisV1({
        imageBuffer,
        language: lang,
        profileSummary,
        recentLogsSummary,
        profiler,
      });
      if (diag && diag.ok && diag.diagnosis) {
        diagnosisV1 = diag.diagnosis;
        diagnosisPolicy = summarizeDiagnosisForPolicy(diagnosisV1);
        const dq = diagnosisV1 && diagnosisV1.quality && typeof diagnosisV1.quality === 'object' ? diagnosisV1.quality : null;
        if (dq) {
          const merged = mergePhotoQuality(photoQuality, dq, { extraPrefix: 'pixel_' });
          photoQuality.grade = merged.grade;
          photoQuality.reasons = merged.reasons;
        }
      } else if (diag && !diag.ok) {
        const reason = String(diag.reason || 'diagnosis_failed');
        const merged = mergePhotoQuality(photoQuality, { grade: 'fail', reasons: [reason] }, { extraPrefix: 'pixel_' });
        photoQuality.grade = merged.grade;
        photoQuality.reasons = merged.reasons;
      }
    } catch (err) {
      const reason = err && (err.code || err.message) ? String(err.code || err.message) : 'diagnosis_threw';
      const merged = mergePhotoQuality(photoQuality, { grade: 'fail', reasons: [reason] }, { extraPrefix: 'pixel_' });
      photoQuality.grade = merged.grade;
      photoQuality.reasons = merged.reasons;
    }
  }

  const policyDetectorConfidenceLevel = diagnosisPolicy ? diagnosisPolicy.detector_confidence_level : detectorConfidenceLevel;
  const policyUncertainty = diagnosisPolicy ? diagnosisPolicy.uncertainty : null;

  const visionDecision = shouldCallLlm({
    kind: 'vision',
    quality: photoQuality,
    hasPrimaryInput,
    userRequestedPhoto,
    detectorConfidenceLevel: policyDetectorConfidenceLevel,
    uncertainty: policyUncertainty,
    visionAvailable,
    reportAvailable,
    degradedMode: degradedModeFinal,
  });

  const reportDecision = shouldCallLlm({
    kind: 'report',
    quality: photoQuality,
    hasPrimaryInput,
    userRequestedPhoto,
    detectorConfidenceLevel: policyDetectorConfidenceLevel,
    uncertainty: policyUncertainty,
    visionAvailable,
    reportAvailable,
    degradedMode: degradedModeFinal,
  });

  let analysis = null;
  let analysisSource = 'baseline_low_confidence';
  let llmReason = null;
  let visionCalled = false;
  let visionOk = false;
  let reportCalled = false;
  let reportOk = false;
  let reportOutputChars = 0;

  if (userRequestedPhoto && photosProvided && photoQuality.grade === 'fail') {
    profiler.start('detector', { kind: 'retake' });
    analysis = {
      features: [
        {
          observation:
            lang === 'CN'
              ? '照片质量未通过：为避免误判，我不会调用模型做皮肤结论；请按提示重拍。'
              : 'Photo quality failed: skipping model calls to avoid wrong guesses; please retake.',
          confidence: 'pretty_sure',
        },
      ],
      strategy:
        lang === 'CN'
          ? '建议自然光、无遮挡、无美颜滤镜、对焦清晰重拍一张。你最近是否有刺痛/泛红？'
          : 'Retake in daylight with no filters and sharp focus. Any stinging/redness recently?',
      needs_risk_check: false,
    };
    analysisSource = 'retake';
    profiler.end('detector', { kind: 'retake' });
  }

  if (!analysis && visionDecision.decision === 'call') {
    visionCalled = true;
    try {
      const vision = await __internal.runOpenAIVisionSkinAnalysis({
        imageBuffer,
        language: lang,
        photoQuality,
        diagnosisPolicy,
        diagnosisV1,
        profileSummary,
        recentLogsSummary,
        profiler,
      });
      if (vision && vision.ok && vision.analysis) {
        analysis = vision.analysis;
        analysisSource = 'vision_openai';
        visionOk = true;
      } else if (vision && !vision.ok) {
        llmReason = vision.reason || null;
      }
    } catch (err) {
      llmReason = err && (err.code || err.message) ? String(err.code || err.message) : 'vision_threw';
    }
  }

  if (!analysis && reportDecision.decision === 'call' && reportAvailable) {
    reportCalled = true;
    try {
      const promptBase = buildSkinReportPrompt({
        language: lang,
        photoQuality,
        diagnosisPolicy,
        diagnosisV1,
        profileSummary,
        routineCandidate: primaryMode === 'routine' ? routineCandidate : null,
        recentLogsSummary,
      });

      let reportFailure = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt =
          attempt === 0
            ? promptBase
            : `${promptBase}\nSELF-CHECK before responding: output MUST be strict JSON only (no markdown/text), exactly the specified keys, and strategy must end with a single direct question.\n`;

        const upstream = await profiler.timeLlmCall({ provider: 'aurora', model: null, kind: 'skin_text' }, async () =>
          auroraChat({ baseUrl: String(process.env.AURORA_DECISION_BASE_URL || ''), query: prompt, timeoutMs: 12000 }),
        );
        const answer = upstream && typeof upstream.answer === 'string' ? upstream.answer : '';
        reportOutputChars = Math.max(reportOutputChars, answer.length);
        const jsonOnly = unwrapCodeFence(answer);
        const parsedObj = parseJsonOnlyObject(jsonOnly);
        const normalized = __internal.normalizeSkinAnalysisFromLLM(parsedObj, { language: lang });
        if (normalized) {
          analysis = normalized;
          analysisSource = 'aurora_text';
          reportOk = true;
          reportFailure = null;
          break;
        }
        reportFailure = 'report_output_invalid';
      }
      if (!analysis && reportFailure) llmReason = reportFailure;
    } catch (err) {
      llmReason = err && (err.code || err.message) ? String(err.code || err.message) : 'report_threw';
    }
  }

  if (!analysis && diagnosisV1) {
    analysis = profiler.timeSync(
      'postprocess',
      () => buildSkinAnalysisFromDiagnosisV1(diagnosisV1, { language: lang, profileSummary }),
      { kind: 'diagnosis_v1_template' },
    );
    if (analysis) analysisSource = 'diagnosis_v1_template';
  }

  if (!analysis) {
    profiler.start('detector', { kind: hasPrimaryInput ? 'rule_based' : 'baseline' });
    analysis = hasPrimaryInput
      ? __internal.buildRuleBasedSkinAnalysis({ profile: profileSummary, recentLogs: recentLogsSummary, language: lang })
      : __internal.buildLowConfidenceBaselineSkinAnalysis({ profile: profileSummary, language: lang });
    analysisSource = hasPrimaryInput ? 'rule_based' : 'baseline_low_confidence';
    profiler.end('detector', { kind: hasPrimaryInput ? 'rule_based' : 'baseline' });
  }

  const mustDowngrade =
    userRequestedPhoto && photosProvided && (photoQuality.grade === 'degraded' || photoQuality.grade === 'unknown') && analysisSource !== 'retake';
  if (analysis && mustDowngrade) analysis = downgradeSkinAnalysisConfidence(analysis, { language: lang });

  profiler.timeSync('render', () => null, { kind: 'bench_render' });

  const report = profiler.report();

  return {
    ok: Boolean(analysis),
    image: safeName(imagePath),
    qc_grade: photoQuality.grade,
    has_primary_input: hasPrimaryInput,
    detector_confidence: detectorConfidenceLevel,
    degraded_mode: degradedModeFinal,
    analysis_source: analysisSource,
    llm_reason: llmReason,
    llm_outcomes: {
      vision: { called: visionCalled, ok: visionOk },
      report: { called: reportCalled, ok: reportOk, output_chars: reportOutputChars || 0 },
    },
    llm_decisions: {
      vision: { ...visionDecision, reasons_human: humanizeLlmReasons(visionDecision.reasons, { language: lang }) },
      report: { ...reportDecision, reasons_human: humanizeLlmReasons(reportDecision.reasons, { language: lang }) },
    },
    report,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let images = (args.images || []).filter(Boolean);
  images = images.filter((p) => isImagePath(p) && fs.existsSync(p));
  if (!images.length) images = [await ensureDefaultImage()];

  const results = [];
  for (let r = 0; r < args.repeat; r += 1) {
    for (const img of images) {
      // eslint-disable-next-line no-await-in-loop
      const one = await runOne(img, {
        lang: args.lang,
        qc: args.qc,
        primary: args.primary,
        detector: args.detector,
        degradedMode: args.degradedMode,
      });
      results.push(one);
    }
  }

  const payload = {
    schema_version: 'aurora.bench.analyze.v1',
    generated_at: new Date().toISOString(),
    lang: args.lang,
    repeat: args.repeat,
    qc: args.qc,
    primary: args.primary,
    detector: args.detector,
    degraded_mode: args.degradedMode,
    images: images.map(safeName),
    results,
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
