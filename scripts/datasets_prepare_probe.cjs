'use strict';

const path = require('node:path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.heic', '.heif', '.tif', '.tiff']);
const CODE_EXTENSIONS = new Set(['.py', '.js', '.ts', '.tsx', '.md']);

function toPosix(inputPath) {
  return String(inputPath || '').split(path.sep).join('/');
}

function buildContentProbe(relFiles, maxFiles = 2000) {
  const files = Array.isArray(relFiles) ? relFiles.slice(0, maxFiles) : [];
  let imageCountEst = 0;
  let maskCountEst = 0;
  let codeCountEst = 0;
  const topDirs = [];
  const seenTopDirs = new Set();

  for (const relRaw of files) {
    const rel = toPosix(relRaw);
    const ext = path.extname(rel).toLowerCase();
    const low = rel.toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      imageCountEst += 1;
      if (/(^|[\/._-])(mask|skin|seg|segmentation|label|labels|parsing|anno|annotation|gt)([\/._-]|$)/.test(low)) {
        maskCountEst += 1;
      }
    }
    if (CODE_EXTENSIONS.has(ext)) codeCountEst += 1;
    const parts = rel.split('/');
    const top = parts.length > 1 ? parts[0] : null;
    if (top && !seenTopDirs.has(top)) {
      seenTopDirs.add(top);
      topDirs.push(top);
      if (topDirs.length > 20) topDirs.length = 20;
    }
  }

  return {
    image_count_est: imageCountEst,
    mask_count_est: maskCountEst,
    code_count_est: codeCountEst,
    top_dirs_sample: topDirs,
  };
}

function deriveProbeVerdict({ dataset, contentProbe, indexRecordCount }) {
  const probe = contentProbe && typeof contentProbe === 'object' ? contentProbe : {};
  const imageCount = Number(probe.image_count_est || 0);
  const codeCount = Number(probe.code_count_est || 0);
  const maskCount = Number(probe.mask_count_est || 0);
  const records = Number(indexRecordCount || 0);

  let verdict = 'LIKELY_DATASET_ZIP';
  let hint = '';

  if (imageCount < 50 && codeCount > imageCount * 3) {
    verdict = 'LIKELY_REPO_ZIP';
    hint = 'Likely repository zip detected; use dataset payload zip from dataset README (Google Drive/Baidu), not source-code repo zip.';
  }

  if (
    dataset === 'celebamaskhq'
    && verdict !== 'LIKELY_REPO_ZIP'
    && records === 0
    && imageCount >= 50
    && maskCount >= 50
  ) {
    verdict = 'STRUCTURE_UNKNOWN';
    hint = 'NEED_MASK_MERGE: CelebAMask-HQ masks likely split by part; add merge adapter before IoU scoring.';
  }

  if (['fasseg', 'lapa', 'celebamaskhq'].includes(dataset) && records < 100) {
    const tail = 'index_records_total < 100; structure recognition may have failed.';
    hint = hint ? `${hint} ${tail}` : tail;
  }

  return { verdict, hint };
}

module.exports = {
  buildContentProbe,
  deriveProbeVerdict,
};
