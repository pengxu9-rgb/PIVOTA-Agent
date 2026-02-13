#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from './internal_batch_helpers.mjs';

const TARGET_LABELS = ['face_oval', 'skin', 'hair', 'background'];

function parseArgs(argv) {
  const out = {
    in: '',
    out: path.join('artifacts', 'gold_labels.ndjson'),
    qa_status: 'approved',
    annotator: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
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
  out.in = String(out.in || '').trim();
  out.out = String(out.out || '').trim() || path.join('artifacts', 'gold_labels.ndjson');
  out.qa_status = String(out.qa_status || 'approved').trim() || 'approved';
  out.annotator = String(out.annotator || '').trim();
  return out;
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeLabelToken(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return null;
  if (['face_oval', 'face', 'oval', 'faceoval'].includes(token)) return 'face_oval';
  if (['skin'].includes(token)) return 'skin';
  if (['hair'].includes(token)) return 'hair';
  if (['background', 'bg', 'backdrop'].includes(token)) return 'background';
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

function normalizeSingleTask(task, options) {
  const data = task && typeof task.data === 'object' ? task.data : {};
  const annotations = Array.isArray(task && task.annotations) ? task.annotations : [];
  const imagePath = taskImagePath(data);
  const source = String(data.source || data.dataset || task.source || 'unknown').trim().toLowerCase() || 'unknown';
  const sampleHashRaw = String(data.sample_hash || task.sample_hash || '').trim();
  const sampleHash = sampleHashRaw || sha256Hex(`${source}:${imagePath || JSON.stringify(data)}`).slice(0, 24);

  const labelPolygons = new Map();
  let annotatorId = options.annotator || '';
  let createdAt = new Date().toISOString();

  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== 'object') continue;
    if (!annotatorId) {
      if (typeof annotation.completed_by === 'string') annotatorId = annotation.completed_by;
      if (annotation.completed_by && typeof annotation.completed_by === 'object' && annotation.completed_by.email) {
        annotatorId = String(annotation.completed_by.email);
      }
      if (annotation.created_username) annotatorId = String(annotation.created_username);
    }
    if (annotation.created_at) createdAt = String(annotation.created_at);
    const results = Array.isArray(annotation.result) ? annotation.result : [];
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      if (String(result.type || '').trim().toLowerCase() !== 'polygonlabels') continue;
      const value = result.value && typeof result.value === 'object' ? result.value : {};
      const labels = Array.isArray(value.polygonlabels) ? value.polygonlabels : [];
      const token = normalizeLabelToken(labels[0] || result.from_name || '');
      if (!token || !TARGET_LABELS.includes(token)) continue;
      const width = Number(value.original_width || result.original_width || data.original_width || data.width || 0);
      const height = Number(value.original_height || result.original_height || data.original_height || data.height || 0);
      const normalized = normalizePolygonPoints(value.points, width, height);
      if (!normalized) continue;
      const area = polygonArea(normalized);
      const existing = labelPolygons.get(token);
      if (!existing || area > existing.area) {
        labelPolygons.set(token, { points: normalized, area });
      }
    }
  }

  const labels = {};
  for (const target of TARGET_LABELS) {
    const polygon = labelPolygons.get(target);
    if (!polygon) continue;
    labels[target] = {
      type: 'polygon',
      points_norm: polygon.points,
    };
  }

  if (!Object.keys(labels).length) {
    return {
      row: null,
      skipped_reason: 'NO_VALID_POLYGONS',
      sample_hash: sampleHash,
    };
  }

  return {
    row: {
      schema_version: 'aurora.gold_labels.v1',
      sample_hash: sampleHash,
      source,
      image_path: imagePath ? toPosix(imagePath) : null,
      qa_status: options.qa_status,
      labels,
      meta: {
        annotator: annotatorId || 'unknown_annotator',
        created_at: createdAt,
        tool: 'label_studio',
        task_id: task.id || null,
      },
    },
    skipped_reason: null,
    sample_hash: sampleHash,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) {
    process.stderr.write('gold_label_import: missing --in\n');
    process.exit(2);
    return;
  }
  const inputPath = path.resolve(args.in);
  const rawText = await fsp.readFile(inputPath, 'utf8');
  const tasks = extractTaskRows(inputPath, rawText);

  const rows = [];
  const skipped = {};
  for (const task of tasks) {
    const normalized = normalizeSingleTask(task, args);
    if (!normalized.row) {
      const key = normalized.skipped_reason || 'UNKNOWN';
      skipped[key] = Number(skipped[key] || 0) + 1;
      continue;
    }
    rows.push(normalized.row);
  }

  const outPath = path.resolve(args.out);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(outPath, payload, 'utf8');

  const summary = {
    ok: true,
    input: toPosix(path.relative(process.cwd(), inputPath)),
    output: toPosix(path.relative(process.cwd(), outPath)),
    total_tasks: tasks.length,
    imported_rows: rows.length,
    skipped,
    label_coverage: TARGET_LABELS.reduce((acc, key) => {
      acc[key] = rows.filter((row) => row.labels && row.labels[key]).length;
      return acc;
    }, {}),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gold_label_import_failed: ${error.message}\n`);
  process.exit(1);
});
