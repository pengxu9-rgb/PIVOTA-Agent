'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  resolveDatasetFiles,
  readJsonl,
  pickRows,
  hashSampleId,
  safeResolveUnder,
  summarizeRows,
} = require('./common/datasetUtils');

const DATASET = 'acne04';

async function loadSamples({ repoRoot, cacheExternalDir, cacheRootDir, limit, shuffle, seed } = {}) {
  const files = await resolveDatasetFiles({
    dataset: DATASET,
    repoRoot,
    cacheExternalDir,
    cacheRootDir,
  });
  const rows = await readJsonl(files.indexPath);
  const selected = pickRows(rows, { limit, shuffle, seed });
  const samples = [];
  for (const row of selected) {
    const imageRel = String(row && row.image_path ? row.image_path : '').trim();
    if (!imageRel) continue;
    const imageAbs = safeResolveUnder(files.datasetRoot, imageRel);
    if (!imageAbs) continue;

    const annotationRel = String(row && row.annotation_path ? row.annotation_path : '').trim();
    const annotationAbs = annotationRel ? safeResolveUnder(files.datasetRoot, annotationRel) : null;
    const sourceId = String(row.sample_id || imageRel);
    samples.push({
      dataset: DATASET,
      sample_id: hashSampleId(DATASET, sourceId),
      image_path: imageAbs,
      annotation_path: annotationAbs || null,
      split: String(row.split || 'unknown'),
      meta: {
        source_sample_id: String(row.sample_id || ''),
      },
    });
  }
  return {
    dataset: DATASET,
    samples,
    summary: summarizeRows(rows),
    manifest: files.manifest,
  };
}

function toEvalSample(sample) {
  return {
    dataset: DATASET,
    sample_id: sample.sample_id,
    image_bytes_path: sample.image_path,
    gt_masks: [],
    gt_parts: {
      lesion_annotation_path: sample.annotation_path || null,
    },
    meta: {
      split: sample.split,
      ...sample.meta,
    },
  };
}

function countNumbersInLine(line) {
  const matches = String(line || '').match(/-?\d+(\.\d+)?/g);
  return Array.isArray(matches) ? matches.length : 0;
}

async function extractWeakLesionCount(annotationPath) {
  if (!annotationPath) return null;
  const ext = path.extname(annotationPath).toLowerCase();
  const raw = await fs.readFile(annotationPath, 'utf8').catch(() => '');
  if (!raw.trim()) return null;

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length;
      if (parsed && Array.isArray(parsed.lesions)) return parsed.lesions.length;
      if (parsed && Array.isArray(parsed.annotations)) return parsed.annotations.length;
    } catch {
      return null;
    }
    return null;
  }

  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (countNumbersInLine(trimmed) >= 2) count += 1;
  }
  return count > 0 ? count : null;
}

async function buildSkinMask(evalSample) {
  const annotationPath =
    evalSample && evalSample.gt_parts && typeof evalSample.gt_parts.lesion_annotation_path === 'string'
      ? evalSample.gt_parts.lesion_annotation_path
      : null;
  const lesionCount = await extractWeakLesionCount(annotationPath);
  return {
    ok: false,
    reason: 'no_segmentation_gt',
    weak_label: true,
    note: 'acne04_weak_eval_only',
    lesion_count_weak: Number.isFinite(lesionCount) ? lesionCount : null,
  };
}

module.exports = {
  name: DATASET,
  loadSamples,
  toEvalSample,
  buildSkinMask,
};
