#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  runGeminiVisionStrategy,
  runGeminiReportStrategy,
  runGeminiDeepeningStrategy,
} = require('../src/auroraBff/skinLlmGateway');
const {
  buildVisionSignalsDto,
  buildReportSignalsDto,
} = require('../src/auroraBff/skinSignalsDto');
const {
  __internal: {
    resolveQaMode,
    resolveQaSingleProvider,
    pickQaProvidersForMode,
    callDualQaProvider,
  },
} = require('../src/auroraBff/routes');

function parseArgs(argv) {
  const out = {
    cases: 'tests/fixtures/skin/skin_prompt_eval_cases.jsonl',
    rubric: 'tests/fixtures/skin/skin_prompt_judge_rubric.json',
    outDir: '',
    repeats: 5,
    promptVersion: 'skin_v3',
    deepeningPromptVersion: 'skin_deepening_v2_canonical',
    qaMode: process.env.AURORA_LLM_QA_MODE || 'dual',
    singleProvider: process.env.AURORA_LLM_SINGLE_PROVIDER || 'gemini',
    allowOpenAiFallback: process.env.AURORA_LLM_OPENAI_FALLBACK_ENABLED === 'true',
    timeoutMs: 30000,
    skipJudge: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--rubric' && next) {
      out.rubric = next;
      i += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
    } else if (token === '--repeats' && next) {
      out.repeats = Math.max(1, Math.min(10, Number(next) || 5));
      i += 1;
    } else if (token === '--prompt-version' && next) {
      out.promptVersion = next;
      i += 1;
    } else if (token === '--deepening-prompt-version' && next) {
      out.deepeningPromptVersion = next;
      i += 1;
    } else if (token === '--qa-mode' && next) {
      out.qaMode = next;
      i += 1;
    } else if (token === '--single-provider' && next) {
      out.singleProvider = next;
      i += 1;
    } else if (token === '--timeout-ms' && next) {
      out.timeoutMs = Math.max(5000, Number(next) || 30000);
      i += 1;
    } else if (token === '--skip-judge') {
      out.skipJudge = true;
    }
  }
  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL at ${filePath}:${idx + 1}: ${err.message}`);
      }
    });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, text ? `${text}\n` : '');
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map((item) => stableSort(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) out[key] = stableSort(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableSort(value));
}

function normalizeLocale(locale) {
  const token = String(locale || '').trim().toLowerCase();
  if (token === 'zh' || token === 'zh-cn' || token === 'cn') return 'zh-CN';
  return 'en-US';
}

function decodeInlineBase64(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }
  return {
    mimeType: 'image/png',
    buffer: Buffer.from(value, 'base64'),
  };
}

function loadImageInput(rootDir, input) {
  const node = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (node.image_path) {
    const filePath = resolvePath(rootDir, node.image_path);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = node.mime_type || (ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
    return {
      buffer: fs.readFileSync(filePath),
      mimeType,
      source: filePath,
    };
  }
  if (node.inline_image_base64) {
    const decoded = decodeInlineBase64(node.inline_image_base64);
    if (!decoded || !Buffer.isBuffer(decoded.buffer) || !decoded.buffer.length) return null;
    return {
      buffer: decoded.buffer,
      mimeType: decoded.mimeType,
      source: 'inline_base64',
    };
  }
  return null;
}

function pickRepeatCount(row, defaultRepeats) {
  const count = Number(row && row.repeats);
  if (!Number.isFinite(count) || count <= 0) return defaultRepeats;
  return Math.max(1, Math.min(10, Math.trunc(count)));
}

function buildDefaultVisionDto({ locale, input, imageBuffer }) {
  const node = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return buildVisionSignalsDto({
    lang: locale,
    photoQuality: node.photo_quality || { grade: node.quality_grade || 'pass', reasons: Array.isArray(node.quality_reasons) ? node.quality_reasons : [] },
    qualityObject: node.quality_object,
    profileSummary: node.profile_summary || {},
    diagnosisPolicy: node.diagnosis_policy || null,
    factLayer: node.fact_layer || { features: [], needs_risk_check: false },
    imageBuffer,
  });
}

function buildDefaultReportDto({ locale, input }) {
  const node = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return buildReportSignalsDto({
    lang: locale,
    diagnosisV1: node.diagnosis_v1 || null,
    diagnosisPolicy: node.diagnosis_policy || null,
    profileSummary: node.profile_summary || {},
    routineCandidate: node.routine_candidate || null,
    photoQuality: node.photo_quality || { grade: node.quality_grade || 'pass', reasons: Array.isArray(node.quality_reasons) ? node.quality_reasons : [] },
    qualityObject: node.quality_object,
    factLayer: node.fact_layer || { features: [], needs_risk_check: false, insufficient_visual_detail: false },
    imageBuffer: null,
  });
}

function buildDefaultDeepeningDto({ locale, input }) {
  const node = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    lang: locale,
    phase: node.phase || 'photo_optin',
    photo_choice: node.photo_choice || 'unknown',
    products_submitted: node.products_submitted === true,
    profile: node.profile || {},
    routine_actives: Array.isArray(node.routine_actives) ? node.routine_actives : [],
    reactions: Array.isArray(node.reactions) ? node.reactions : [],
    input_hash: sha1(stableStringify(node)).slice(0, 16),
  };
}

function getCanonicalSignature(stage, canonical, result) {
  if (!canonical || typeof canonical !== 'object') return `${stage}:failure:${result && result.reason ? result.reason : 'unknown'}`;
  if (stage === 'vision') {
    const obs = Array.isArray(canonical.observations)
      ? canonical.observations.map((row) => `${row.cue}:${row.region}:${row.severity}`).sort()
      : [];
    return stableStringify({
      visibility_status: canonical.visibility_status,
      insufficient_reason: canonical.insufficient_reason || null,
      observations: obs,
    });
  }
  if (stage === 'report') {
    const steps = Array.isArray(canonical.routine_steps)
      ? canonical.routine_steps.map((row) => `${row.time}:${row.step_type}:${row.target}:${row.cadence}`).sort()
      : [];
    return stableStringify({
      priority: canonical.summary_focus && canonical.summary_focus.priority,
      insights: Array.isArray(canonical.insights)
        ? canonical.insights.map((row) => `${row.cue}:${row.region}:${row.severity}`).sort()
        : [],
      routine_steps: steps,
      follow_up: canonical.follow_up && canonical.follow_up.intent,
    });
  }
  return stableStringify({
    phase: canonical.phase,
    summary_priority: canonical.summary_priority,
    advice_items: Array.isArray(canonical.advice_items) ? canonical.advice_items.slice().sort() : [],
    question_intent: canonical.question_intent,
  });
}

function compareArraySubset(actual, expected) {
  const actualSet = new Set((Array.isArray(actual) ? actual : []).map((item) => String(item || '').trim()).filter(Boolean));
  const missing = (Array.isArray(expected) ? expected : []).map((item) => String(item || '').trim()).filter(Boolean).filter((item) => !actualSet.has(item));
  return { ok: missing.length === 0, missing };
}

function evaluateLocalExpectations({ stage, expectations, result }) {
  const node = expectations && typeof expectations === 'object' && !Array.isArray(expectations) ? expectations : {};
  const canonical = result && result.canonical && typeof result.canonical === 'object' ? result.canonical : {};
  const checks = [];
  if (!result || result.ok !== true) {
    checks.push({ check: 'model_ok', ok: false, detail: result && result.reason ? result.reason : 'model_failed' });
    return checks;
  }
  checks.push({ check: 'model_ok', ok: true, detail: 'ok' });
  if (stage === 'vision') {
    if (node.expected_visibility_status) {
      checks.push({
        check: 'expected_visibility_status',
        ok: String(canonical.visibility_status || '') === String(node.expected_visibility_status || ''),
        detail: canonical.visibility_status || null,
      });
    }
    if (node.expected_cues) {
      const actual = Array.isArray(canonical.observations) ? canonical.observations.map((row) => row.cue) : [];
      const compared = compareArraySubset(actual, node.expected_cues);
      checks.push({ check: 'expected_cues', ok: compared.ok, detail: compared.missing });
    }
    if (node.forbidden_cues) {
      const actual = new Set(Array.isArray(canonical.observations) ? canonical.observations.map((row) => row.cue) : []);
      const matched = (Array.isArray(node.forbidden_cues) ? node.forbidden_cues : []).filter((item) => actual.has(String(item || '').trim()));
      checks.push({ check: 'forbidden_cues', ok: matched.length === 0, detail: matched });
    }
  } else if (stage === 'report') {
    if (node.expected_priority) {
      checks.push({
        check: 'expected_priority',
        ok: String(canonical.summary_focus && canonical.summary_focus.priority || '') === String(node.expected_priority || ''),
        detail: canonical.summary_focus && canonical.summary_focus.priority || null,
      });
    }
    if (node.expected_cues) {
      const actual = Array.isArray(canonical.insights) ? canonical.insights.map((row) => row.cue) : [];
      const compared = compareArraySubset(actual, node.expected_cues);
      checks.push({ check: 'expected_cues', ok: compared.ok, detail: compared.missing });
    }
  } else if (stage === 'deepening') {
    if (node.expected_phase) {
      checks.push({
        check: 'expected_phase',
        ok: String(canonical.phase || '') === String(node.expected_phase || ''),
        detail: canonical.phase || null,
      });
    }
    if (node.expected_question_intent) {
      checks.push({
        check: 'expected_question_intent',
        ok: String(canonical.question_intent || '') === String(node.expected_question_intent || ''),
        detail: canonical.question_intent || null,
      });
    }
  }
  return checks;
}

function buildJudgeSystemPrompt() {
  return 'You are a strict prompt-output auditor for skincare AI. Output JSON only.';
}

function buildJudgeUserPrompt({ rubric, row, result, localChecks }) {
  return [
    'Task: score the quality of this skincare model output.',
    'Return strict JSON with keys:',
    '- score: number from 0 to 10',
    '- hard_fail: boolean',
    '- hard_fail_reasons: string[]',
    '- strengths: string[]',
    '- weaknesses: string[]',
    '',
    'Scoring rubric JSON:',
    JSON.stringify(rubric, null, 2),
    '',
    'Case JSON:',
    JSON.stringify({
      case_id: row.case_id,
      stage: row.stage,
      locale: row.locale,
      expectations: row.expectations || {},
      judge_notes: row.judge_notes || '',
      local_checks: localChecks,
    }, null, 2),
    '',
    'Actual output JSON:',
    JSON.stringify({
      ok: result.ok === true,
      reason: result.reason || null,
      canonical_output: result.canonical || null,
      rendered_output: result.public_output || null,
      raw_model_output: result.raw_response_text || null,
    }, null, 2),
    '',
    'Hard-fail rules:',
    '- hard_fail=true if there is medical overreach, fabricated unsupported observations, clear contradiction to the case expectations, pass-quality image wrongly treated as insufficient, or locale rendering distortion.',
    '- For outright call failure, hard_fail=true and score must be <= 2.',
  ].join('\n');
}

function normalizeJudgeResult(result, provider) {
  const json = result && result.ok && result.json && typeof result.json === 'object' ? result.json : null;
  if (!json) {
    return {
      provider,
      ok: false,
      score: 0,
      hard_fail: true,
      hard_fail_reasons: ['judge_failed'],
      strengths: [],
      weaknesses: ['judge_failed'],
    };
  }
  return {
    provider,
    ok: true,
    score: Math.max(0, Math.min(10, Number(json.score) || 0)),
    hard_fail: json.hard_fail === true,
    hard_fail_reasons: Array.isArray(json.hard_fail_reasons) ? json.hard_fail_reasons.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6) : [],
    strengths: Array.isArray(json.strengths) ? json.strengths.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4) : [],
    weaknesses: Array.isArray(json.weaknesses) ? json.weaknesses.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4) : [],
  };
}

async function runJudge({ rubric, row, result, providers }) {
  const systemPrompt = buildJudgeSystemPrompt();
  const localChecks = evaluateLocalExpectations({ stage: row.stage, expectations: row.expectations, result });
  const userPrompt = buildJudgeUserPrompt({ rubric, row, result, localChecks });
  const judgeResults = [];
  for (const provider of providers.slice(0, 2)) {
    const raw = await callDualQaProvider({
      provider,
      systemPrompt,
      userPrompt,
      timeoutMs: 30000,
    });
    judgeResults.push(normalizeJudgeResult(raw, provider));
  }
  if (!judgeResults.length) {
    judgeResults.push({
      provider: 'none',
      ok: false,
      score: 0,
      hard_fail: true,
      hard_fail_reasons: ['no_judge_provider'],
      strengths: [],
      weaknesses: ['no_judge_provider'],
    });
  }
  const primary = judgeResults[0];
  const secondary = judgeResults[1] || primary;
  const averageScore = Number(((primary.score + secondary.score) / 2).toFixed(2));
  return {
    local_checks: localChecks,
    providers: judgeResults.map((item) => item.provider),
    primary,
    secondary,
    average_score: averageScore,
    judge_disagreement: Math.abs(primary.score - secondary.score) > 1.0,
    hard_fail: primary.hard_fail || secondary.hard_fail,
    hard_fail_reasons: Array.from(new Set([...(primary.hard_fail_reasons || []), ...(secondary.hard_fail_reasons || [])])).slice(0, 8),
  };
}

async function executeCase({ rootDir, row, repeatIndex, args }) {
  const locale = normalizeLocale(row.locale);
  const stage = String(row.stage || '').trim().toLowerCase();
  const input = row.input && typeof row.input === 'object' && !Array.isArray(row.input) ? row.input : {};
  if (stage === 'vision') {
    const image = loadImageInput(rootDir, input);
    if (!image) {
      return {
        ok: false,
        reason: 'MISSING_IMAGE_INPUT',
        public_output: null,
        canonical: null,
        raw_response_text: null,
        repeat_index: repeatIndex,
      };
    }
    const visionDto = input.vision_dto || buildDefaultVisionDto({ locale, input, imageBuffer: image.buffer });
    const result = await runGeminiVisionStrategy({
      imageBuffer: image.buffer,
      imageMimeType: image.mimeType,
      visionDto,
      language: locale,
      promptVersion: row.prompt_version || args.promptVersion,
      timeoutMs: args.timeoutMs,
    });
    return {
      ...result,
      public_output: result.analysis || null,
      input_summary: {
        image_source: image.source,
        quality_grade: visionDto && visionDto.quality ? visionDto.quality.grade : null,
        input_hash: visionDto && visionDto.input_hash ? visionDto.input_hash : null,
      },
      repeat_index: repeatIndex,
    };
  }
  if (stage === 'report') {
    const reportDto = input.report_dto || buildDefaultReportDto({ locale, input });
    const result = await runGeminiReportStrategy({
      reportDto,
      language: locale,
      promptVersion: row.prompt_version || args.promptVersion,
      timeoutMs: args.timeoutMs,
    });
    return {
      ...result,
      public_output: result.layer || null,
      input_summary: {
        quality_grade: reportDto && reportDto.quality ? reportDto.quality.grade : null,
        input_hash: reportDto && reportDto.input_hash ? reportDto.input_hash : null,
      },
      repeat_index: repeatIndex,
    };
  }
  if (stage === 'deepening') {
    const deepeningDto = input.deepening_dto || buildDefaultDeepeningDto({ locale, input });
    const result = await runGeminiDeepeningStrategy({
      deepeningDto,
      language: locale,
      promptVersion: row.prompt_version || args.deepeningPromptVersion,
      timeoutMs: args.timeoutMs,
    });
    return {
      ...result,
      public_output: result.layer || null,
      input_summary: {
        phase: deepeningDto.phase || null,
        input_hash: deepeningDto.input_hash || null,
      },
      repeat_index: repeatIndex,
    };
  }
  return {
    ok: false,
    reason: 'UNSUPPORTED_STAGE',
    public_output: null,
    canonical: null,
    raw_response_text: null,
    repeat_index: repeatIndex,
  };
}

function summarizeBuckets(rawRows, judgedRows, { skipJudge = false } = {}) {
  const bucketMap = new Map();
  for (const row of rawRows) {
    const key = `${row.stage}::${row.locale}`;
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        stage: row.stage,
        locale: row.locale,
        count: 0,
        success_count: 0,
        scores: [],
        hard_fail_count: 0,
        below8_count: 0,
        consistency_scores: [],
      });
    }
    const bucket = bucketMap.get(key);
    bucket.count += 1;
    if (row.ok === true) bucket.success_count += 1;
  }

  for (const row of judgedRows) {
    const key = `${row.stage}::${row.locale}`;
    const bucket = bucketMap.get(key);
    if (!bucket) continue;
    bucket.scores.push(Number(row.judge_average_score) || 0);
    if (row.judge_hard_fail === true) bucket.hard_fail_count += 1;
    if ((Number(row.judge_average_score) || 0) < 8) bucket.below8_count += 1;
  }

  const repeatGroups = new Map();
  for (const row of rawRows) {
    const groupKey = `${row.stage}::${row.locale}::${row.case_id}`;
    if (!repeatGroups.has(groupKey)) repeatGroups.set(groupKey, []);
    repeatGroups.get(groupKey).push(row.signature);
  }
  for (const [groupKey, signatures] of repeatGroups.entries()) {
    const [stage, locale] = groupKey.split('::');
    const key = `${stage}::${locale}`;
    const bucket = bucketMap.get(key);
    if (!bucket || !signatures.length) continue;
    const freq = new Map();
    for (const signature of signatures) freq.set(signature, (freq.get(signature) || 0) + 1);
    const best = Math.max(...Array.from(freq.values()));
    bucket.consistency_scores.push(best / signatures.length);
  }

  return Array.from(bucketMap.values()).map((bucket) => {
    const avgScore = bucket.scores.length
      ? Number((bucket.scores.reduce((sum, value) => sum + value, 0) / bucket.scores.length).toFixed(2))
      : 0;
    const hardFailRate = bucket.scores.length ? Number((bucket.hard_fail_count / bucket.scores.length).toFixed(4)) : 1;
    const below8Rate = bucket.scores.length ? Number((bucket.below8_count / bucket.scores.length).toFixed(4)) : 1;
    const consistency = bucket.consistency_scores.length
      ? Number((bucket.consistency_scores.reduce((sum, value) => sum + value, 0) / bucket.consistency_scores.length).toFixed(4))
      : 0;
    const pass = skipJudge
      ? bucket.count > 0 && bucket.success_count === bucket.count
      : avgScore >= 9.0 &&
        hardFailRate === 0 &&
        below8Rate <= 0.05 &&
        consistency >= 0.8;
    return {
      stage: bucket.stage,
      locale: bucket.locale,
      count: bucket.count,
      success_rate: bucket.count ? Number((bucket.success_count / bucket.count).toFixed(4)) : 0,
      avg_score: avgScore,
      hard_fail_rate: hardFailRate,
      below8_rate: below8Rate,
      repeat_consistency: consistency,
      pass,
    };
  });
}

function buildMarkdownReport({ args, summary, rawRows, judgedRows }) {
  const lines = [];
  lines.push('# Skin Prompt Quality Gate');
  lines.push('');
  lines.push(`- Cases: ${rawRows.length}`);
  lines.push(`- Judged rows: ${judgedRows.length}`);
  lines.push(`- Prompt version: ${args.promptVersion}`);
  lines.push(`- Deepening prompt version: ${args.deepeningPromptVersion}`);
  lines.push(`- Judge mode: ${args.skipJudge ? 'skipped' : args.qaMode}`);
  lines.push('');
  lines.push('## Bucket Summary');
  lines.push('');
  for (const row of summary) {
    lines.push(`- ${row.stage} / ${row.locale}: pass=${row.pass} success_rate=${row.success_rate} avg_score=${row.avg_score} hard_fail_rate=${row.hard_fail_rate} below8_rate=${row.below8_rate} repeat_consistency=${row.repeat_consistency}`);
  }
  const failures = judgedRows.filter((row) => row.judge_hard_fail === true || Number(row.judge_average_score) < 9);
  if (failures.length) {
    lines.push('');
    lines.push('## Rows Needing Review');
    lines.push('');
    for (const row of failures.slice(0, 20)) {
      lines.push(`- ${row.case_id} / ${row.stage} / ${row.locale} / repeat=${row.repeat_index}: score=${row.judge_average_score} hard_fail=${row.judge_hard_fail} reasons=${(row.judge_hard_fail_reasons || []).join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const casesPath = resolvePath(rootDir, args.cases);
  const rubricPath = resolvePath(rootDir, args.rubric);
  const cases = readJsonl(casesPath);
  const rubric = readJson(rubricPath);
  const providers = args.skipJudge
    ? []
    : pickQaProvidersForMode({
        mode: resolveQaMode(args.qaMode),
        singleProvider: resolveQaSingleProvider(args.singleProvider),
        allowOpenAiFallback: args.allowOpenAiFallback,
      });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.outDir ? resolvePath(rootDir, args.outDir) : path.join(rootDir, 'reports', 'skin-prompt-quality', timestamp);
  ensureDir(outDir);

  const rawRows = [];
  const judgedRows = [];

  for (const row of cases) {
    const repeats = pickRepeatCount(row, args.repeats);
    for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
      const result = await executeCase({ rootDir, row, repeatIndex, args });
      const signature = getCanonicalSignature(row.stage, result.canonical, result);
      const rawRecord = {
        case_id: row.case_id,
        stage: row.stage,
        locale: normalizeLocale(row.locale),
        repeat_index: repeatIndex,
        prompt_version: row.prompt_version || (row.stage === 'deepening' ? args.deepeningPromptVersion : args.promptVersion),
        ok: result.ok === true,
        reason: result.reason || null,
        input_summary: result.input_summary || null,
        canonical_output: result.canonical || null,
        rendered_output: result.public_output || null,
        raw_model_output: result.raw_response_text || null,
        signature,
      };
      rawRows.push(rawRecord);

      if (!args.skipJudge) {
        const judge = await runJudge({ rubric, row, result, providers });
        judgedRows.push({
          case_id: row.case_id,
          stage: row.stage,
          locale: normalizeLocale(row.locale),
          repeat_index: repeatIndex,
          prompt_version: rawRecord.prompt_version,
          judge_providers: judge.providers,
          judge_average_score: judge.average_score,
          judge_hard_fail: judge.hard_fail,
          judge_hard_fail_reasons: judge.hard_fail_reasons,
          judge_disagreement: judge.judge_disagreement,
          local_checks: judge.local_checks,
          primary_judge: judge.primary,
          secondary_judge: judge.secondary,
        });
      }
    }
  }

  const summary = summarizeBuckets(rawRows, judgedRows, { skipJudge: args.skipJudge });
  writeJsonl(path.join(outDir, 'raw_outputs.jsonl'), rawRows);
  writeJsonl(path.join(outDir, 'judge_scores.jsonl'), judgedRows);
  writeJson(path.join(outDir, 'summary.json'), {
    generated_at: new Date().toISOString(),
    args,
    summary,
  });
  fs.writeFileSync(path.join(outDir, 'report.md'), buildMarkdownReport({ args, summary, rawRows, judgedRows }));

  const failedBuckets = summary.filter((row) => !row.pass);
  const verdict = failedBuckets.length ? 'FAIL' : 'PASS';
  process.stdout.write(`${verdict} ${outDir}\n`);
  if (failedBuckets.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message || String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildJudgeUserPrompt,
  evaluateLocalExpectations,
  summarizeBuckets,
};
