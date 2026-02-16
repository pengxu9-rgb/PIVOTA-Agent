#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const { generateMultiImageJsonFromGemini } = require('../src/layer1/llm/geminiMultiClient');

const MODULE_IDS = Object.freeze([
  'forehead',
  'under_eye_left',
  'under_eye_right',
  'left_cheek',
  'right_cheek',
  'nose',
  'chin',
]);
const MODULE_VERTICAL_RANGE = Object.freeze({
  forehead: [0.0, 0.44],
  under_eye_left: [0.18, 0.6],
  under_eye_right: [0.18, 0.6],
  left_cheek: [0.3, 0.9],
  right_cheek: [0.3, 0.9],
  nose: [0.22, 0.8],
  chin: [0.56, 1.0],
});
const MAX_RELATIVE_CENTER_SHIFT = 0.42;
const MAX_RELATIVE_SIZE_SCALE = 2.7;

const HELP_TEXT = `llm_module_box_qc_poc.mjs

Usage:
  node scripts/llm_module_box_qc_poc.mjs --manifest <path> [options]

Required:
  --manifest <path>                       path to preference manifest.json

Options:
  --provider <mock|gemini|openai>         default: mock
  --model <name>                          model override (provider-specific)
  --escalate_provider <mock|gemini|openai|none>  optional second-pass provider for uncertain samples
  --escalate_model <name>                 model override for second-pass provider
  --escalate_min_confidence <0-1>         trigger second-pass when confidence is lower (default: 0.72)
  --escalate_min_risk_reasons <n>         trigger second-pass when risk reasons >= n (default: 2)
  --escalate_on_decisions <csv>           trigger second-pass for these decisions (default: revise,reject)
  --escalate_if_error <bool>              trigger second-pass when provider failed/parse failed (default: true)
  --out <dir>                             output dir (default: <manifest_dir>/llm_qc_poc)
  --side <A|B|both>                       default: both
  --limit <n>                             max candidate sides to process (default: 20)
  --risk_only <bool>                      process only risk candidates (default: true)
  --risk_min_pixels <n>                   low pixel threshold (default: 56)
  --risk_min_geometry_score <0-1>         low geometry threshold (default: 0.88)
  --risk_max_abs_yaw <0-1>                high yaw threshold (default: 0.55)
  --write_corrected_manifest <bool>        emit corrected manifest copy (default: true)
  --write_final_manifest <bool>            emit final manifest for downstream (default: true)
  --dry_run <bool>                        skip provider call; emit candidate list only (default: false)
  --help                                  show help

Provider env:
  Gemini: GEMINI_API_KEY or GOOGLE_API_KEY, GEMINI_ONE_CLICK_MODEL (optional)
  OpenAI: OPENAI_API_KEY, OPENAI_BASE_URL (optional), PIVOTA_LAYER2_MODEL_OPENAI (optional)
`;

const correctedBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const responseSchema = z.object({
  decision: z.enum(['accept', 'revise', 'reject']),
  confidence: z.number().min(0).max(1).default(0.5),
  violations: z.array(z.string().min(1)).default([]),
  corrected_boxes: z.record(z.string(), correctedBoxSchema).optional(),
  notes: z.string().max(800).optional().default(''),
});

function coerceDecision(raw) {
  const token = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!token) return 'reject';
  if (['accept', 'accepted', 'pass', 'ok', 'approve'].includes(token)) return 'accept';
  if (['revise', 'revision', 'fix', 'fixed', 'correct', 'adjust'].includes(token)) return 'revise';
  if (['reject', 'rejected', 'fail', 'invalid', 'unusable'].includes(token)) return 'reject';
  if (token.includes('accept') || token.includes('pass')) return 'accept';
  if (token.includes('revise') || token.includes('fix') || token.includes('correct')) return 'revise';
  return 'reject';
}

function coerceConfidence(raw) {
  if (raw == null) return 0.5;
  if (typeof raw === 'number' && Number.isFinite(raw)) return clamp01(raw);
  const token = String(raw).trim().toLowerCase();
  const asNum = Number(token);
  if (Number.isFinite(asNum)) return clamp01(asNum);
  if (token.includes('high')) return 0.8;
  if (token.includes('medium') || token.includes('mid')) return 0.6;
  if (token.includes('low')) return 0.35;
  return 0.5;
}

function coerceViolations(raw, fallbackRaw = null) {
  function toTokens(item) {
    if (item == null) return [];
    if (typeof item === 'string') {
      return String(item)
        .split(/[;,|]/g)
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    }
    if (item && typeof item === 'object') {
      const message = String(item.message ?? item.reason ?? item.issue ?? '').trim();
      const code = String(item.code ?? item.type ?? item.id ?? '').trim();
      if (message && code) return [`${code}: ${message}`];
      if (message) return [message];
      if (code) return [code];
      return Object.entries(item)
        .filter(([, value]) => Boolean(value))
        .map(([key]) => String(key || '').trim())
        .filter(Boolean);
    }
    const token = String(item).trim();
    return token ? [token] : [];
  }

  if (Array.isArray(raw)) {
    const merged = [];
    for (const item of raw) merged.push(...toTokens(item));
    return Array.from(new Set(merged.filter(Boolean)));
  }
  if (typeof raw === 'string') {
    return Array.from(new Set(toTokens(raw)));
  }
  if (raw && typeof raw === 'object') {
    return Array.from(new Set(toTokens(raw)));
  }
  if (Array.isArray(fallbackRaw)) return coerceViolations(fallbackRaw);
  if (typeof fallbackRaw === 'string') return coerceViolations(fallbackRaw);
  return [];
}

function toXywh(boxLike) {
  if (!boxLike || typeof boxLike !== 'object') return null;
  const x = Number(boxLike.x);
  const y = Number(boxLike.y);
  const w = Number(boxLike.w);
  const h = Number(boxLike.h);
  if ([x, y, w, h].every((v) => Number.isFinite(v))) return { x, y, w, h };
  const x0 = Number(boxLike.x0 ?? boxLike.left);
  const y0 = Number(boxLike.y0 ?? boxLike.top);
  const x1 = Number(boxLike.x1 ?? boxLike.right);
  const y1 = Number(boxLike.y1 ?? boxLike.bottom);
  if ([x0, y0, x1, y1].every((v) => Number.isFinite(v))) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  return null;
}

function coerceCorrectedBoxes(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const moduleId = String(item.module_id || item.moduleId || item.id || '').trim();
      if (!moduleId || !MODULE_IDS.includes(moduleId)) continue;
      const boxRaw = item.box && typeof item.box === 'object' ? item.box : item;
      const xywh = toXywh(boxRaw);
      const safe = sanitizeBox(xywh);
      if (safe) out[moduleId] = safe;
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const moduleId of MODULE_IDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, moduleId)) continue;
      const xywh = toXywh(raw[moduleId]);
      const safe = sanitizeBox(xywh);
      if (safe) out[moduleId] = safe;
    }
  }
  return out;
}

function normalizeProviderOutput(raw) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const decision = coerceDecision(
    payload.decision ?? payload.result ?? payload.status ?? payload.action,
  );
  const confidence = coerceConfidence(
    payload.confidence ?? payload.score ?? payload.reliability,
  );
  const violations = coerceViolations(
    payload.violations ?? payload.issues ?? payload.errors,
    payload.reason ?? payload.reasons,
  );
  const correctedBoxes = coerceCorrectedBoxes(
    payload.corrected_boxes
      ?? payload.correctedBoxes
      ?? payload.revised_boxes
      ?? payload.boxes,
  );
  const notes = String(
    payload.notes
    ?? payload.note
    ?? payload.comment
    ?? payload.rationale
    ?? '',
  ).slice(0, 800);
  return {
    decision,
    confidence,
    violations,
    corrected_boxes: correctedBoxes,
    notes,
  };
}

function buildTolerantNormalized(raw, fallbackNote = '') {
  const normalized = normalizeProviderOutput(raw);
  const notes = String(normalized.notes || fallbackNote || '').slice(0, 800);
  return {
    decision: coerceDecision(normalized.decision),
    confidence: coerceConfidence(normalized.confidence),
    violations: coerceViolations(normalized.violations),
    corrected_boxes: coerceCorrectedBoxes(normalized.corrected_boxes),
    notes,
  };
}

function extractFirstBalancedJsonValue(text) {
  const s = String(text || '');
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (start < 0) {
      if (ch === '{' || ch === '[') {
        start = i;
        stack.push(ch);
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      const matches = (top === '{' && ch === '}') || (top === '[' && ch === ']');
      if (!matches) return null;
      stack.pop();
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseLooseJsonValue(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // continue
  }
  const fencedMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const fenced = String(fencedMatch[1]).trim();
    try {
      return JSON.parse(fenced);
    } catch {
      // continue
    }
  }
  const extracted = extractFirstBalancedJsonValue(s);
  if (!extracted) return null;
  try {
    return JSON.parse(extracted);
  } catch {
    return null;
  }
}

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseCsvTokenSet(value, fallbackList = []) {
  const source = value == null ? '' : String(value);
  const tokens = source
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return new Set(fallbackList.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
  return new Set(tokens);
}

function decisionSeverityRank(decisionRaw) {
  const decision = coerceDecision(decisionRaw);
  if (decision === 'accept') return 0;
  if (decision === 'revise') return 1;
  return 2;
}

function chooseConservativePass(primaryPass, secondaryPass) {
  if (!secondaryPass) return { selected: primaryPass, selectedSecondary: false };
  // Secondary call failed/parse-failed: never let fallback reject override a valid primary pass.
  if (secondaryPass.error || secondaryPass.parse_error) {
    return { selected: primaryPass, selectedSecondary: false };
  }
  const primary = primaryPass && primaryPass.normalized ? primaryPass.normalized : null;
  const secondary = secondaryPass && secondaryPass.normalized ? secondaryPass.normalized : null;
  if (!primary) return { selected: secondaryPass, selectedSecondary: true };
  if (!secondary) return { selected: primaryPass, selectedSecondary: false };
  // Defensive guard: provider_error synthetic output should not replace a successful primary answer.
  if (Array.isArray(secondary.violations) && secondary.violations.some((v) => String(v || '').toLowerCase().includes('provider_error'))) {
    return { selected: primaryPass, selectedSecondary: false };
  }

  const rankPrimary = decisionSeverityRank(primary.decision);
  const rankSecondary = decisionSeverityRank(secondary.decision);
  if (rankSecondary > rankPrimary) return { selected: secondaryPass, selectedSecondary: true };
  if (rankSecondary < rankPrimary) return { selected: primaryPass, selectedSecondary: false };

  const correctedPrimary = Object.keys(primary.corrected_boxes || {}).length;
  const correctedSecondary = Object.keys(secondary.corrected_boxes || {}).length;
  if (correctedSecondary > correctedPrimary) return { selected: secondaryPass, selectedSecondary: true };
  if (correctedSecondary < correctedPrimary) return { selected: primaryPass, selectedSecondary: false };

  const violationsPrimary = Array.isArray(primary.violations) ? primary.violations.length : 0;
  const violationsSecondary = Array.isArray(secondary.violations) ? secondary.violations.length : 0;
  if (violationsSecondary > violationsPrimary) return { selected: secondaryPass, selectedSecondary: true };
  if (violationsSecondary < violationsPrimary) return { selected: primaryPass, selectedSecondary: false };

  const confPrimary = clamp01(primary.confidence);
  const confSecondary = clamp01(secondary.confidence);
  if (confSecondary < confPrimary) return { selected: secondaryPass, selectedSecondary: true };
  return { selected: primaryPass, selectedSecondary: false };
}

function shouldEscalateCandidate({
  primaryPass,
  candidate,
  escalateEnabled,
  escalateIfError,
  escalateMinConfidence,
  escalateMinRiskReasons,
  escalateOnDecisionSet,
}) {
  if (!escalateEnabled) return { should: false, reasons: [] };
  const reasons = [];
  if (!primaryPass || !primaryPass.normalized) {
    reasons.push('primary_missing');
  } else {
    const decision = String(primaryPass.normalized.decision || '').trim().toLowerCase();
    const confidence = clamp01(primaryPass.normalized.confidence);
    if (escalateOnDecisionSet.has(decision)) reasons.push(`decision:${decision || 'unknown'}`);
    if (confidence < escalateMinConfidence) reasons.push(`low_confidence:${round4(confidence)}`);
  }
  if (Number.isFinite(escalateMinRiskReasons) && escalateMinRiskReasons > 0) {
    const riskCount = Array.isArray(candidate && candidate.risk_reasons) ? candidate.risk_reasons.length : 0;
    if (riskCount >= escalateMinRiskReasons) reasons.push(`risk_reasons:${riskCount}`);
  }
  if (escalateIfError && primaryPass && (primaryPass.error || primaryPass.parse_error)) reasons.push('primary_error');
  return {
    should: reasons.length > 0,
    reasons,
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function sanitizeBox(boxRaw) {
  if (!boxRaw || typeof boxRaw !== 'object') return null;
  const x = clamp01(Number(boxRaw.x));
  const y = clamp01(Number(boxRaw.y));
  const w = Math.max(0.01, Math.min(1, Number(boxRaw.w)));
  const h = Math.max(0.01, Math.min(1, Number(boxRaw.h)));
  const safeX = Math.max(0, Math.min(1 - w, x));
  const safeY = Math.max(0, Math.min(1 - h, y));
  return {
    x: round4(safeX),
    y: round4(safeY),
    w: round4(w),
    h: round4(h),
  };
}

function normalizeBoxMapFromModuleRows(moduleRows) {
  const map = {};
  const rows = Array.isArray(moduleRows) ? moduleRows : [];
  for (const row of rows) {
    const moduleId = String(row && row.module_id ? row.module_id : '').trim();
    if (!moduleId || !MODULE_IDS.includes(moduleId)) continue;
    const box = sanitizeBox(row && row.box ? row.box : null);
    if (!box) continue;
    map[moduleId] = box;
  }
  return map;
}

function copyModuleRowsWithCorrectedBoxes(moduleRows, correctedBoxesMap) {
  const rows = Array.isArray(moduleRows) ? moduleRows : [];
  return rows.map((row) => {
    const moduleId = String(row && row.module_id ? row.module_id : '').trim();
    if (!moduleId || !correctedBoxesMap[moduleId]) return row;
    return {
      ...row,
      box: correctedBoxesMap[moduleId],
    };
  });
}

function getSideData(row, side) {
  const useA = String(side).toUpperCase() === 'A';
  const role = String(useA ? row.role_a : row.role_b || '').trim().toLowerCase();
  const imagePath = String(useA ? row.image_a_path : row.image_b_path || '').trim();
  const summary = role === 'baseline' ? row.baseline_summary : row.variant_summary;
  const moduleRows = role === 'baseline' ? row.baseline_module_rows : row.variant_module_rows;
  return { role, imagePath, summary: summary || {}, moduleRows: Array.isArray(moduleRows) ? moduleRows : [] };
}

function riskReasonsFromCandidate({ summary, moduleBoxes, thresholds }) {
  const reasons = [];
  const pixelsMin = Number(summary && summary.module_pixels_min);
  const geometryScore = Number(summary && summary.geometry_qc_score);
  const yaw = Number(summary && summary.module_box_yaw_est);
  const guardTriggered = Boolean(summary && summary.module_guard_triggered);
  const dynamicApplied = Boolean(summary && summary.module_box_dynamic_applied);

  if (guardTriggered) reasons.push('module_guard_triggered');
  if (Number.isFinite(pixelsMin) && pixelsMin <= thresholds.riskMinPixels) reasons.push('module_pixels_min_low');
  if (Number.isFinite(geometryScore) && geometryScore < thresholds.riskMinGeometryScore) reasons.push('geometry_qc_low');
  if (Number.isFinite(yaw) && Math.abs(yaw) > thresholds.riskMaxAbsYaw) reasons.push('yaw_high');
  if (!dynamicApplied) reasons.push('dynamic_not_applied');

  const nose = moduleBoxes.nose;
  const chin = moduleBoxes.chin;
  if (nose && chin) {
    const noseBottom = nose.y + nose.h;
    if (chin.y < noseBottom - 0.01) reasons.push('chin_above_nose_bottom');
    if (chin.y < nose.y + (nose.h * 0.6)) reasons.push('chin_too_high_vs_nose');
    if (chin.y > 0.9) reasons.push('chin_too_low_global');
  }
  const forehead = moduleBoxes.forehead;
  if (forehead && nose) {
    if (forehead.y + forehead.h > nose.y) reasons.push('forehead_overlaps_nose_zone');
  }

  return Array.from(new Set(reasons));
}

function inferMimeTypeFromPath(imagePath) {
  const ext = String(path.extname(String(imagePath || '')).toLowerCase());
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function imageToDataUrl(imagePath) {
  const bytes = await fs.readFile(imagePath);
  const mime = inferMimeTypeFromPath(imagePath);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function buildPrompt({ moduleBoxes, summary, riskReasons }) {
  const summaryCompact = {
    module_pixels_min: Number.isFinite(Number(summary.module_pixels_min)) ? Number(summary.module_pixels_min) : null,
    geometry_qc_score: Number.isFinite(Number(summary.geometry_qc_score)) ? Number(summary.geometry_qc_score) : null,
    module_box_dynamic_score: Number.isFinite(Number(summary.module_box_dynamic_score))
      ? Number(summary.module_box_dynamic_score)
      : null,
    module_box_yaw_est: Number.isFinite(Number(summary.module_box_yaw_est)) ? Number(summary.module_box_yaw_est) : null,
    face_oval_mask_source: summary.face_oval_mask_source == null ? null : String(summary.face_oval_mask_source),
  };
  return [
    'You are a strict reviewer for face module boxes on an overlay image.',
    'Target face: the main person (largest and most central). Ignore secondary faces/background people.',
    'Assess module boxes: forehead, under_eye_left, under_eye_right, nose, left_cheek, right_cheek, chin.',
    'Rules:',
    '1) chin must be on jaw/chin area, not mouth/lips/nose/neck/clothing.',
    '2) cheek boxes must stay on the same target face; never cross to another person.',
    '3) nose should cover nose bridge/tip area, centered.',
    '4) forehead should be in forehead/hairline skin region, not background.',
    'Return JSON only with keys: decision, confidence, violations, corrected_boxes, notes.',
    'If boxes are acceptable -> decision=accept and no corrected_boxes.',
    'If fixable -> decision=revise and provide corrected_boxes for only changed modules.',
    'If not reliably fixable (ambiguous/multi-face severe) -> decision=reject.',
    '',
    `Current boxes JSON: ${JSON.stringify(moduleBoxes)}`,
    `Current summary JSON: ${JSON.stringify(summaryCompact)}`,
    `Risk hints: ${JSON.stringify(riskReasons)}`,
  ].join('\n');
}

function boxDeltaL1(beforeRaw, afterRaw) {
  const before = sanitizeBox(beforeRaw);
  const after = sanitizeBox(afterRaw);
  if (!before || !after) return 0;
  const beforeCx = before.x + (before.w / 2);
  const beforeCy = before.y + (before.h / 2);
  const afterCx = after.x + (after.w / 2);
  const afterCy = after.y + (after.h / 2);
  return (
    Math.abs(beforeCx - afterCx)
    + Math.abs(beforeCy - afterCy)
    + Math.abs(before.w - after.w)
    + Math.abs(before.h - after.h)
  );
}

function estimateFaceRect(boxMap) {
  const boxes = MODULE_IDS
    .map((moduleId) => sanitizeBox(boxMap && boxMap[moduleId]))
    .filter(Boolean);
  if (!boxes.length) return { x: 0, y: 0, w: 1, h: 1 };
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const width = Math.max(0.1, maxX - minX);
  const height = Math.max(0.12, maxY - minY);
  const padded = sanitizeBox({
    x: minX - (width * 0.06),
    y: minY - (height * 0.08),
    w: width * 1.12,
    h: height * 1.16,
  });
  return padded || { x: 0, y: 0, w: 1, h: 1 };
}

function clampBoxToRect(boxRaw, rectRaw) {
  const box = sanitizeBox(boxRaw);
  const rect = sanitizeBox(rectRaw);
  if (!box || !rect) return box || null;
  const x0 = Math.max(rect.x, box.x);
  const y0 = Math.max(rect.y, box.y);
  const x1 = Math.min(rect.x + rect.w, box.x + box.w);
  const y1 = Math.min(rect.y + rect.h, box.y + box.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return sanitizeBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

function sanitizeCorrectedBoxMap(correctedRaw, originalBoxes) {
  const proposed = {};
  const raw = correctedRaw && typeof correctedRaw === 'object' ? correctedRaw : {};
  for (const moduleId of MODULE_IDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, moduleId)) continue;
    const safe = sanitizeBox(raw[moduleId]);
    if (!safe) continue;
    proposed[moduleId] = safe;
  }
  const merged = { ...originalBoxes, ...proposed };
  const faceRect = estimateFaceRect(originalBoxes);
  const faceCenterX = faceRect.x + (faceRect.w / 2);
  const sideGap = Math.max(0.02, faceRect.w * 0.04);
  const candidateModuleIds = new Set(Object.keys(proposed));
  const repairs = [];

  const maybeRecordRepair = (moduleId, rule, before, after) => {
    const delta = boxDeltaL1(before, after);
    if (delta <= 1e-4) return;
    repairs.push({
      module_id: moduleId,
      rule,
      delta_l1: round4(delta),
    });
  };

  for (const moduleId of Object.keys(proposed)) {
    const original = sanitizeBox(merged[moduleId]);
    if (!original) continue;
    let next = clampBoxToRect(original, faceRect) || original;

    const verticalRange = MODULE_VERTICAL_RANGE[moduleId];
    if (verticalRange) {
      const yMin = faceRect.y + (faceRect.h * Number(verticalRange[0]));
      const yMax = faceRect.y + (faceRect.h * Number(verticalRange[1]));
      const boundedH = Math.max(0.01, Math.min(next.h, yMax - yMin));
      let boundedY = next.y;
      if (boundedY < yMin) boundedY = yMin;
      if (boundedY + boundedH > yMax) boundedY = yMax - boundedH;
      const bounded = sanitizeBox({ ...next, y: boundedY, h: boundedH });
      if (bounded) next = bounded;
    }

    if (moduleId === 'under_eye_left' || moduleId === 'left_cheek') {
      const maxRight = Math.max(faceRect.x + 0.01, faceCenterX + sideGap);
      const right = next.x + next.w;
      if (right > maxRight) {
        const nextW = Math.max(0.01, maxRight - next.x);
        const bounded = sanitizeBox({ ...next, w: nextW });
        if (bounded) next = bounded;
      }
    }
    if (moduleId === 'under_eye_right' || moduleId === 'right_cheek') {
      const minLeft = Math.min(faceRect.x + faceRect.w - 0.01, faceCenterX - sideGap);
      if (next.x < minLeft) {
        const right = next.x + next.w;
        const nextX = Math.min(Math.max(minLeft, faceRect.x), faceRect.x + faceRect.w - 0.01);
        const nextW = Math.max(0.01, right - nextX);
        const bounded = sanitizeBox({ ...next, x: nextX, w: nextW });
        if (bounded) next = bounded;
      }
    }
    if (moduleId === 'nose') {
      const noseCenter = next.x + (next.w / 2);
      const maxOffset = Math.max(0.04, faceRect.w * 0.2);
      if (Math.abs(noseCenter - faceCenterX) > maxOffset) {
        const shifted = sanitizeBox({
          ...next,
          x: faceCenterX - (next.w / 2),
        });
        if (shifted) next = shifted;
      }
    }

    const ref = sanitizeBox(originalBoxes && originalBoxes[moduleId]);
    if (ref) {
      const refCenterX = ref.x + (ref.w / 2);
      const refCenterY = ref.y + (ref.h / 2);
      const nextCenterX = next.x + (next.w / 2);
      const nextCenterY = next.y + (next.h / 2);
      const centerShift = Math.abs(nextCenterX - refCenterX) + Math.abs(nextCenterY - refCenterY);
      const shiftLimit = Math.max(0.05, faceRect.w * MAX_RELATIVE_CENTER_SHIFT);
      if (centerShift > shiftLimit) {
        const pull = clamp01((centerShift - shiftLimit) / Math.max(shiftLimit, 1e-4));
        const blended = sanitizeBox({
          x: next.x + ((ref.x - next.x) * pull),
          y: next.y + ((ref.y - next.y) * pull),
          w: next.w + ((ref.w - next.w) * Math.min(0.7, pull)),
          h: next.h + ((ref.h - next.h) * Math.min(0.7, pull)),
        });
        if (blended) next = blended;
      }
      const maxW = Math.max(0.02, ref.w * MAX_RELATIVE_SIZE_SCALE);
      const maxH = Math.max(0.02, ref.h * MAX_RELATIVE_SIZE_SCALE);
      if (next.w > maxW || next.h > maxH) {
        const limited = sanitizeBox({
          x: (next.x + (next.w / 2)) - (Math.min(next.w, maxW) / 2),
          y: (next.y + (next.h / 2)) - (Math.min(next.h, maxH) / 2),
          w: Math.min(next.w, maxW),
          h: Math.min(next.h, maxH),
        });
        if (limited) next = limited;
      }
    }

    maybeRecordRepair(moduleId, 'deterministic_box_envelope', original, next);
    merged[moduleId] = next;
  }

  const nose = sanitizeBox(merged.nose);
  const chin = sanitizeBox(merged.chin);
  if (nose && chin) {
    const minChinTop = Math.max(0, nose.y + (nose.h * 0.55));
    if (chin.y < minChinTop) {
      const adjusted = sanitizeBox({ ...chin, y: minChinTop });
      if (adjusted) {
        maybeRecordRepair('chin', 'chin_below_nose_guard', chin, adjusted);
        merged.chin = adjusted;
        candidateModuleIds.add('chin');
      }
    }
  }
  const forehead = sanitizeBox(merged.forehead);
  const eyeTop = Math.min(
    Number(sanitizeBox(merged.under_eye_left)?.y ?? 1),
    Number(sanitizeBox(merged.under_eye_right)?.y ?? 1),
  );
  if (forehead && Number.isFinite(eyeTop)) {
    const maxForeheadBottom = Math.max(faceRect.y + (faceRect.h * 0.16), eyeTop - 0.01);
    const foreheadBottom = forehead.y + forehead.h;
    if (foreheadBottom > maxForeheadBottom) {
      const tightened = sanitizeBox({
        ...forehead,
        h: Math.max(0.01, maxForeheadBottom - forehead.y),
      });
      if (tightened) {
        maybeRecordRepair('forehead', 'forehead_above_eye_guard', forehead, tightened);
        merged.forehead = tightened;
        candidateModuleIds.add('forehead');
      }
    }
  }

  const correctedOut = {};
  for (const moduleId of candidateModuleIds) {
    const fixed = sanitizeBox(merged[moduleId]);
    const before = sanitizeBox(originalBoxes && originalBoxes[moduleId]);
    if (!fixed) continue;
    if (before && boxDeltaL1(before, fixed) <= 1e-4) continue;
    correctedOut[moduleId] = fixed;
  }
  return {
    corrected_boxes: correctedOut,
    validator_repairs: repairs,
  };
}

function computeCorrectionStats(originalBoxes, correctedBoxes) {
  const changedModules = [];
  for (const moduleId of MODULE_IDS) {
    const before = originalBoxes[moduleId];
    const after = correctedBoxes[moduleId];
    if (!before || !after) continue;
    const dx = Math.abs((before.x + before.w / 2) - (after.x + after.w / 2));
    const dy = Math.abs((before.y + before.h / 2) - (after.y + after.h / 2));
    const dw = Math.abs(before.w - after.w);
    const dh = Math.abs(before.h - after.h);
    const totalDelta = round4(dx + dy + dw + dh);
    if (totalDelta <= 1e-4) continue;
    changedModules.push({ module_id: moduleId, delta_l1: totalDelta });
  }
  return {
    corrected_modules: changedModules.map((item) => item.module_id),
    corrected_modules_count: changedModules.length,
    mean_delta_l1: changedModules.length
      ? round4(changedModules.reduce((sum, item) => sum + Number(item.delta_l1), 0) / changedModules.length)
      : 0,
  };
}

async function callGeminiProvider({ promptText, imagePath, model }) {
  const schema = z.any();
  const result = await generateMultiImageJsonFromGemini({
    promptText,
    images: [{ label: 'OVERLAY_IMAGE', imagePath }],
    schema,
    model,
  });
  if (!result || !result.ok) {
    const code = result && result.error && result.error.code ? String(result.error.code) : 'GEMINI_FAILED';
    const msg = result && result.error && result.error.message ? String(result.error.message) : 'Gemini call failed';
    const raw = result && typeof result.raw === 'string' ? result.raw : '';
    if (raw && (code === 'SCHEMA_INVALID' || code === 'JSON_PARSE_FAILED')) {
      const loose = parseLooseJsonValue(raw);
      if (loose != null) {
        return buildTolerantNormalized(loose, `salvaged_from_${code.toLowerCase()}`);
      }
    }
    throw new Error(`${code}: ${msg}`);
  }
  return buildTolerantNormalized(result.value);
}

async function callOpenAIProvider({ promptText, imagePath, model }) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('MISSING_OPENAI_API_KEY');
  const baseURL = String(process.env.OPENAI_BASE_URL || '').trim();
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  const resolvedModel = String(model || process.env.PIVOTA_LAYER2_MODEL_OPENAI || 'gpt-4o-mini').trim();
  const imageUrl = await imageToDataUrl(imagePath);
  const resp = await client.chat.completions.create({
    model: resolvedModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Return strict JSON only. No markdown.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  const text = String(resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content
    ? resp.choices[0].message.content
    : '').trim();
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE');
  const parsed = responseSchema.safeParse(normalizeProviderOutput(JSON.parse(text)));
  if (!parsed.success) throw new Error(`OPENAI_SCHEMA_INVALID: ${parsed.error.message}`);
  return parsed.data;
}

function mockLlmDecision({ moduleBoxes, riskReasons }) {
  const violations = [];
  const corrected = {};
  const nose = moduleBoxes.nose;
  const chin = moduleBoxes.chin;
  if (nose && chin && (chin.y < nose.y + (nose.h * 0.55))) {
    violations.push('chin_too_high');
    const fixedY = Math.min(0.92, Math.max(chin.y, nose.y + (nose.h * 0.62)));
    const fixedH = Math.max(0.08, Math.min(0.24, chin.h));
    corrected.chin = sanitizeBox({ ...chin, y: fixedY, h: fixedH });
  }
  if (riskReasons.includes('yaw_high')) violations.push('pose_high_yaw');
  if (riskReasons.includes('dynamic_not_applied')) violations.push('dynamic_not_applied');
  const correctedCount = Object.values(corrected).filter(Boolean).length;
  if (correctedCount > 0) {
    return {
      decision: 'revise',
      confidence: 0.55,
      violations,
      corrected_boxes: corrected,
      notes: 'mock_provider_revision',
    };
  }
  if (riskReasons.some((r) => r.includes('multi') || r.includes('cross'))) {
    return {
      decision: 'reject',
      confidence: 0.45,
      violations: ['multi_face_ambiguous'],
      corrected_boxes: {},
      notes: 'mock_provider_reject',
    };
  }
  return {
    decision: 'accept',
    confidence: 0.6,
    violations,
    corrected_boxes: {},
    notes: 'mock_provider_accept',
  };
}

async function callProvider({ provider, model, promptText, imagePath, moduleBoxes, riskReasons, dryRun }) {
  if (dryRun) {
    return {
      decision: 'accept',
      confidence: 0.5,
      violations: [],
      corrected_boxes: {},
      notes: 'dry_run_skipped_provider',
    };
  }
  if (provider === 'mock') return mockLlmDecision({ moduleBoxes, riskReasons });
  if (provider === 'gemini') return callGeminiProvider({ promptText, imagePath, model });
  if (provider === 'openai') return callOpenAIProvider({ promptText, imagePath, model });
  throw new Error(`Unsupported provider: ${provider}`);
}

function normalizePassOutput({ llmRaw, error, provider, model }) {
  const normalizedCandidate = llmRaw != null
    ? buildTolerantNormalized(llmRaw)
    : null;
  const parsed = normalizedCandidate
    ? responseSchema.safeParse(normalizedCandidate)
    : null;
  const parseError = (parsed && !parsed.success)
    ? parsed.error.message
    : null;
  let normalized;
  if (parsed && parsed.success) {
    normalized = parsed.data;
  } else if (normalizedCandidate) {
    normalized = {
      ...normalizedCandidate,
      notes: String(normalizedCandidate.notes || 'schema_tolerated').slice(0, 800),
    };
  } else {
    normalized = {
      decision: 'reject',
      confidence: 0,
      violations: ['provider_error'],
      corrected_boxes: {},
      notes: error || 'provider_parse_failed',
    };
  }
  return {
    provider,
    model: model || null,
    normalized,
    error: error || null,
    parse_error: parseError,
  };
}

function applyCorrectionsToManifest(manifest, resultsByKey) {
  const cloned = JSON.parse(JSON.stringify(manifest));
  const rows = Array.isArray(cloned.rows) ? cloned.rows : [];
  for (const row of rows) {
    const sampleHash = String(row.sample_hash || '').trim();
    if (!sampleHash) continue;
    for (const side of ['A', 'B']) {
      const key = `${sampleHash}:${side}`;
      const rec = resultsByKey.get(key);
      if (!rec || rec.decision !== 'revise' || !rec.corrected_boxes || !Object.keys(rec.corrected_boxes).length) continue;
      const useA = side === 'A';
      const role = String(useA ? row.role_a : row.role_b || '').trim().toLowerCase();
      if (role === 'baseline') {
        row.baseline_module_rows = copyModuleRowsWithCorrectedBoxes(row.baseline_module_rows, rec.corrected_boxes);
      } else if (role === 'variant') {
        row.variant_module_rows = copyModuleRowsWithCorrectedBoxes(row.variant_module_rows, rec.corrected_boxes);
      }
      const sideSummary = role === 'baseline' ? row.baseline_summary : row.variant_summary;
      if (sideSummary && typeof sideSummary === 'object') {
        sideSummary.llm_qc_applied = true;
        sideSummary.llm_qc_provider = rec.provider;
        sideSummary.llm_qc_decision = rec.decision;
        sideSummary.llm_qc_violations = rec.violations;
        sideSummary.llm_qc_corrected_modules = Array.isArray(rec.corrected_modules) ? rec.corrected_modules : [];
        sideSummary.llm_qc_corrected_modules_count = Number.isFinite(Number(rec.corrected_modules_count))
          ? Number(rec.corrected_modules_count)
          : 0;
        sideSummary.llm_qc_validator_repairs = Array.isArray(rec.validator_repairs) ? rec.validator_repairs : [];
      }
    }
  }
  return cloned;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBool(args.help, false)) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  const manifestPathRaw = String(args.manifest || '').trim();
  if (!manifestPathRaw) {
    process.stderr.write('Missing --manifest\n');
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.resolve(manifestPathRaw);
  const provider = String(args.provider || 'mock').trim().toLowerCase();
  if (!['mock', 'gemini', 'openai'].includes(provider)) {
    process.stderr.write(`Unsupported --provider: ${provider}\n`);
    process.exitCode = 2;
    return;
  }
  const model = String(args.model || '').trim() || null;
  const escalateProviderRaw = String(args.escalate_provider || '').trim().toLowerCase();
  const escalateProvider = (!escalateProviderRaw || escalateProviderRaw === 'none') ? null : escalateProviderRaw;
  if (escalateProvider && !['mock', 'gemini', 'openai'].includes(escalateProvider)) {
    process.stderr.write(`Unsupported --escalate_provider: ${escalateProvider}\n`);
    process.exitCode = 2;
    return;
  }
  const escalateModel = String(args.escalate_model || '').trim() || null;
  const escalateEnabled = Boolean(escalateProvider);
  const escalateMinConfidence = clamp01(parseNumber(args.escalate_min_confidence, 0.72, 0, 1));
  const escalateMinRiskReasons = Math.max(0, Math.min(20, Math.trunc(parseNumber(args.escalate_min_risk_reasons, 2, 0, 20))));
  const escalateIfError = parseBool(args.escalate_if_error, true);
  const escalateOnDecisionSet = parseCsvTokenSet(args.escalate_on_decisions, ['revise', 'reject']);
  const side = String(args.side || 'both').trim().toUpperCase();
  if (!['A', 'B', 'BOTH'].includes(side)) {
    process.stderr.write(`Unsupported --side: ${side}\n`);
    process.exitCode = 2;
    return;
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(parseNumber(args.limit, 20, 1, 500))));
  const riskOnly = parseBool(args.risk_only, true);
  const thresholds = {
    riskMinPixels: Math.max(1, Math.min(4096, Math.trunc(parseNumber(args.risk_min_pixels, 56, 1, 4096)))),
    riskMinGeometryScore: parseNumber(args.risk_min_geometry_score, 0.88, 0, 1),
    riskMaxAbsYaw: parseNumber(args.risk_max_abs_yaw, 0.55, 0, 1),
  };
  const writeCorrectedManifest = parseBool(args.write_corrected_manifest, true);
  const writeFinalManifest = parseBool(args.write_final_manifest, true);
  const dryRun = parseBool(args.dry_run, false);

  const manifestDir = path.dirname(manifestPath);
  const outDir = path.resolve(String(args.out || path.join(manifestDir, 'llm_qc_poc')).trim());
  await fs.mkdir(outDir, { recursive: true });

  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const rows = Array.isArray(manifest.rows) ? manifest.rows : [];

  const sideList = side === 'BOTH' ? ['A', 'B'] : [side];
  const candidates = [];
  for (const row of rows) {
    const sampleHash = String(row.sample_hash || '').trim();
    if (!sampleHash) continue;
    for (const s of sideList) {
      const sideData = getSideData(row, s);
      if (!sideData.imagePath) continue;
      const imagePath = path.resolve(sideData.imagePath);
      const moduleBoxes = normalizeBoxMapFromModuleRows(sideData.moduleRows);
      const riskReasons = riskReasonsFromCandidate({
        summary: sideData.summary || {},
        moduleBoxes,
        thresholds,
      });
      if (riskOnly && riskReasons.length === 0) continue;
      candidates.push({
        sample_hash: sampleHash,
        source: String(row.source || '').trim() || null,
        rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
        side: s,
        role: sideData.role || null,
        image_path: imagePath,
        module_boxes: moduleBoxes,
        summary: sideData.summary || {},
        risk_reasons: riskReasons,
      });
    }
  }

  const selected = candidates.slice(0, limit);
  const results = [];
  const startedAtMs = Date.now();
  const progressEvery = 5;
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const processed = index + 1;
    const promptText = buildPrompt({
      moduleBoxes: candidate.module_boxes,
      summary: candidate.summary,
      riskReasons: candidate.risk_reasons,
    });
    const runPass = async (passProvider, passModel, passPrompt) => {
      let llmRaw = null;
      let error = null;
      try {
        llmRaw = await callProvider({
          provider: passProvider,
          model: passModel,
          promptText: passPrompt,
          imagePath: candidate.image_path,
          moduleBoxes: candidate.module_boxes,
          riskReasons: candidate.risk_reasons,
          dryRun,
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return normalizePassOutput({
        llmRaw,
        error,
        provider: passProvider,
        model: passModel,
      });
    };

    const primaryPass = await runPass(provider, model, promptText);
    const escalateDecision = shouldEscalateCandidate({
      primaryPass,
      candidate,
      escalateEnabled,
      escalateIfError,
      escalateMinConfidence,
      escalateMinRiskReasons,
      escalateOnDecisionSet,
    });

    let secondaryPass = null;
    if (escalateDecision.should && escalateProvider) {
      const secondPrompt = `${promptText}\nSecond-pass strict mode: if uncertain between revise/reject, choose reject.`;
      secondaryPass = await runPass(escalateProvider, escalateModel, secondPrompt);
    }
    const selectedPass = chooseConservativePass(primaryPass, secondaryPass);
    const normalized = selectedPass.selected && selectedPass.selected.normalized
      ? selectedPass.selected.normalized
      : {
          decision: 'reject',
          confidence: 0,
          violations: ['provider_error'],
          corrected_boxes: {},
          notes: 'missing_selected_pass',
        };

    const correctedPack = sanitizeCorrectedBoxMap(
      normalized.corrected_boxes || {},
      candidate.module_boxes,
    );
    const corrected = correctedPack.corrected_boxes;
    const correctionStats = computeCorrectionStats(candidate.module_boxes, corrected);
    results.push({
      sample_hash: candidate.sample_hash,
      source: candidate.source,
      rank: candidate.rank,
      side: candidate.side,
      role: candidate.role,
      image_path: candidate.image_path,
      provider: selectedPass.selected ? selectedPass.selected.provider : provider,
      model: selectedPass.selected ? selectedPass.selected.model : model,
      primary_provider: primaryPass.provider,
      primary_model: primaryPass.model,
      secondary_provider: secondaryPass ? secondaryPass.provider : null,
      secondary_model: secondaryPass ? secondaryPass.model : null,
      escalation_applied: Boolean(secondaryPass),
      escalation_selected_secondary: Boolean(secondaryPass && selectedPass.selectedSecondary),
      escalation_reasons: escalateDecision.reasons,
      decision: normalized.decision,
      confidence: round4(normalized.confidence),
      violations: Array.isArray(normalized.violations) ? normalized.violations : [],
      risk_reasons: candidate.risk_reasons,
      notes: normalized.notes || null,
      corrected_boxes: corrected,
      validator_repairs: correctedPack.validator_repairs,
      ...correctionStats,
      error: selectedPass.selected ? selectedPass.selected.error : null,
      parse_error: selectedPass.selected ? selectedPass.selected.parse_error : null,
      primary_decision: primaryPass.normalized ? primaryPass.normalized.decision : null,
      primary_confidence: primaryPass.normalized ? round4(primaryPass.normalized.confidence) : null,
      primary_error: primaryPass.error,
      primary_parse_error: primaryPass.parse_error,
      secondary_decision: secondaryPass && secondaryPass.normalized ? secondaryPass.normalized.decision : null,
      secondary_confidence: secondaryPass && secondaryPass.normalized ? round4(secondaryPass.normalized.confidence) : null,
      secondary_error: secondaryPass ? secondaryPass.error : null,
      secondary_parse_error: secondaryPass ? secondaryPass.parse_error : null,
    });

    if (processed === 1 || processed === selected.length || (processed % progressEvery) === 0) {
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
      const avgSec = processed > 0 ? (elapsedSec / processed) : 0;
      const etaSec = Math.max(0, Math.round((selected.length - processed) * avgSec));
      const primaryDecision = primaryPass && primaryPass.normalized ? String(primaryPass.normalized.decision || '') : 'unknown';
      const secondaryDecision = secondaryPass && secondaryPass.normalized ? String(secondaryPass.normalized.decision || '') : 'none';
      const selectedBy = selectedPass.selectedSecondary ? 'secondary' : 'primary';
      const secondaryError = secondaryPass && (secondaryPass.error || secondaryPass.parse_error) ? 'yes' : 'no';
      process.stderr.write(
        `[llm_qc_progress] ${processed}/${selected.length} elapsed=${elapsedSec}s eta=${etaSec}s sample=${candidate.sample_hash}:${candidate.side} primary=${primaryDecision} secondary=${secondaryDecision} selected=${selectedBy} secondary_error=${secondaryError}\n`,
      );
    }
  }

  const decisionCounts = results.reduce((acc, row) => {
    const key = String(row.decision || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const correctedSides = results.filter((row) => Number(row.corrected_modules_count) > 0).length;
  const validatorRepairSides = results.filter((row) => Array.isArray(row.validator_repairs) && row.validator_repairs.length > 0).length;
  const escalatedTotal = results.filter((row) => Boolean(row.escalation_applied)).length;
  const escalationSelectedSecondaryTotal = results.filter((row) => Boolean(row.escalation_selected_secondary)).length;
  const escalationErrorTotal = results.filter((row) => Boolean(row.secondary_error || row.secondary_parse_error)).length;
  const summary = {
    ok: true,
    provider,
    model,
    escalation: {
      enabled: escalateEnabled,
      provider: escalateProvider,
      model: escalateModel,
      min_confidence: escalateMinConfidence,
      min_risk_reasons: escalateMinRiskReasons,
      on_decisions: Array.from(escalateOnDecisionSet),
      if_error: escalateIfError,
      escalated_total: escalatedTotal,
      selected_secondary_total: escalationSelectedSecondaryTotal,
      secondary_error_total: escalationErrorTotal,
    },
    manifest_path: manifestPath,
    out_dir: outDir,
    dry_run: dryRun,
    risk_only: riskOnly,
    thresholds,
    side,
    rows_total: rows.length,
    candidates_total: candidates.length,
    processed_total: results.length,
    decision_counts: decisionCounts,
    corrected_sides: correctedSides,
    corrected_rate: results.length ? round4(correctedSides / results.length) : 0,
    validator_repair_sides: validatorRepairSides,
    validator_repair_rate: results.length ? round4(validatorRepairSides / results.length) : 0,
  };

  const resultsPath = path.join(outDir, 'llm_qc_results.jsonl');
  const summaryPath = path.join(outDir, 'llm_qc_summary.json');
  await fs.writeFile(
    resultsPath,
    `${results.map((row) => JSON.stringify(row)).join('\n')}${results.length ? '\n' : ''}`,
    'utf8',
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  let correctedManifestPath = null;
  let finalManifestPath = null;
  let correctedManifest = null;
  if (writeCorrectedManifest || writeFinalManifest) {
    const resultsByKey = new Map();
    for (const row of results) {
      resultsByKey.set(`${row.sample_hash}:${row.side}`, row);
    }
    correctedManifest = applyCorrectionsToManifest(manifest, resultsByKey);
  }
  if (writeCorrectedManifest && correctedManifest) {
    correctedManifestPath = path.join(outDir, 'manifest.corrected_by_llm_qc.json');
    await fs.writeFile(correctedManifestPath, `${JSON.stringify(correctedManifest, null, 2)}\n`, 'utf8');
  }
  if (writeFinalManifest && correctedManifest) {
    finalManifestPath = path.join(outDir, 'manifest.final_with_llm_qc.json');
    await fs.writeFile(finalManifestPath, `${JSON.stringify(correctedManifest, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    ...summary,
    artifacts: {
      results_jsonl: resultsPath,
      summary_json: summaryPath,
      corrected_manifest_json: correctedManifestPath,
      final_manifest_json: finalManifestPath,
    },
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`llm_module_box_qc_poc failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});
