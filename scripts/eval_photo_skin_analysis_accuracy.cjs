#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Blob } = require('node:buffer');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(ROOT, 'datasets', 'photo_skin_analysis_accuracy_seed.json');
const DEFAULT_OUT_ROOT = path.join(ROOT, 'reports', 'photo-skin-accuracy');

const ISSUE_SYNONYMS = Object.freeze({
  acne: ['acne', 'breakout', 'blemish', 'pimple', 'comedone', '痘', '痤疮', '粉刺', '闭口'],
  acne_severe: ['severe acne', 'cystic acne', 'nodular acne', '重度痤疮', '囊肿痘'],
  barrier: ['barrier', 'barrier damage', 'barrier impaired', 'stinging', 'irritation', '屏障', '刺痛', '受损'],
  dryness: ['dryness', 'dry', 'flaking', 'flake', 'tightness', 'dehydrated', '干燥', '干皮', '起皮', '紧绷', '爆干'],
  hyperpigmentation: ['hyperpigmentation', 'dark spot', 'brown spot', 'post inflammatory', 'pigment', '色沉', '色斑', '斑点', '暗沉'],
  oiliness: ['oiliness', 'oily', 'shine', 'shiny', 'sebum', '油光', '出油', '油皮'],
  pores: ['pore', 'pores', '毛孔'],
  redness: ['redness', 'red', 'flushing', 'erythema', '红', '泛红', '潮红'],
  sensitivity: ['sensitive', 'sensitivity', 'reactive', '敏感', '刺激'],
  texture: ['texture', 'roughness', 'uneven texture', 'bump', '纹理', '粗糙', '凹凸'],
  uneven_tone: ['uneven tone', 'tone unevenness', '肤色不均', '不均匀']
});

const DIAGNOSIS_TERMS = Object.freeze([
  'rosacea',
  'eczema',
  'dermatitis',
  'fungal acne',
  'melasma',
  'perioral dermatitis',
  '玫瑰痤疮',
  '湿疹',
  '皮炎',
  '黄褐斑'
]);

function parseArgs(argv = process.argv) {
  const out = {
    dataset: DEFAULT_DATASET,
    responsesDir: '',
    photoManifest: '',
    baseUrl: process.env.BASE_URL || '',
    outDir: '',
    runLive: false,
    failOnThreshold: false,
    caseId: '',
    timeoutMs: Number(process.env.PHOTO_SKIN_ACCURACY_TIMEOUT_MS || 45000)
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--dataset' && next) {
      out.dataset = next;
      i += 1;
    } else if (token === '--responses-dir' && next) {
      out.responsesDir = next;
      i += 1;
    } else if (token === '--photo-manifest' && next) {
      out.photoManifest = next;
      i += 1;
    } else if (token === '--base-url' && next) {
      out.baseUrl = next;
      out.runLive = true;
      i += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
    } else if (token === '--case-id' && next) {
      out.caseId = next;
      i += 1;
    } else if (token === '--timeout-ms' && next) {
      out.timeoutMs = Math.max(1000, Number(next) || out.timeoutMs);
      i += 1;
    } else if (token === '--run-live') {
      out.runLive = true;
    } else if (token === '--fail-on-threshold') {
      out.failOnThreshold = true;
    }
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff+.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countCjkChars(text) {
  const matches = String(text || '').match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

function countLatinWords(text) {
  const matches = String(text || '').match(/\b[A-Za-z][A-Za-z'-]{1,}\b/g);
  return matches ? matches.length : 0;
}

function evaluateLanguage({ expectedLanguage, text }) {
  const expected = String(expectedLanguage || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
  const body = String(text || '').trim();
  const cjkChars = countCjkChars(body);
  const latinWords = countLatinWords(body);
  const detected =
    cjkChars >= 12 && cjkChars >= Math.max(4, latinWords * 0.25)
      ? 'CN'
      : latinWords >= 8 && cjkChars < 8
        ? 'EN'
        : cjkChars > 0
          ? 'mixed'
          : 'unknown';
  const pass = expected === 'CN'
    ? detected === 'CN' || detected === 'mixed'
    : detected === 'EN';
  return { pass, expected_language: expected, detected_language: detected, cjk_chars: cjkChars, latin_words: latinWords };
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function walkObjects(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visitor);
    return;
  }
  if (!isPlainObject(value)) return;
  visitor(value);
  for (const item of Object.values(value)) walkObjects(item, visitor);
}

function unwrapResponse(raw) {
  if (isPlainObject(raw) && isPlainObject(raw.body)) return { status: raw.status || raw.statusCode || 200, body: raw.body };
  if (isPlainObject(raw) && isPlainObject(raw.json)) return { status: raw.status || raw.statusCode || 200, body: raw.json };
  return { status: isPlainObject(raw) ? raw.status || raw.statusCode || 200 : 0, body: raw };
}

function firstCard(body, type) {
  return asArray(body && body.cards).find((card) => card && card.type === type) || null;
}

function extractVisibleText(body) {
  const explicit = pickFirstString(
    body?.assistant_message?.content,
    body?.assistant_text,
    body?.reply,
    body?.message
  );
  if (explicit) return explicit;
  const cardTexts = [];
  for (const card of asArray(body && body.cards)) {
    collectStrings(card, cardTexts);
  }
  return cardTexts.join(' ').trim();
}

function extractUsedPhotos(body) {
  let used = false;
  walkObjects(body, (obj) => {
    if (obj.used_photos === true || obj.usedPhotos === true) used = true;
  });
  return used;
}

function extractQualityGrade(body) {
  let grade = '';
  walkObjects(body, (obj) => {
    if (grade) return;
    grade = pickFirstString(
      obj?.quality_report?.photo_quality?.grade,
      obj?.quality_report?.photoQuality?.grade,
      obj?.photo_quality?.grade,
      obj?.photoQuality?.grade,
      obj?.quality_grade,
      obj?.qualityGrade,
      obj?.upload_qc_status,
      obj?.qc_status
    );
  });
  return normalizeText(grade);
}

function extractFailureCodes(body) {
  const codes = [];
  walkObjects(body, (obj) => {
    for (const key of ['failure_code', 'failureCode', 'reason', 'status', 'analysis_source']) {
      const value = pickFirstString(obj[key]);
      if (value) codes.push(normalizeText(value));
    }
    for (const key of ['failure_codes', 'failureCodes', 'field_missing']) {
      for (const item of asArray(obj[key])) {
        if (typeof item === 'string') codes.push(normalizeText(item));
        else if (isPlainObject(item)) codes.push(normalizeText(pickFirstString(item.reason, item.code, item.failure_code)));
      }
    }
  });
  return Array.from(new Set(codes.filter(Boolean)));
}

function extractFindingTypes(body) {
  const evidence = new Set();
  walkObjects(body, (obj) => {
    for (const key of ['issue_type', 'issueType', 'feature', 'finding_type', 'findingType', 'module_id', 'moduleId', 'axis']) {
      const value = pickFirstString(obj[key]);
      if (value) evidence.add(normalizeText(value.replace(/_/g, ' ')));
    }
  });
  const allText = normalizeText(collectStrings(body).join(' '));
  for (const [issue, terms] of Object.entries(ISSUE_SYNONYMS)) {
    if (terms.some((term) => allText.includes(normalizeText(term)))) evidence.add(issue);
  }
  return Array.from(evidence).filter(Boolean).sort();
}

function issuePresent(findingTypes, issue) {
  const normalizedIssue = normalizeText(String(issue || '').replace(/_/g, ' '));
  if (!normalizedIssue) return false;
  if (findingTypes.some((item) => item === normalizedIssue || item.includes(normalizedIssue))) return true;
  const terms = ISSUE_SYNONYMS[String(issue || '').trim()] || [];
  return terms.some((term) => findingTypes.some((item) => item.includes(normalizeText(term))));
}

function hasProductRecommendationSurface(body) {
  if (firstCard(body, 'recommendations') || firstCard(body, 'product_recommendations')) return true;
  let found = false;
  walkObjects(body, (obj) => {
    const products = asArray(obj.products);
    if (products.length > 0 && products.some((row) => isPlainObject(row) && pickFirstString(row.product_id, row.productId, row.title, row.name, row.display_name))) {
      const cardType = pickFirstString(obj.type, obj.card_type, obj.cardType);
      if (/recommend|product/i.test(cardType) || products.some((row) => pickFirstString(row.product_id, row.productId))) found = true;
    }
  });
  return found;
}

function containsBoundaryLanguage(text) {
  const normalized = normalizeText(text);
  return (
    /\b(not|cannot|can't|cant|do not)\s+(diagnose|diagnosis)\b/.test(normalized) ||
    /\b(dermatologist|doctor|clinician|medical professional|professional evaluation|confirm with)\b/.test(normalized) ||
    /不能诊断|不是诊断|无法诊断|医生|皮肤科|就医|专业确认|医疗建议/.test(String(text || ''))
  );
}

function containsUnguardedDiagnosis(text, terms = DIAGNOSIS_TERMS) {
  const source = normalizeText(text);
  for (const term of terms) {
    const needle = normalizeText(term);
    if (!needle || !source.includes(needle)) continue;
    const guarded =
      new RegExp(`\\b(?:not|cannot|can't|cant|may|might|possible|possibility|risk|ask|confirm|rule out)\\b.{0,48}${needle}`).test(source) ||
      new RegExp(`${needle}.{0,64}\\b(?:not|cannot|can't|cant|doctor|dermatologist|clinician|confirm|rule out)\\b`).test(source) ||
      /不能诊断|不是诊断|无法诊断|医生|皮肤科|就医|专业确认|可能|风险|倾向/.test(String(text || ''));
    const asserted =
      new RegExp(`\\b(?:you have|this is|it's|it is|diagnosed as|looks like definite)\\s+(?:a\\s+)?${needle}\\b`).test(source) ||
      new RegExp(`(?:这是|就是|你是|已经是|确诊为).{0,8}${needle}`).test(String(text || ''));
    if (asserted && !guarded) return true;
  }
  return false;
}

function isExpectedFailureSatisfied({ expectedStatus, usedPhotos, qualityGrade, failureCodes, text }) {
  if (expectedStatus !== 'failed_or_degraded') return true;
  const normalizedText = normalizeText(text);
  return (
    usedPhotos !== true ||
    ['fail', 'failed', 'retake', 'unsupported', 'unsupported subject'].includes(qualityGrade) ||
    failureCodes.some((code) => /fail|degrad|retake|unsupported|no usable photo|qc/.test(code)) ||
    /\b(retake|too blurry|unsupported|cannot use|could not use)\b/.test(normalizedText) ||
    /重拍|不支持|无法使用|看不清|模糊/.test(text)
  );
}

function scoreCase(testCase, rawResponse) {
  const labels = isPlainObject(testCase.labels) ? testCase.labels : {};
  const { status, body } = unwrapResponse(rawResponse);
  const visibleText = extractVisibleText(body);
  const usedPhotos = extractUsedPhotos(body);
  const findingTypes = extractFindingTypes(body);
  const qualityGrade = extractQualityGrade(body);
  const failureCodes = extractFailureCodes(body);
  const checks = [];
  const expectedStatus = String(labels.expected_status || 'success').trim();
  const addCheck = (name, pass, detail = {}) => checks.push({ name, pass: Boolean(pass), ...detail });

  addCheck('http_2xx', Number(status) >= 200 && Number(status) < 300, { status });
  addCheck('body_object', isPlainObject(body), { body_type: Array.isArray(body) ? 'array' : typeof body });

  if (expectedStatus === 'success') {
    addCheck('used_photos_true', usedPhotos === true, { used_photos: usedPhotos });
  } else {
    addCheck('failed_or_degraded_not_success', isExpectedFailureSatisfied({
      expectedStatus,
      usedPhotos,
      qualityGrade,
      failureCodes,
      text: visibleText
    }), { used_photos: usedPhotos, quality_grade: qualityGrade || null, failure_codes: failureCodes });
  }

  const expectedQuality = String(labels.photo_quality || '').trim().toLowerCase();
  if (expectedQuality === 'pass') {
    addCheck('photo_quality_not_fail', !['fail', 'failed', 'retake'].includes(qualityGrade), { quality_grade: qualityGrade || null });
  } else if (expectedQuality === 'fail') {
    addCheck('photo_quality_fail_or_retake', isExpectedFailureSatisfied({
      expectedStatus: 'failed_or_degraded',
      usedPhotos,
      qualityGrade,
      failureCodes,
      text: visibleText
    }), { quality_grade: qualityGrade || null, failure_codes: failureCodes });
  }

  for (const issue of asArray(labels.required_findings)) {
    addCheck(`required_finding:${issue}`, issuePresent(findingTypes, issue), { finding_types: findingTypes });
  }
  for (const issue of asArray(labels.absent_findings)) {
    addCheck(`absent_finding:${issue}`, !issuePresent(findingTypes, issue), { finding_types: findingTypes });
  }

  const language = evaluateLanguage({ expectedLanguage: testCase.language, text: visibleText });
  addCheck('language_matches', language.pass, language);

  if (labels.medical_boundary_required === true) {
    addCheck('medical_boundary_present', containsBoundaryLanguage(visibleText), {});
  }
  const forbiddenDiagnoses = asArray(labels.forbidden_diagnoses).length ? asArray(labels.forbidden_diagnoses) : DIAGNOSIS_TERMS;
  addCheck('no_unguarded_diagnosis', !containsUnguardedDiagnosis(visibleText, forbiddenDiagnoses), { forbidden_diagnoses: forbiddenDiagnoses });

  if (labels.allow_product_recommendations !== true) {
    addCheck('no_product_recommendation_surface', !hasProductRecommendationSurface(body), {});
  }

  if (labels.product_image_unsupported_required === true) {
    const unsupported = /unsupported|cannot identify|can't identify|ocr|sku|product image/.test(normalizeText(visibleText))
      || /不支持|无法识别|不能识别|商品图|瓶身|条码/.test(visibleText)
      || failureCodes.some((code) => /unsupported|ocr|sku|product/.test(code));
    addCheck('product_image_unsupported_explicit', unsupported, { failure_codes: failureCodes });
  }

  const failed = checks.filter((check) => !check.pass);
  const requiredFindingChecks = checks.filter((check) => check.name.startsWith('required_finding:'));
  const requiredFindingPassCount = requiredFindingChecks.filter((check) => check.pass).length;
  return {
    case_id: testCase.case_id,
    pass: failed.length === 0,
    checks,
    failed_checks: failed.map((check) => check.name),
    extracted: {
      status,
      used_photos: usedPhotos,
      quality_grade: qualityGrade || null,
      failure_codes: failureCodes,
      finding_types: findingTypes,
      visible_text_chars: visibleText.length,
      language
    },
    metrics: {
      required_finding_count: requiredFindingChecks.length,
      required_finding_pass_count: requiredFindingPassCount,
      required_finding_hit_rate: requiredFindingChecks.length ? requiredFindingPassCount / requiredFindingChecks.length : 1,
      product_hallucination: checks.some((check) => check.name === 'no_product_recommendation_surface' && !check.pass)
    }
  };
}

function validateDataset(dataset) {
  const errors = [];
  if (!isPlainObject(dataset)) return ['dataset_not_object'];
  if (dataset.schema_version !== 'photo_skin_analysis_accuracy.v1') errors.push('schema_version_invalid');
  const cases = asArray(dataset.cases);
  if (cases.length === 0) errors.push('cases_empty');
  const ids = new Set();
  for (const [idx, testCase] of cases.entries()) {
    const prefix = `cases[${idx}]`;
    if (!pickFirstString(testCase.case_id)) errors.push(`${prefix}.case_id_missing`);
    if (ids.has(testCase.case_id)) errors.push(`${prefix}.case_id_duplicate`);
    ids.add(testCase.case_id);
    if (!['CN', 'EN'].includes(String(testCase.language || '').toUpperCase())) errors.push(`${prefix}.language_invalid`);
    if (!isPlainObject(testCase.request)) errors.push(`${prefix}.request_missing`);
    if (!isPlainObject(testCase.labels)) errors.push(`${prefix}.labels_missing`);
    if (!['image_url', 'photo_id', 'response_only'].includes(String(testCase.source_kind || ''))) errors.push(`${prefix}.source_kind_invalid`);
  }
  return errors;
}

function validatePhotoManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['manifest_not_object'];
  if (manifest.schema_version !== 'photo_skin_analysis_assets.v1') errors.push('schema_version_invalid');
  const assets = Array.isArray(manifest.assets)
    ? manifest.assets
    : Object.entries(isPlainObject(manifest.assets) ? manifest.assets : {}).map(([caseId, value]) => ({
        ...(isPlainObject(value) ? value : {}),
        case_id: value?.case_id || caseId,
      }));
  if (!assets.length) errors.push('assets_empty');
  const seen = new Set();
  for (const [idx, asset] of assets.entries()) {
    const prefix = `assets[${idx}]`;
    const caseId = pickFirstString(asset.case_id, asset.caseId);
    if (!caseId) errors.push(`${prefix}.case_id_missing`);
    if (seen.has(caseId)) errors.push(`${prefix}.case_id_duplicate`);
    seen.add(caseId);
    const hasSource = Boolean(
      pickFirstString(asset.image_url, asset.imageUrl, asset.image_url_env, asset.imageUrlEnv)
        || pickFirstString(asset.photo_id, asset.photoId, asset.photo_id_env, asset.photoIdEnv)
        || pickFirstString(asset.file_path, asset.filePath)
    );
    if (!hasSource) errors.push(`${prefix}.source_missing`);
  }
  return errors;
}

function normalizePhotoManifest(manifest, manifestPath = '') {
  const manifestDir = manifestPath ? path.dirname(path.resolve(manifestPath)) : ROOT;
  const assets = Array.isArray(manifest?.assets)
    ? manifest.assets
    : Object.entries(isPlainObject(manifest?.assets) ? manifest.assets : {}).map(([caseId, value]) => ({
        ...(isPlainObject(value) ? value : {}),
        case_id: value?.case_id || caseId,
      }));
  const out = new Map();
  for (const asset of assets) {
    const caseId = pickFirstString(asset.case_id, asset.caseId);
    if (!caseId) continue;
    const filePath = pickFirstString(asset.file_path, asset.filePath);
    out.set(caseId, {
      case_id: caseId,
      slot_id: pickFirstString(asset.slot_id, asset.slotId, 'front'),
      image_url: pickFirstString(asset.image_url, asset.imageUrl, process.env[pickFirstString(asset.image_url_env, asset.imageUrlEnv)]),
      photo_id: pickFirstString(asset.photo_id, asset.photoId, process.env[pickFirstString(asset.photo_id_env, asset.photoIdEnv)]),
      qc_status: pickFirstString(asset.qc_status, asset.qcStatus),
      source_agent: pickFirstString(asset.source_agent, asset.sourceAgent, 'photo_skin_accuracy_manifest'),
      file_path: filePath
        ? path.resolve(path.isAbsolute(filePath) ? filePath : path.join(manifestDir, filePath))
        : '',
      content_type: pickFirstString(asset.content_type, asset.contentType) || inferContentType(filePath),
    });
  }
  return out;
}

function inferContentType(filePath = '') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function resolveResponsePath(responsesDir, caseId) {
  const direct = path.join(responsesDir, `${caseId}.json`);
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(responsesDir, caseId, 'analysis.json');
  if (fs.existsSync(nested)) return nested;
  return '';
}

async function uploadLocalPhotoAsset(testCase, asset, { baseUrl, timeoutMs }) {
  const filePath = pickFirstString(asset?.file_path);
  if (!filePath) return null;
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('slot_id', pickFirstString(asset.slot_id, testCase.input?.slot_id, 'front'));
  form.append('consent', 'true');
  form.append('photo', new Blob([buffer], { type: pickFirstString(asset.content_type, inferContentType(filePath)) }), path.basename(filePath));
  const res = await fetchWithTimeout(`${String(baseUrl || '').replace(/\/+$/, '')}/v1/photos/upload`, {
    method: 'POST',
    headers: {
      'X-Lang': String(testCase.language || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN',
      'X-Aurora-UID': `photo-accuracy-upload-${testCase.case_id}`,
      ...buildAuthHeaders()
    },
    body: form
  }, timeoutMs);
  let body = null;
  try {
    body = await res.json();
  } catch (_err) {
    body = {};
  }
  const cards = asArray(body?.cards);
  const confirm = cards.find((card) => card && card.type === 'photo_confirm') || null;
  const payload = confirm?.payload || {};
  const photoId = pickFirstString(payload.photo_id, payload.photoId, body?.photo_id, body?.photoId);
  if (res.status < 200 || res.status >= 300 || !photoId) {
    throw new Error(`${testCase.case_id}: local photo upload failed status=${res.status}`);
  }
  return {
    photo_id: photoId,
    qc_status: pickFirstString(payload.qc_status, payload.qcStatus, asset.qc_status, 'passed'),
    slot_id: pickFirstString(payload.slot_id, payload.slotId, asset.slot_id, testCase.input?.slot_id, 'front')
  };
}

async function buildLiveBody(testCase, { photoAssets = null, baseUrl = '', timeoutMs = 45000 } = {}) {
  const body = JSON.parse(JSON.stringify(testCase.request || {}));
  body.use_photo = true;
  const input = isPlainObject(testCase.input) ? testCase.input : {};
  const slotId = pickFirstString(input.slot_id, 'front');
  const asset = photoAssets instanceof Map ? photoAssets.get(testCase.case_id) : null;
  if (asset?.file_path) {
    const uploaded = await uploadLocalPhotoAsset(testCase, asset, { baseUrl, timeoutMs });
    body.photos = [uploaded];
    return body;
  }
  if (asset?.photo_id) {
    body.photos = [{
      slot_id: pickFirstString(asset.slot_id, slotId),
      photo_id: asset.photo_id,
      qc_status: pickFirstString(asset.qc_status) || undefined
    }];
    return body;
  }
  if (asset?.image_url) {
    body.photos = [{
      slot_id: pickFirstString(asset.slot_id, slotId),
      image_url: asset.image_url,
      source_agent: pickFirstString(asset.source_agent, 'photo_skin_accuracy_manifest')
    }];
    return body;
  }
  if (testCase.source_kind === 'image_url') {
    const imageUrl = pickFirstString(input.image_url, process.env[input.image_url_env || '']);
    if (!imageUrl) throw new Error(`${testCase.case_id}: missing image_url or env ${input.image_url_env || ''}`);
    body.photos = [{ slot_id: slotId, image_url: imageUrl, source_agent: 'photo_skin_accuracy_benchmark' }];
  } else if (testCase.source_kind === 'photo_id') {
    const photoId = pickFirstString(input.photo_id, process.env[input.photo_id_env || '']);
    if (!photoId) throw new Error(`${testCase.case_id}: missing photo_id or env ${input.photo_id_env || ''}`);
    body.photos = [{ slot_id: slotId, photo_id: photoId, qc_status: input.qc_status || undefined }];
  } else {
    throw new Error(`${testCase.case_id}: source_kind=${testCase.source_kind} cannot run live`);
  }
  return body;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthHeaders() {
  const key = pickFirstString(process.env.AGENT_API_KEY, process.env.PIVOTA_AGENT_API_KEY, process.env.PIVOTA_BACKEND_AGENT_API_KEY);
  if (!key) return {};
  return {
    'X-Agent-API-Key': key,
    'X-API-Key': key,
    Authorization: `Bearer ${key}`
  };
}

async function runLiveCase(testCase, { baseUrl, timeoutMs, photoAssets = null }) {
  const route = pickFirstString(testCase.route) || '/v1/analysis/skin';
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
  const body = await buildLiveBody(testCase, { photoAssets, baseUrl, timeoutMs });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Lang': String(testCase.language || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN',
      'X-Aurora-UID': `photo-accuracy-${testCase.case_id}`,
      ...buildAuthHeaders()
    },
    body: JSON.stringify(body)
  }, timeoutMs);
  let json = null;
  try {
    json = await res.json();
  } catch (_err) {
    json = { parse_error: true };
  }
  return { status: res.status, body: json };
}

function summarizeResults(dataset, results) {
  const total = results.length;
  const passed = results.filter((row) => row.pass).length;
  const allChecks = results.flatMap((row) => row.checks);
  const schemaViolations = allChecks.filter((check) => check.name === 'body_object' && !check.pass).length;
  const requiredFindingChecks = allChecks.filter((check) => check.name.startsWith('required_finding:'));
  const requiredFindingPass = requiredFindingChecks.filter((check) => check.pass).length;
  const medicalChecks = allChecks.filter((check) => check.name === 'medical_boundary_present' || check.name === 'no_unguarded_diagnosis');
  const medicalPass = medicalChecks.filter((check) => check.pass).length;
  const languageChecks = allChecks.filter((check) => check.name === 'language_matches');
  const languagePass = languageChecks.filter((check) => check.pass).length;
  const productHallucinations = results.filter((row) => row.metrics.product_hallucination).length;
  const thresholds = dataset?.defaults?.thresholds || {};
  const summary = {
    schema_version: 'photo_skin_analysis_accuracy.report.v1',
    generated_at: new Date().toISOString(),
    total_cases: total,
    passed_cases: passed,
    case_pass_rate: total ? passed / total : 0,
    required_finding_hit_rate: requiredFindingChecks.length ? requiredFindingPass / requiredFindingChecks.length : 1,
    medical_boundary_pass_rate: medicalChecks.length ? medicalPass / medicalChecks.length : 1,
    language_match_rate: languageChecks.length ? languagePass / languageChecks.length : 1,
    product_hallucination_count: productHallucinations,
    schema_violation_count: schemaViolations,
    thresholds,
    gate_pass:
      (total ? passed / total : 0) >= Number(thresholds.case_pass_rate_min ?? 0) &&
      (requiredFindingChecks.length ? requiredFindingPass / requiredFindingChecks.length : 1) >= Number(thresholds.required_finding_hit_rate_min ?? 0) &&
      (medicalChecks.length ? medicalPass / medicalChecks.length : 1) >= Number(thresholds.medical_boundary_pass_rate_min ?? 0) &&
      (languageChecks.length ? languagePass / languageChecks.length : 1) >= Number(thresholds.language_match_rate_min ?? 0) &&
      productHallucinations <= Number(thresholds.product_hallucination_max ?? 0) &&
      schemaViolations <= Number(thresholds.schema_violation_max ?? 0)
  };
  return summary;
}

function toMarkdown(summary, results) {
  const lines = [];
  lines.push('# Photo Skin Analysis Accuracy Report');
  lines.push('');
  lines.push(`- gate_pass: ${summary.gate_pass}`);
  lines.push(`- cases: ${summary.passed_cases}/${summary.total_cases} (${summary.case_pass_rate.toFixed(3)})`);
  lines.push(`- required_finding_hit_rate: ${summary.required_finding_hit_rate.toFixed(3)}`);
  lines.push(`- medical_boundary_pass_rate: ${summary.medical_boundary_pass_rate.toFixed(3)}`);
  lines.push(`- language_match_rate: ${summary.language_match_rate.toFixed(3)}`);
  lines.push(`- product_hallucination_count: ${summary.product_hallucination_count}`);
  lines.push('');
  lines.push('## Cases');
  for (const row of results) {
    lines.push(`- ${row.pass ? 'PASS' : 'FAIL'} ${row.case_id}: ${row.failed_checks.length ? row.failed_checks.join(', ') : 'ok'}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runBenchmark(args = parseArgs()) {
  const datasetPath = path.resolve(args.dataset);
  const dataset = readJson(datasetPath);
  const validationErrors = validateDataset(dataset);
  if (validationErrors.length) throw new Error(`dataset validation failed: ${validationErrors.join(', ')}`);
  let photoAssets = null;
  if (args.photoManifest) {
    const manifestPath = path.resolve(args.photoManifest);
    const manifest = readJson(manifestPath);
    const manifestErrors = validatePhotoManifest(manifest);
    if (manifestErrors.length) throw new Error(`photo manifest validation failed: ${manifestErrors.join(', ')}`);
    photoAssets = normalizePhotoManifest(manifest, manifestPath);
  }
  const outDir = args.outDir
    ? path.resolve(args.outDir)
    : path.join(DEFAULT_OUT_ROOT, nowStamp());
  ensureDir(outDir);
  ensureDir(path.join(outDir, 'raw'));

  const cases = asArray(dataset.cases).filter((testCase) => !args.caseId || testCase.case_id === args.caseId);
  const results = [];
  for (const testCase of cases) {
    let raw = null;
    if (args.runLive) {
      if (!args.baseUrl) throw new Error('missing --base-url or BASE_URL for --run-live');
      raw = await runLiveCase(testCase, {
        baseUrl: args.baseUrl,
        timeoutMs: args.timeoutMs || dataset.defaults?.timeout_ms || 45000,
        photoAssets,
      });
    } else {
      if (!args.responsesDir) throw new Error('missing --responses-dir when not using --run-live');
      const responsePath = resolveResponsePath(path.resolve(args.responsesDir), testCase.case_id);
      if (!responsePath) throw new Error(`missing response fixture for ${testCase.case_id}`);
      raw = readJson(responsePath);
    }
    writeJson(path.join(outDir, 'raw', `${testCase.case_id}.json`), raw);
    results.push(scoreCase(testCase, raw));
  }
  const summary = summarizeResults(dataset, results);
  const report = { summary, results };
  writeJson(path.join(outDir, 'summary.json'), report);
  fs.writeFileSync(path.join(outDir, 'report.md'), toMarkdown(summary, results));
  return { outDir, ...report };
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    const report = await runBenchmark(args);
    process.stdout.write(`${JSON.stringify({ out_dir: report.outDir, summary: report.summary }, null, 2)}\n`);
    if (args.failOnThreshold && !report.summary.gate_pass) process.exit(2);
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  validateDataset,
  validatePhotoManifest,
  normalizePhotoManifest,
  scoreCase,
  summarizeResults,
  runBenchmark,
  extractFindingTypes,
  extractVisibleText,
  containsUnguardedDiagnosis,
  hasProductRecommendationSurface
};
