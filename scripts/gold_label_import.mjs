#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sha256Hex, runTimestampKey } from './internal_batch_helpers.mjs';

const require = createRequire(import.meta.url);
const {
  polygonNormToMask,
  orMaskInto,
  encodeRleBinary,
  countOnes,
  intersectionCount,
} = require('../src/auroraBff/evalAdapters/common/metrics');

const CORE_LABELS = ['face_oval', 'skin', 'hair', 'background'];
const MODULE_LABELS = ['nose', 'forehead', 'left_cheek', 'right_cheek', 'chin', 'under_eye_left', 'under_eye_right'];
const STRONG_MODULES = new Set(['nose', 'forehead', 'left_cheek', 'right_cheek', 'chin']);
const WEAK_MODULES = new Set(['under_eye_left', 'under_eye_right']);
const TARGET_LABELS = [...CORE_LABELS, ...MODULE_LABELS];
const DEFAULT_GRID_SIZE = 256;
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_QC_MIN_MASK_PIXELS = 12;
const DEFAULT_QC_FOREHEAD_HAIR_OVERLAP_WARN = 0.6;

const HELP_TEXT = `gold_label_import.mjs

Usage:
  node scripts/gold_label_import.mjs --in <label_studio_export.json|jsonl> [options]

Required:
  --in <path>                             Label Studio export file

Optional:
  --out <path>                            output NDJSON (default: artifacts/gold_labels.ndjson)
  --qa_status <status>                    qa status tag (default: approved)
  --annotator <id>                        fallback annotator id when export has none
  --grid_size <n>                         mask grid size (default: 256)
  --report_dir <dir>                      QC report directory (default: reports)
  --run_id <id>                           run id for QC report naming
  --all_annotations <bool>                import all annotations per task (default: false)
  --qc_min_mask_pixels <n>                QC_WARN threshold for tiny masks (default: 12)
  --qc_forehead_hair_overlap_warn <0-1>   QC_WARN threshold for forehead-hair overlap (default: 0.6)
  --qc_jsonl <path>                       explicit QC jsonl output path
  --qc_md <path>                          explicit QC markdown output path
  --help                                  show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseArgs(argv) {
  const out = {
    help: 'false',
    in: '',
    out: path.join('artifacts', 'gold_labels.ndjson'),
    qa_status: 'approved',
    annotator: '',
    grid_size: process.env.GOLD_IMPORT_GRID || DEFAULT_GRID_SIZE,
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    run_id: process.env.RUN_ID || '',
    all_annotations: process.env.GOLD_IMPORT_ALL_ANNOTATIONS || 'false',
    qc_min_mask_pixels: process.env.GOLD_IMPORT_QC_MIN_MASK_PIXELS || DEFAULT_QC_MIN_MASK_PIXELS,
    qc_forehead_hair_overlap_warn:
      process.env.GOLD_IMPORT_QC_FOREHEAD_HAIR_OVERLAP_WARN || DEFAULT_QC_FOREHEAD_HAIR_OVERLAP_WARN,
    qc_jsonl: process.env.GOLD_IMPORT_QC_JSONL || '',
    qc_md: process.env.GOLD_IMPORT_QC_MD || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = 'true';
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }
  out.help = parseBool(out.help, false);
  out.in = String(out.in || '').trim();
  out.out = String(out.out || '').trim() || path.join('artifacts', 'gold_labels.ndjson');
  out.qa_status = String(out.qa_status || 'approved').trim() || 'approved';
  out.annotator = String(out.annotator || '').trim();
  out.grid_size = Math.max(64, Math.min(512, Math.trunc(Number(out.grid_size) || DEFAULT_GRID_SIZE)));
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.run_id = String(out.run_id || '').trim();
  out.all_annotations = parseBool(out.all_annotations, false);
  out.qc_min_mask_pixels = Math.max(0, Math.min(1024, Math.trunc(Number(out.qc_min_mask_pixels) || DEFAULT_QC_MIN_MASK_PIXELS)));
  out.qc_forehead_hair_overlap_warn = Math.max(
    0,
    Math.min(1, Number(out.qc_forehead_hair_overlap_warn) || DEFAULT_QC_FOREHEAD_HAIR_OVERLAP_WARN),
  );
  out.qc_jsonl = String(out.qc_jsonl || '').trim();
  out.qc_md = String(out.qc_md || '').trim();
  return out;
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function inferRunId(inputPath, explicitRunId = '') {
  if (explicitRunId) return explicitRunId;
  const file = path.basename(String(inputPath || ''));
  const patterns = [
    /label_studio_export_round1_(\d{15}|\d{8}_\d{6,9})\.(json|jsonl|ndjson)$/i,
    /round1_(\d{15}|\d{8}_\d{6,9})/i,
    /(?:export|labels?)_(\d{15}|\d{8}_\d{6,9})/i,
  ];
  for (const pattern of patterns) {
    const match = file.match(pattern);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toCanonicalLabel(raw) {
  const tokenRaw = String(raw || '').trim().toLowerCase();
  if (!tokenRaw) return null;
  const token = tokenRaw
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/__+/g, '_');
  if (['face_oval', 'face', 'oval', 'faceoval'].includes(token)) return 'face_oval';
  if (token === 'skin') return 'skin';
  if (token === 'hair') return 'hair';
  if (['background', 'bg', 'backdrop'].includes(token)) return 'background';
  if (['nose'].includes(token)) return 'nose';
  if (['forehead', 'fore_head'].includes(token)) return 'forehead';
  if (['left_cheek', 'leftcheek', 'cheek_left'].includes(token)) return 'left_cheek';
  if (['right_cheek', 'rightcheek', 'cheek_right'].includes(token)) return 'right_cheek';
  if (['chin'].includes(token)) return 'chin';
  if (['under_eye_left', 'undereye_left', 'left_under_eye', 'under_eye_l'].includes(token)) return 'under_eye_left';
  if (['under_eye_right', 'undereye_right', 'right_under_eye', 'under_eye_r'].includes(token)) return 'under_eye_right';
  return null;
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const j = (i + 1) % points.length;
    const x1 = Number(points[i].x || 0);
    const y1 = Number(points[i].y || 0);
    const x2 = Number(points[j].x || 0);
    const y2 = Number(points[j].y || 0);
    area += (x1 * y2) - (x2 * y1);
  }
  return Math.abs(area / 2);
}

function pointFromRaw(raw) {
  if (Array.isArray(raw) && raw.length >= 2) {
    return { x: Number(raw[0]), y: Number(raw[1]) };
  }
  if (raw && typeof raw === 'object') {
    if ('x' in raw && 'y' in raw) return { x: Number(raw.x), y: Number(raw.y) };
    if ('X' in raw && 'Y' in raw) return { x: Number(raw.X), y: Number(raw.Y) };
  }
  return null;
}

function normalizePolygonPoints(rawPoints, width, height) {
  const points = Array.isArray(rawPoints) ? rawPoints.map(pointFromRaw).filter(Boolean) : [];
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x).filter((v) => Number.isFinite(v));
  const ys = points.map((p) => p.y).filter((v) => Number.isFinite(v));
  if (xs.length < 3 || ys.length < 3) return null;

  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  let mode = 'unknown';
  if (maxX <= 1.001 && maxY <= 1.001 && minX >= -0.001 && minY >= -0.001) mode = 'normalized';
  else if (maxX <= 100.001 && maxY <= 100.001 && minX >= -0.001 && minY >= -0.001) mode = 'percent';
  else if (width > 1 && height > 1) mode = 'pixel';
  else return null;

  const out = [];
  for (const point of points) {
    let nx = null;
    let ny = null;
    if (mode === 'normalized') {
      nx = point.x;
      ny = point.y;
    } else if (mode === 'percent') {
      nx = point.x / 100;
      ny = point.y / 100;
    } else {
      nx = point.x / width;
      ny = point.y / height;
    }
    nx = clamp01(nx);
    ny = clamp01(ny);
    if (nx == null || ny == null) continue;
    out.push({ x: Number(nx.toFixed(6)), y: Number(ny.toFixed(6)) });
  }
  if (out.length < 3) return null;
  if (polygonArea(out) <= 1e-7) return null;
  return out;
}

function onSegment(a, b, c) {
  return (
    Math.min(a.x, c.x) <= b.x + 1e-9
    && b.x <= Math.max(a.x, c.x) + 1e-9
    && Math.min(a.y, c.y) <= b.y + 1e-9
    && b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function orientation(a, b, c) {
  const val = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if (Math.abs(val) <= 1e-9) return 0;
  return val > 0 ? 1 : 2;
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function polygonHasSelfIntersection(points) {
  if (!Array.isArray(points) || points.length < 4) return false;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      const adjacent = j === i || j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function taskImagePath(taskData) {
  const localPath = String(taskData.local_path || taskData.image_path || '').trim();
  if (localPath) return localPath;
  const image = String(taskData.image || '').trim();
  if (image.startsWith('file://')) return image.slice('file://'.length);
  if (image.startsWith('/')) return image;
  return '';
}

function extractTaskRows(inputPath, rawText) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') {
    return String(rawText)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  }
  const parsed = JSON.parse(rawText);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
  return [];
}

function sortAnnotations(annotations) {
  const candidates = Array.isArray(annotations) ? annotations.filter((item) => item && typeof item === 'object') : [];
  if (!candidates.length) return [];
  return [...candidates].sort((a, b) => {
    const aCount = Array.isArray(a.result) ? a.result.length : 0;
    const bCount = Array.isArray(b.result) ? b.result.length : 0;
    if (aCount !== bCount) return bCount - aCount;
    const aTs = Date.parse(String(a.updated_at || a.created_at || '')) || 0;
    const bTs = Date.parse(String(b.updated_at || b.created_at || '')) || 0;
    return bTs - aTs;
  });
}

function isDoubleAnnotatedTask(task) {
  const taskMeta = task && typeof task.meta === 'object' ? task.meta : {};
  const taskMetadata = task && typeof task.metadata === 'object' ? task.metadata : {};
  const taskData = task && typeof task.data === 'object' ? task.data : {};
  const explicit = (
    parseBool(taskMeta.double_annotate, false)
    || parseBool(taskMetadata.double_annotate, false)
    || parseBool(taskData.double_annotate, false)
  );
  const annCount = Array.isArray(task && task.annotations) ? task.annotations.length : 0;
  return explicit || annCount > 1;
}

function unionPolygonMasks(polygons, gridSize) {
  const out = new Uint8Array(gridSize * gridSize);
  for (const points of polygons) {
    const mask = polygonNormToMask({ points, closed: true }, gridSize, gridSize);
    orMaskInto(out, mask);
  }
  return out;
}

function maskPayload(mask, gridSize) {
  if (!(mask instanceof Uint8Array)) return null;
  const pixels = countOnes(mask);
  return {
    grid_size: gridSize,
    pixels,
    rle_norm: encodeRleBinary(mask),
  };
}

function resolveLabelToken(result) {
  if (!result || typeof result !== 'object') return null;
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const polyLabels = Array.isArray(value.polygonlabels) ? value.polygonlabels : [];
  if (polyLabels.length) return toCanonicalLabel(polyLabels[0]);
  const brushLabels = Array.isArray(value.brushlabels) ? value.brushlabels : [];
  if (brushLabels.length) return toCanonicalLabel(brushLabels[0]);
  if (result.from_name) return toCanonicalLabel(result.from_name);
  return null;
}

function resolveAnnotatorRaw(annotation, fallbackAnnotator = '') {
  if (fallbackAnnotator) return fallbackAnnotator;
  const ann = annotation && typeof annotation === 'object' ? annotation : {};
  const candidates = [];
  if (typeof ann.completed_by === 'string' || typeof ann.completed_by === 'number') candidates.push(String(ann.completed_by));
  if (ann.completed_by && typeof ann.completed_by === 'object') {
    const obj = ann.completed_by;
    for (const key of ['email', 'username', 'id', 'first_name', 'last_name']) {
      if (obj[key] != null && String(obj[key]).trim()) candidates.push(String(obj[key]));
    }
  }
  if (ann.user && typeof ann.user === 'object') {
    const obj = ann.user;
    for (const key of ['email', 'username', 'id']) {
      if (obj[key] != null && String(obj[key]).trim()) candidates.push(String(obj[key]));
    }
  }
  for (const key of ['completed_by_id', 'created_username', 'created_by', 'updated_by', 'annotator']) {
    const value = ann[key];
    if (value != null && String(value).trim()) candidates.push(String(value));
  }
  const merged = candidates.map((item) => item.trim()).filter(Boolean);
  return merged[0] || 'unknown_annotator';
}

function anonymizeAnnotator(raw) {
  const token = String(raw || '').trim();
  if (!token) return 'ann_unknown';
  return `ann_${sha256Hex(token).slice(0, 12)}`;
}

function resolveAnnotationId(annotation, taskId, sampleHash, annotatorId) {
  const ann = annotation && typeof annotation === 'object' ? annotation : {};
  for (const key of ['id', 'annotation_id', 'pk']) {
    const value = ann[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  const base = JSON.stringify({
    task_id: taskId || null,
    sample_hash: sampleHash,
    annotator_id: annotatorId,
    created_at: ann.created_at || ann.updated_at || null,
    result_len: Array.isArray(ann.result) ? ann.result.length : 0,
  });
  return `ann_${sha256Hex(base).slice(0, 16)}`;
}

function normalizeSingleTask(task, annotation, options) {
  const data = task && typeof task.data === 'object' ? task.data : {};
  const imagePath = taskImagePath(data);
  const source = String(data.source || data.dataset || task.source || 'unknown').trim().toLowerCase() || 'unknown';
  const sampleHashRaw = String(data.sample_hash || task.sample_hash || '').trim();
  const sampleHash = sampleHashRaw || sha256Hex(`${source}:${imagePath || JSON.stringify(data)}`).slice(0, 24);
  const taskId = String(task && task.id != null ? task.id : '').trim() || null;
  const isDoubleAnnotated = isDoubleAnnotatedTask(task);

  if (!annotation || typeof annotation !== 'object') {
    return {
      row: null,
      skipped_reason: 'NO_ANNOTATION',
      sample_hash: sampleHash,
      task_id: taskId,
      annotation_id: null,
      annotator_id: null,
      qc_status: 'SKIPPED',
      qc_flags: [],
      unsupported_brush_count: 0,
    };
  }

  const createdAt = String(annotation.updated_at || annotation.created_at || new Date().toISOString());
  const annotatorRaw = resolveAnnotatorRaw(annotation, options.annotator);
  const annotatorId = anonymizeAnnotator(annotatorRaw);
  const annotationId = resolveAnnotationId(annotation, taskId, sampleHash, annotatorId);

  const labelPolygons = new Map();
  let unsupportedBrushCount = 0;
  const qcFlags = [];
  const results = Array.isArray(annotation.result) ? annotation.result : [];
  for (let idx = 0; idx < results.length; idx += 1) {
    const result = results[idx];
    if (!result || typeof result !== 'object') continue;
    const resultType = String(result.type || '').trim().toLowerCase();
    const labelToken = resolveLabelToken(result);
    if (!labelToken || !TARGET_LABELS.includes(labelToken)) continue;
    if (resultType !== 'polygonlabels' && resultType !== 'polygon') {
      if (resultType === 'brushlabels' || resultType === 'brush') {
        unsupportedBrushCount += 1;
        qcFlags.push({
          level: 'WARN',
          code: 'BRUSH_LABEL_UNSUPPORTED',
          label: labelToken,
          result_index: idx,
        });
      }
      continue;
    }
    const value = result.value && typeof result.value === 'object' ? result.value : {};
    const width = Number(value.original_width || result.original_width || data.original_width || data.width || 0);
    const height = Number(value.original_height || result.original_height || data.original_height || data.height || 0);
    const normalized = normalizePolygonPoints(value.points, width, height);
    if (!normalized) {
      qcFlags.push({
        level: 'WARN',
        code: 'INVALID_POLYGON_GEOMETRY',
        label: labelToken,
        result_index: idx,
      });
      continue;
    }
    if (polygonHasSelfIntersection(normalized)) {
      qcFlags.push({
        level: 'FAIL',
        code: 'POLYGON_SELF_INTERSECTION',
        label: labelToken,
        result_index: idx,
      });
    }
    const area = polygonArea(normalized);
    const list = labelPolygons.get(labelToken) || [];
    list.push({ points: normalized, area });
    labelPolygons.set(labelToken, list);
  }

  if (!labelPolygons.size) {
    return {
      row: null,
      skipped_reason: unsupportedBrushCount > 0 ? 'ONLY_BRUSH_UNSUPPORTED' : 'NO_VALID_POLYGONS',
      sample_hash: sampleHash,
      task_id: taskId,
      annotation_id: annotationId,
      annotator_id: annotatorId,
      qc_status: 'SKIPPED',
      qc_flags: qcFlags,
      unsupported_brush_count: unsupportedBrushCount,
    };
  }

  const labels = {};
  for (const target of TARGET_LABELS) {
    const polygons = labelPolygons.get(target);
    if (!polygons || !polygons.length) continue;
    const sorted = [...polygons].sort((a, b) => b.area - a.area);
    labels[target] = {
      type: 'polygon',
      points_norm: sorted[0].points,
      polygons_norm: sorted.map((item) => item.points),
    };
  }

  const faceMask = labels.face_oval ? unionPolygonMasks(labels.face_oval.polygons_norm, options.grid_size) : null;
  const skinMask = labels.skin ? unionPolygonMasks(labels.skin.polygons_norm, options.grid_size) : null;
  const hairMask = labels.hair ? unionPolygonMasks(labels.hair.polygons_norm, options.grid_size) : null;
  const bgMask = labels.background ? unionPolygonMasks(labels.background.polygons_norm, options.grid_size) : null;

  const moduleMasks = {};
  for (const moduleId of MODULE_LABELS) {
    const moduleLabel = labels[moduleId];
    if (!moduleLabel) continue;
    const moduleMask = unionPolygonMasks(moduleLabel.polygons_norm, options.grid_size);
    moduleMasks[moduleId] = {
      ...maskPayload(moduleMask, options.grid_size),
      gt_kind: STRONG_MODULES.has(moduleId) ? 'strong' : 'weak',
    };
  }

  const strongModulesPresent = Object.keys(moduleMasks).filter((moduleId) => STRONG_MODULES.has(moduleId));
  const weakModulesPresent = Object.keys(moduleMasks).filter((moduleId) => WEAK_MODULES.has(moduleId));

  const corePayloads = {
    face_oval_mask: maskPayload(faceMask, options.grid_size),
    skin_mask: maskPayload(skinMask, options.grid_size),
    hair_mask: maskPayload(hairMask, options.grid_size),
    background_mask: maskPayload(bgMask, options.grid_size),
  };

  const tinyMaskEntries = [];
  for (const [field, payload] of Object.entries(corePayloads)) {
    if (!payload || !Number.isFinite(Number(payload.pixels))) continue;
    if (Number(payload.pixels) < options.qc_min_mask_pixels) {
      tinyMaskEntries.push({ field, pixels: Number(payload.pixels) });
      qcFlags.push({
        level: 'WARN',
        code: 'MASK_TOO_SMALL',
        field,
        pixels: Number(payload.pixels),
        threshold: options.qc_min_mask_pixels,
      });
    }
  }
  for (const [moduleId, payload] of Object.entries(moduleMasks)) {
    const pixels = Number(payload && payload.pixels);
    if (!Number.isFinite(pixels)) continue;
    if (pixels < options.qc_min_mask_pixels) {
      tinyMaskEntries.push({ field: `module_masks.${moduleId}`, pixels });
      qcFlags.push({
        level: 'WARN',
        code: 'MASK_TOO_SMALL',
        field: `module_masks.${moduleId}`,
        pixels,
        threshold: options.qc_min_mask_pixels,
      });
    }
  }

  let foreheadHairOverlapRate = null;
  if (moduleMasks.forehead && moduleMasks.forehead.rle_norm && corePayloads.hair_mask && corePayloads.hair_mask.rle_norm) {
    const foreheadMask = unionPolygonMasks(labels.forehead ? labels.forehead.polygons_norm : [], options.grid_size);
    const hairMaskDecoded = unionPolygonMasks(labels.hair ? labels.hair.polygons_norm : [], options.grid_size);
    const foreheadPixels = countOnes(foreheadMask);
    if (foreheadPixels > 0) {
      foreheadHairOverlapRate = intersectionCount(foreheadMask, hairMaskDecoded) / foreheadPixels;
      if (foreheadHairOverlapRate > options.qc_forehead_hair_overlap_warn) {
        qcFlags.push({
          level: 'WARN',
          code: 'FOREHEAD_HAIR_OVERLAP_HIGH',
          overlap_rate: round3(foreheadHairOverlapRate),
          threshold: options.qc_forehead_hair_overlap_warn,
        });
      }
    }
  }

  const failCount = qcFlags.filter((flag) => String(flag.level).toUpperCase() === 'FAIL').length;
  const warnCount = qcFlags.filter((flag) => String(flag.level).toUpperCase() === 'WARN').length;
  const qcStatus = failCount > 0 ? 'QC_FAIL' : warnCount > 0 ? 'QC_WARN' : 'QC_PASS';

  return {
    row: {
      schema_version: 'aurora.gold_labels.v2',
      sample_hash: sampleHash,
      source,
      image_path: imagePath ? toPosix(imagePath) : null,
      qa_status: options.qa_status,
      grid_size: options.grid_size,
      labels,
      ...corePayloads,
      module_masks: moduleMasks,
      module_gt: {
        strong_modules: Array.from(STRONG_MODULES),
        weak_modules: Array.from(WEAK_MODULES),
        strong_modules_present: strongModulesPresent,
        weak_modules_present: weakModulesPresent,
      },
      annotator_id: annotatorId,
      annotation_id: annotationId,
      created_at: createdAt,
      is_double_annotated: isDoubleAnnotated,
      qc_status: qcStatus,
      qc_warn_count: warnCount,
      qc_fail_count: failCount,
      qc_flags: qcFlags,
      forehead_hair_overlap_rate: round3(foreheadHairOverlapRate),
      meta: {
        annotator: annotatorId,
        created_at: createdAt,
        annotation_id: annotationId,
        tool: 'label_studio',
        task_id: taskId,
        unsupported_brush_count: unsupportedBrushCount,
        is_double_annotated: isDoubleAnnotated,
        tiny_mask_entries: tinyMaskEntries,
      },
    },
    skipped_reason: null,
    sample_hash: sampleHash,
    task_id: taskId,
    annotation_id: annotationId,
    annotator_id: annotatorId,
    qc_status: qcStatus,
    qc_flags: qcFlags,
    unsupported_brush_count: unsupportedBrushCount,
  };
}

function summarizeQcCodeCounts(records) {
  const counts = new Map();
  for (const record of records) {
    const flags = Array.isArray(record.qc_flags) ? record.qc_flags : [];
    for (const flag of flags) {
      const key = `${String(flag.level || 'WARN').toUpperCase()}:${String(flag.code || 'UNKNOWN')}`;
      counts.set(key, Number(counts.get(key) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([key, count]) => {
      const [level, code] = key.split(':');
      return { level, code, count };
    })
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function buildQcMarkdown({ runId, inputPath, outPath, records, skippedCounts, files }) {
  const imported = records.filter((row) => row.qc_status !== 'SKIPPED');
  const passCount = imported.filter((row) => row.qc_status === 'QC_PASS').length;
  const warnCount = imported.filter((row) => row.qc_status === 'QC_WARN').length;
  const failCount = imported.filter((row) => row.qc_status === 'QC_FAIL').length;
  const codeRows = summarizeQcCodeCounts(records);
  const failRows = imported
    .filter((row) => row.qc_status === 'QC_FAIL')
    .slice(0, 50);
  const warnRows = imported
    .filter((row) => row.qc_status === 'QC_WARN')
    .slice(0, 50);

  const lines = [];
  lines.push('# Gold Import QC Report');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- input: \`${toPosix(path.relative(process.cwd(), inputPath))}\``);
  lines.push(`- output_ndjson: \`${toPosix(path.relative(process.cwd(), outPath))}\``);
  lines.push(`- imported_rows: ${imported.length}`);
  lines.push(`- qc_pass: ${passCount}`);
  lines.push(`- qc_warn: ${warnCount}`);
  lines.push(`- qc_fail: ${failCount}`);
  lines.push('');

  lines.push('## Skip Summary');
  lines.push('');
  lines.push('| skipped_reason | count |');
  lines.push('|---|---:|');
  const skipEntries = Object.entries(skippedCounts || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!skipEntries.length) {
    lines.push('| - | 0 |');
  } else {
    for (const [reason, count] of skipEntries) {
      lines.push(`| ${reason} | ${count} |`);
    }
  }
  lines.push('');

  lines.push('## QC Flags');
  lines.push('');
  lines.push('| level | code | count |');
  lines.push('|---|---|---:|');
  if (!codeRows.length) {
    lines.push('| - | - | 0 |');
  } else {
    for (const row of codeRows) {
      lines.push(`| ${row.level} | ${row.code} | ${row.count} |`);
    }
  }
  lines.push('');

  lines.push('## QC_FAIL Rows (Top 50)');
  lines.push('');
  lines.push('| sample_hash | source | task_id | annotation_id | annotator_id | qc_fail_count | qc_warn_count |');
  lines.push('|---|---|---|---|---|---:|---:|');
  if (!failRows.length) {
    lines.push('| - | - | - | - | - | 0 | 0 |');
  } else {
    for (const row of failRows) {
      lines.push(
        `| ${row.sample_hash || '-'} | ${row.source || '-'} | ${row.task_id || '-'} | ${row.annotation_id || '-'} | ${row.annotator_id || '-'} | ${row.qc_fail_count || 0} | ${row.qc_warn_count || 0} |`,
      );
    }
  }
  lines.push('');

  lines.push('## QC_WARN Rows (Top 50)');
  lines.push('');
  lines.push('| sample_hash | source | task_id | annotation_id | annotator_id | qc_fail_count | qc_warn_count |');
  lines.push('|---|---|---|---|---|---:|---:|');
  if (!warnRows.length) {
    lines.push('| - | - | - | - | - | 0 | 0 |');
  } else {
    for (const row of warnRows) {
      lines.push(
        `| ${row.sample_hash || '-'} | ${row.source || '-'} | ${row.task_id || '-'} | ${row.annotation_id || '-'} | ${row.annotator_id || '-'} | ${row.qc_fail_count || 0} | ${row.qc_warn_count || 0} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- qc_jsonl: \`${files.qcJsonlRel}\``);
  lines.push(`- qc_md: \`${files.qcMdRel}\``);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.in) {
    process.stderr.write('gold_label_import: missing --in\n');
    process.exit(2);
    return;
  }
  const inputPath = path.resolve(args.in);
  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`gold_label_import: input not found: ${inputPath}\n`);
    process.exit(2);
    return;
  }

  const runId = inferRunId(inputPath, args.run_id);
  const rawText = await fsp.readFile(inputPath, 'utf8');
  const tasks = extractTaskRows(inputPath, rawText);

  const rows = [];
  const qcRecords = [];
  const skipped = {};

  for (const task of tasks) {
    const sortedAnnotations = sortAnnotations(task && task.annotations);
    const selectedAnnotations = args.all_annotations ? sortedAnnotations : sortedAnnotations.slice(0, 1);

    if (!selectedAnnotations.length) {
      const fallback = normalizeSingleTask(task, null, args);
      const reason = fallback.skipped_reason || 'NO_ANNOTATION';
      skipped[reason] = Number(skipped[reason] || 0) + 1;
      qcRecords.push({
        sample_hash: fallback.sample_hash || null,
        source: task && task.data && task.data.source ? String(task.data.source) : null,
        task_id: fallback.task_id || null,
        annotation_id: null,
        annotator_id: null,
        qc_status: 'SKIPPED',
        qc_warn_count: 0,
        qc_fail_count: 0,
        qc_flags: [],
        unsupported_brush_count: 0,
        skipped_reason: reason,
      });
      continue;
    }

    for (const annotation of selectedAnnotations) {
      const normalized = normalizeSingleTask(task, annotation, args);
      if (!normalized.row) {
        const reason = normalized.skipped_reason || 'UNKNOWN';
        skipped[reason] = Number(skipped[reason] || 0) + 1;
        qcRecords.push({
          sample_hash: normalized.sample_hash || null,
          source: task && task.data && task.data.source ? String(task.data.source) : null,
          task_id: normalized.task_id || null,
          annotation_id: normalized.annotation_id || null,
          annotator_id: normalized.annotator_id || null,
          qc_status: 'SKIPPED',
          qc_warn_count: 0,
          qc_fail_count: 0,
          qc_flags: normalized.qc_flags || [],
          unsupported_brush_count: Number(normalized.unsupported_brush_count || 0),
          skipped_reason: reason,
        });
        continue;
      }

      rows.push(normalized.row);
      qcRecords.push({
        sample_hash: normalized.row.sample_hash,
        source: normalized.row.source,
        task_id: normalized.row.meta && normalized.row.meta.task_id ? normalized.row.meta.task_id : null,
        annotation_id: normalized.row.annotation_id,
        annotator_id: normalized.row.annotator_id,
        created_at: normalized.row.created_at,
        is_double_annotated: Boolean(normalized.row.is_double_annotated),
        qc_status: normalized.row.qc_status,
        qc_warn_count: Number(normalized.row.qc_warn_count || 0),
        qc_fail_count: Number(normalized.row.qc_fail_count || 0),
        qc_flags: normalized.row.qc_flags || [],
        unsupported_brush_count: Number(
          normalized.row.meta && Number.isFinite(Number(normalized.row.meta.unsupported_brush_count))
            ? Number(normalized.row.meta.unsupported_brush_count)
            : 0,
        ),
        forehead_hair_overlap_rate: normalized.row.forehead_hair_overlap_rate,
        skipped_reason: null,
      });
    }
  }

  const outPath = path.resolve(args.out);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(outPath, payload, 'utf8');

  const qcReportDir = path.resolve(args.report_dir);
  await fsp.mkdir(qcReportDir, { recursive: true });
  const qcJsonlPath = path.resolve(args.qc_jsonl || path.join(qcReportDir, `gold_import_qc_${runId}.jsonl`));
  const qcMdPath = path.resolve(args.qc_md || path.join(qcReportDir, `gold_import_qc_${runId}.md`));

  const qcJsonlPayload = qcRecords.length ? `${qcRecords.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(qcJsonlPath, qcJsonlPayload, 'utf8');

  const qcMarkdown = buildQcMarkdown({
    runId,
    inputPath,
    outPath,
    records: qcRecords,
    skippedCounts: skipped,
    files: {
      qcJsonlRel: toPosix(path.relative(process.cwd(), qcJsonlPath)),
      qcMdRel: toPosix(path.relative(process.cwd(), qcMdPath)),
    },
  });
  await fsp.writeFile(qcMdPath, qcMarkdown, 'utf8');

  const labelCoverage = TARGET_LABELS.reduce((acc, key) => {
    acc[key] = rows.filter((row) => row.labels && row.labels[key]).length;
    return acc;
  }, {});
  const importedRows = qcRecords.filter((row) => row.qc_status !== 'SKIPPED');
  const summary = {
    ok: true,
    run_id: runId,
    input: toPosix(path.relative(process.cwd(), inputPath)),
    output: toPosix(path.relative(process.cwd(), outPath)),
    total_tasks: tasks.length,
    imported_rows: rows.length,
    imported_annotations: importedRows.length,
    skipped,
    grid_size: args.grid_size,
    all_annotations: args.all_annotations,
    label_coverage: labelCoverage,
    strong_module_rows: rows.filter((row) => row.module_gt && Array.isArray(row.module_gt.strong_modules_present) && row.module_gt.strong_modules_present.length > 0).length,
    weak_under_eye_rows: rows.filter((row) => row.module_gt && Array.isArray(row.module_gt.weak_modules_present) && row.module_gt.weak_modules_present.length > 0).length,
    qc: {
      pass: importedRows.filter((row) => row.qc_status === 'QC_PASS').length,
      warn: importedRows.filter((row) => row.qc_status === 'QC_WARN').length,
      fail: importedRows.filter((row) => row.qc_status === 'QC_FAIL').length,
      report_md: toPosix(path.relative(process.cwd(), qcMdPath)),
      report_jsonl: toPosix(path.relative(process.cwd(), qcJsonlPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gold_label_import_failed: ${error.message}\n`);
  process.exit(1);
});
