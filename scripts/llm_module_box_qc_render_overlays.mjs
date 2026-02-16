#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readJsonlRows, toPosix, transcodeToPackJpeg } from './local_image_loader.mjs';

const MODULE_ORDER = Object.freeze([
  'forehead',
  'under_eye_left',
  'under_eye_right',
  'left_cheek',
  'right_cheek',
  'nose',
  'chin',
]);

const MODULE_COLORS = Object.freeze({
  face_oval: '#4CAF50',
  forehead: '#8BC34A',
  nose: '#03A9F4',
  left_cheek: '#FF5722',
  right_cheek: '#FF7043',
  chin: '#009688',
  under_eye_left: '#FFC107',
  under_eye_right: '#FFB300',
});

const FACE_OVAL_POLYGON = Object.freeze([
  { x: 0.5, y: 0.06 },
  { x: 0.64, y: 0.1 },
  { x: 0.75, y: 0.2 },
  { x: 0.82, y: 0.35 },
  { x: 0.84, y: 0.5 },
  { x: 0.8, y: 0.66 },
  { x: 0.72, y: 0.8 },
  { x: 0.62, y: 0.9 },
  { x: 0.5, y: 0.95 },
  { x: 0.38, y: 0.9 },
  { x: 0.28, y: 0.8 },
  { x: 0.2, y: 0.66 },
  { x: 0.16, y: 0.5 },
  { x: 0.18, y: 0.35 },
  { x: 0.25, y: 0.2 },
  { x: 0.36, y: 0.1 },
]);

const HELP_TEXT = `llm_module_box_qc_render_overlays.mjs

Usage:
  node scripts/llm_module_box_qc_render_overlays.mjs --manifest <path> [options]

Required:
  --manifest <path>                      corrected manifest json path

Options:
  --llm_results <path>                   llm_qc_results.jsonl path (recommended)
  --review_in <path>                     review jsonl path (default: manifest.review_in)
  --out <dir>                            output dir (default: <manifest_dir>/llm_qc_visual_review)
  --only_corrected <bool>                render only corrected sides (default: true)
  --limit <n>                            max rendered side count (default: 9999)
  --max_edge <n>                         corrected overlay max edge (default: 1400)
  --concurrency <n>                      render concurrency (default: 4)
  --grid_columns <n>                     review grid columns (default: 4)
  --help                                 show help
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
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

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  const w = Math.max(0.01, Math.min(1, Number(raw.w)));
  const h = Math.max(0.01, Math.min(1, Number(raw.h)));
  const safeX = Math.max(0, Math.min(1 - w, x));
  const safeY = Math.max(0, Math.min(1 - h, y));
  return {
    x: round3(safeX),
    y: round3(safeY),
    w: round3(w),
    h: round3(h),
  };
}

function normalizeModuleRows(rowsRaw) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  const out = [];
  for (const moduleId of MODULE_ORDER) {
    const row = rows.find((item) => String(item && item.module_id || '').trim() === moduleId);
    if (!row || !row.box) continue;
    const safe = sanitizeBox(row.box);
    if (!safe) continue;
    out.push({ module_id: moduleId, box: safe });
  }
  return out;
}

function buildOverlaySvg({ width, height, title, subtitle, moduleRows }) {
  const faceOval = FACE_OVAL_POLYGON
    .map((point) => `${round3(point.x * width)},${round3(point.y * height)}`)
    .join(' ');

  const moduleRects = [];
  let legendX = 12;
  const legendY = Math.max(8, height - 22);
  const legend = [];
  for (const row of moduleRows) {
    const moduleId = row.module_id;
    const color = MODULE_COLORS[moduleId] || '#FFFFFF';
    const x = round3(row.box.x * width);
    const y = round3(row.box.y * height);
    const w = Math.max(1, round3(row.box.w * width));
    const h = Math.max(1, round3(row.box.h * height));
    moduleRects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2"/>`);
    moduleRects.push(`<text x="${Math.max(2, x + 2)}" y="${Math.max(10, y + 12)}" fill="${color}" font-size="11" font-family="Menlo, monospace">${escapeXml(moduleId)}</text>`);
    legend.push(`<rect x="${legendX}" y="${legendY}" width="10" height="10" fill="${color}" />`);
    legend.push(`<text x="${legendX + 14}" y="${legendY + 10}" fill="#FFFFFF" font-size="10" font-family="Menlo, monospace">${escapeXml(moduleId)}</text>`);
    legendX += 14 + (moduleId.length * 6) + 8;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="30" fill="rgba(0,0,0,0.62)"/>
  <text x="10" y="18" fill="#FFFFFF" font-size="12" font-family="Menlo, monospace">${escapeXml(title)}</text>
  <text x="10" y="28" fill="#CFCFCF" font-size="10" font-family="Menlo, monospace">${escapeXml(subtitle)}</text>
  <polygon points="${faceOval}" fill="none" stroke="${MODULE_COLORS.face_oval}" stroke-width="2" stroke-dasharray="6,4"/>
  ${moduleRects.join('\n  ')}
  <rect x="0" y="${Math.max(0, height - 26)}" width="${width}" height="26" fill="rgba(0,0,0,0.55)"/>
  ${legend.join('\n  ')}
</svg>`;
}

async function renderOverlayImage({
  sourceImagePath,
  sourceRenderPath,
  moduleRows,
  outPath,
  title,
  subtitle,
  maxEdge,
}) {
  const imageBuffer = await fsp.readFile(sourceRenderPath || sourceImagePath);
  let work = sharp(imageBuffer, { failOn: 'none' }).rotate();
  if (maxEdge > 0) {
    work = work.resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: false,
    });
  }
  const basePng = await work.png().toBuffer();
  const meta = await sharp(basePng, { failOn: 'none' }).metadata();
  const width = Math.max(1, Math.trunc(Number(meta.width) || 1));
  const height = Math.max(1, Math.trunc(Number(meta.height) || 1));
  const svg = buildOverlaySvg({
    width,
    height,
    title,
    subtitle,
    moduleRows,
  });
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(basePng, { failOn: 'none' })
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function composeBeforeAfter({
  beforePath,
  afterPath,
  outPath,
  title,
}) {
  const paneW = 620;
  const paneH = 620;
  const gap = 12;
  const topH = 40;
  const width = (paneW * 2) + (gap * 3);
  const height = topH + paneH + gap;
  const beforePane = await sharp(beforePath, { failOn: 'none' })
    .resize({
      width: paneW,
      height: paneH,
      fit: 'contain',
      background: { r: 15, g: 15, b: 15, alpha: 1 },
    })
    .png()
    .toBuffer();
  const afterPane = await sharp(afterPath, { failOn: 'none' })
    .resize({
      width: paneW,
      height: paneH,
      fit: 'contain',
      background: { r: 15, g: 15, b: 15, alpha: 1 },
    })
    .png()
    .toBuffer();
  const captionSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#0A0A0A"/>
  <rect x="${gap}" y="${topH}" width="${paneW}" height="${paneH}" fill="#111111"/>
  <rect x="${(gap * 2) + paneW}" y="${topH}" width="${paneW}" height="${paneH}" fill="#111111"/>
  <text x="${gap}" y="15" fill="#FFFFFF" font-size="12" font-family="Menlo, monospace">${escapeXml(title)}</text>
  <text x="${gap}" y="31" fill="#FF8A65" font-size="11" font-family="Menlo, monospace">left: before</text>
  <text x="${(gap * 2) + paneW}" y="31" fill="#4DD0E1" font-size="11" font-family="Menlo, monospace">right: after_llm_qc</text>
</svg>`;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 10, g: 10, b: 10, alpha: 1 },
    },
  })
    .composite([
      { input: Buffer.from(captionSvg), left: 0, top: 0, blend: 'over' },
      { input: beforePane, left: gap, top: topH, blend: 'over' },
      { input: afterPane, left: (gap * 2) + paneW, top: topH, blend: 'over' },
    ])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function renderCompareGrid({
  items,
  outPath,
  columns,
}) {
  if (!items.length) return null;
  const cols = Math.max(1, Math.min(8, Math.trunc(Number(columns) || 4)));
  const cellW = 460;
  const cellH = 300;
  const gap = 10;
  const rows = Math.ceil(items.length / cols);
  const width = (cols * cellW) + ((cols + 1) * gap);
  const height = (rows * cellH) + ((rows + 1) * gap);
  const composites = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const row = Math.trunc(i / cols);
    const col = i % cols;
    const x = gap + (col * (cellW + gap));
    const y = gap + (row * (cellH + gap));
    const thumb = await sharp(item.compare_path, { failOn: 'none' })
      .resize({
        width: cellW,
        height: cellH,
        fit: 'contain',
        background: { r: 10, g: 10, b: 10, alpha: 1 },
      })
      .png()
      .toBuffer();
    composites.push({ input: thumb, left: x, top: y, blend: 'over' });
    const labelSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${cellW}" height="18" viewBox="0 0 ${cellW} 18" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${cellW}" height="18" fill="rgba(0,0,0,0.72)"/>
  <text x="6" y="13" fill="#FFFFFF" font-size="10" font-family="Menlo, monospace">${escapeXml(item.sample_hash)}:${escapeXml(item.side)} ${escapeXml(item.role)} d=${escapeXml(item.decision)}</text>
</svg>`;
    composites.push({ input: Buffer.from(labelSvg), left: x, top: y, blend: 'over' });
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 6, g: 6, b: 6, alpha: 1 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return outPath;
}

async function runPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(32, Math.trunc(Number(concurrency) || 4)));
  const out = new Array(list.length);
  let cursor = 0;
  async function loop() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= list.length) return;
      out[idx] = await worker(list[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, list.length) }, () => loop());
  await Promise.all(workers);
  return out;
}

function makeCacheToken(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 12);
}

async function ensureReadableImagePath({
  sourceImagePath,
  convertedDir,
  cache,
}) {
  const abs = path.resolve(String(sourceImagePath || '').trim());
  if (!abs) throw new Error('empty_source_image_path');
  if (cache.has(abs)) return cache.get(abs);
  const promise = (async () => {
    const raw = await fsp.readFile(abs);
    try {
      await sharp(raw, { failOn: 'none' })
        .rotate()
        .resize({
          width: 32,
          height: 32,
          fit: 'inside',
          withoutEnlargement: false,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      return abs;
    } catch (_error) {
      const base = path.basename(abs).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'image';
      const convertedPath = path.join(convertedDir, `${base}_${makeCacheToken(abs)}.jpg`);
      if (!fs.existsSync(convertedPath)) {
        await transcodeToPackJpeg({
          inputPath: abs,
          outputPath: convertedPath,
          customHeicConvertCmd: String(process.env.CUSTOM_HEIC_CONVERT_CMD || '').trim(),
        });
      }
      return convertedPath;
    }
  })();
  cache.set(abs, promise);
  return promise;
}

function rowForSide(row, side) {
  const useA = String(side).toUpperCase() === 'A';
  const role = String(useA ? row.role_a : row.role_b || '').trim().toLowerCase();
  const beforePath = String(useA ? row.image_a_path : row.image_b_path || '').trim();
  const moduleRows = role === 'baseline' ? row.baseline_module_rows : row.variant_module_rows;
  return {
    role,
    before_path: beforePath ? path.resolve(beforePath) : null,
    module_rows: normalizeModuleRows(moduleRows),
  };
}

async function readJsonlSafe(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

  const reviewIn = String(args.review_in || manifest.review_in || '').trim();
  if (!reviewIn) {
    process.stderr.write('Missing --review_in and manifest.review_in\n');
    process.exitCode = 2;
    return;
  }
  const reviewInPath = path.resolve(reviewIn);
  const llmResultsPath = String(args.llm_results || '').trim()
    ? path.resolve(String(args.llm_results || '').trim())
    : null;
  const onlyCorrected = parseBool(args.only_corrected, true);
  const limit = Math.max(1, Math.min(20000, Math.trunc(parseNumber(args.limit, 9999, 1, 20000))));
  const maxEdge = Math.max(256, Math.min(4096, Math.trunc(parseNumber(args.max_edge, 1400, 256, 4096))));
  const concurrency = Math.max(1, Math.min(16, Math.trunc(parseNumber(args.concurrency, 4, 1, 16))));
  const gridColumns = Math.max(1, Math.min(8, Math.trunc(parseNumber(args.grid_columns, 4, 1, 8))));
  const outDir = path.resolve(String(args.out || path.join(path.dirname(manifestPath), 'llm_qc_visual_review')).trim());
  const correctedDir = path.join(outDir, 'corrected');
  const compareDir = path.join(outDir, 'compare');
  const convertedDir = path.join(outDir, '.converted');
  await fsp.mkdir(correctedDir, { recursive: true });
  await fsp.mkdir(compareDir, { recursive: true });
  await fsp.mkdir(convertedDir, { recursive: true });

  const reviewRows = await readJsonlRows(reviewInPath);
  const reviewMap = new Map();
  for (const row of reviewRows) {
    const key = `${String(row.source || '').trim()}:${String(row.sample_hash || '').trim()}`;
    if (!key || key === ':') continue;
    const imagePath = String(row.image_path || '').trim();
    if (imagePath) reviewMap.set(key, path.resolve(imagePath));
  }

  const llmMap = new Map();
  if (llmResultsPath) {
    const llmRows = await readJsonlSafe(llmResultsPath);
    for (const row of llmRows) {
      const key = `${String(row.sample_hash || '').trim()}:${String(row.side || '').trim().toUpperCase()}`;
      if (!key || key === ':') continue;
      llmMap.set(key, row);
    }
  }

  const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
  const candidates = [];
  for (const row of rows) {
    const sampleHash = String(row.sample_hash || '').trim();
    const source = String(row.source || '').trim();
    if (!sampleHash || !source) continue;
    const reviewKey = `${source}:${sampleHash}`;
    const srcPath = reviewMap.get(reviewKey);
    if (!srcPath || !fs.existsSync(srcPath)) continue;
    for (const side of ['A', 'B']) {
      const sideToken = `${sampleHash}:${side}`;
      const llm = llmMap.get(sideToken) || null;
      if (onlyCorrected) {
        if (!llm) continue;
        if (Number(llm.corrected_modules_count || 0) <= 0) continue;
      }
      const sideData = rowForSide(row, side);
      if (!sideData.before_path || !fs.existsSync(sideData.before_path)) continue;
      if (!sideData.module_rows.length) continue;
      candidates.push({
        sample_hash: sampleHash,
        source,
        rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
        side,
        role: sideData.role,
        source_image_path: srcPath,
        before_path: sideData.before_path,
        module_rows: sideData.module_rows,
        llm_decision: llm ? String(llm.decision || '') : null,
        llm_corrected_modules: llm && Array.isArray(llm.corrected_modules) ? llm.corrected_modules : [],
      });
    }
  }

  const selected = candidates
    .sort((a, b) => {
      const rankA = Number.isFinite(Number(a.rank)) ? Number(a.rank) : 999999;
      const rankB = Number.isFinite(Number(b.rank)) ? Number(b.rank) : 999999;
      if (rankA !== rankB) return rankA - rankB;
      const keyA = `${a.sample_hash}:${a.side}`;
      const keyB = `${b.sample_hash}:${b.side}`;
      return keyA.localeCompare(keyB);
    })
    .slice(0, limit);

  const readablePathCache = new Map();
  const rendered = await runPool(selected, concurrency, async (item) => {
    try {
      const slug = `${item.sample_hash}_${item.side}`;
      const correctedPath = path.join(correctedDir, `${slug}_corrected.png`);
      const comparePath = path.join(compareDir, `${slug}_before_after.png`);
      const sourceRenderPath = await ensureReadableImagePath({
        sourceImagePath: item.source_image_path,
        convertedDir,
        cache: readablePathCache,
      });
      await renderOverlayImage({
        sourceImagePath: item.source_image_path,
        sourceRenderPath,
        moduleRows: item.module_rows,
        outPath: correctedPath,
        title: `${item.side} (${item.role}) · llm_qc_corrected`,
        subtitle: `${item.source}:${item.sample_hash}`,
        maxEdge,
      });
      const decisionTag = item.llm_decision || '-';
      const modsTag = item.llm_corrected_modules.length ? item.llm_corrected_modules.join(',') : '-';
      await composeBeforeAfter({
        beforePath: item.before_path,
        afterPath: correctedPath,
        outPath: comparePath,
        title: `${item.source}:${item.sample_hash}:${item.side} role=${item.role} decision=${decisionTag} mods=${modsTag}`,
      });
      return {
        ...item,
        corrected_path: correctedPath,
        compare_path: comparePath,
        error: null,
      };
    } catch (error) {
      return {
        ...item,
        corrected_path: null,
        compare_path: null,
        error: error instanceof Error ? String(error.message || error) : String(error),
      };
    }
  });

  const okRows = rendered.filter((row) => row && !row.error && row.corrected_path && row.compare_path);
  const failedRows = rendered.filter((row) => row && row.error);
  const gridPath = path.join(outDir, 'grid_before_after.png');
  const wroteGrid = await renderCompareGrid({
    items: okRows,
    outPath: gridPath,
    columns: gridColumns,
  });

  const indexPath = path.join(outDir, 'index.jsonl');
  await fsp.writeFile(
    indexPath,
    `${okRows.map((row) => JSON.stringify({
      sample_hash: row.sample_hash,
      source: row.source,
      rank: row.rank,
      side: row.side,
      role: row.role,
      llm_decision: row.llm_decision,
      llm_corrected_modules: row.llm_corrected_modules,
      source_image_path: row.source_image_path,
      before_path: row.before_path,
      corrected_path: row.corrected_path,
      compare_path: row.compare_path,
    })).join('\n')}${okRows.length ? '\n' : ''}`,
    'utf8',
  );

  const summary = {
    ok: true,
    manifest_path: manifestPath,
    review_in_path: reviewInPath,
    llm_results_path: llmResultsPath,
    out_dir: outDir,
    only_corrected: onlyCorrected,
    selected_total: selected.length,
    rendered_total: okRows.length,
    artifacts: {
      index_jsonl: indexPath,
      grid_before_after_png: wroteGrid ? gridPath : null,
      corrected_dir: correctedDir,
      compare_dir: compareDir,
      converted_dir: convertedDir,
    },
    failures_total: failedRows.length,
  };
  const summaryPath = path.join(outDir, 'summary.json');
  await fsp.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const mdLines = [];
  mdLines.push('# LLM QC Visual Review');
  mdLines.push('');
  mdLines.push(`- manifest: \`${toPosix(path.relative(process.cwd(), manifestPath))}\``);
  mdLines.push(`- review_in: \`${toPosix(path.relative(process.cwd(), reviewInPath))}\``);
  mdLines.push(`- llm_results: \`${llmResultsPath ? toPosix(path.relative(process.cwd(), llmResultsPath)) : '-'}\``);
  mdLines.push(`- only_corrected: \`${String(onlyCorrected)}\``);
  mdLines.push(`- rendered_total: \`${okRows.length}\``);
  mdLines.push(`- failures_total: \`${failedRows.length}\``);
  if (wroteGrid) {
    mdLines.push(`- grid: \`${toPosix(path.relative(process.cwd(), gridPath))}\``);
  }
  mdLines.push('');
  mdLines.push('| rank | sample_hash | side | role | decision | corrected_modules | compare |');
  mdLines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of okRows) {
    mdLines.push(`| ${row.rank ?? '-'} | ${row.sample_hash} | ${row.side} | ${row.role} | ${row.llm_decision || '-'} | ${(row.llm_corrected_modules || []).join(',') || '-'} | ${toPosix(path.relative(process.cwd(), row.compare_path))} |`);
  }
  if (failedRows.length) {
    mdLines.push('');
    mdLines.push('## Failures');
    mdLines.push('');
    mdLines.push('| sample_hash | side | role | error |');
    mdLines.push('| --- | --- | --- | --- |');
    for (const row of failedRows) {
      mdLines.push(`| ${row.sample_hash} | ${row.side} | ${row.role} | ${escapeXml(row.error)} |`);
    }
  }
  const reportPath = path.join(outDir, 'preview.md');
  await fsp.writeFile(reportPath, `${mdLines.join('\n')}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ...summary,
    artifacts: {
      ...summary.artifacts,
      summary_json: summaryPath,
      preview_md: reportPath,
    },
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`llm_module_box_qc_render_overlays failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});
