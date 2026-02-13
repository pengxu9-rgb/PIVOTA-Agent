#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

export function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function encodePathForQuery(pathToken) {
  return String(pathToken || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function toLabelStudioLocalFilesUrl(
  absPath,
  { documentRoot = process.env.LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT || process.cwd() } = {},
) {
  const resolvedPath = path.resolve(String(absPath || ''));
  const resolvedRoot = path.resolve(String(documentRoot || process.cwd()));
  const relRaw = toPosix(path.relative(resolvedRoot, resolvedPath)).replace(/^\.\/+/, '');
  const rel = String(relRaw || '').trim();
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) {
    const error = new Error(`label_studio_path_outside_document_root:${resolvedPath}`);
    error.code = 'LS_PATH_OUTSIDE_DOCUMENT_ROOT';
    error.path = resolvedPath;
    error.document_root = resolvedRoot;
    throw error;
  }
  return `/data/local-files/?d=${encodePathForQuery(rel)}`;
}

export function fileExtToken(filePath) {
  return String(path.extname(String(filePath || '')) || '')
    .trim()
    .toLowerCase();
}

export function detectMagicInfo(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length < 12) {
    return {
      magic_type: 'unknown',
      container_hint: null,
    };
  }
  if (inputBuffer.length >= 3 && inputBuffer[0] === 0xff && inputBuffer[1] === 0xd8 && inputBuffer[2] === 0xff) {
    return {
      magic_type: 'jpeg',
      container_hint: null,
    };
  }
  if (
    inputBuffer.length >= 8
    && inputBuffer[0] === 0x89
    && inputBuffer[1] === 0x50
    && inputBuffer[2] === 0x4e
    && inputBuffer[3] === 0x47
    && inputBuffer[4] === 0x0d
    && inputBuffer[5] === 0x0a
    && inputBuffer[6] === 0x1a
    && inputBuffer[7] === 0x0a
  ) {
    return {
      magic_type: 'png',
      container_hint: null,
    };
  }
  const riff = inputBuffer.toString('ascii', 0, 4);
  const webp = inputBuffer.toString('ascii', 8, 12);
  if (riff === 'RIFF' && webp === 'WEBP') {
    return {
      magic_type: 'webp',
      container_hint: null,
    };
  }
  const ftyp = inputBuffer.toString('ascii', 4, 8);
  if (ftyp === 'ftyp') {
    const brand = inputBuffer.toString('ascii', 8, 12).toLowerCase();
    const container_hint = `ftyp${brand}`;
    if (['heic', 'heix', 'hevc', 'hevx', 'heis', 'heim'].includes(brand)) {
      return {
        magic_type: 'heic',
        container_hint,
      };
    }
    if (['heif', 'mif1', 'msf1'].includes(brand)) {
      return {
        magic_type: 'heif',
        container_hint,
      };
    }
    return {
      magic_type: 'unknown',
      container_hint,
    };
  }
  return {
    magic_type: 'unknown',
    container_hint: null,
  };
}

export function isHeicMagicType(magicType) {
  const token = String(magicType || '').trim().toLowerCase();
  return token === 'heic' || token === 'heif';
}

export function isHeicExt(ext) {
  const token = String(ext || '').trim().toLowerCase();
  return token === '.heic' || token === '.heif';
}

export function isHeicMismatch(ext, magicType) {
  return isHeicMagicType(magicType) && !isHeicExt(ext);
}

function commandExists(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return result.status === 0;
}

function runConvertCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.status === 0) {
    return {
      ok: true,
      tool: command,
      stderr: String(result.stderr || '').trim(),
    };
  }
  return {
    ok: false,
    tool: command,
    stderr: String(result.stderr || '').trim() || String(result.stdout || '').trim(),
    error_code: `${command}_failed`,
  };
}

async function verifyJpeg(filePath) {
  const metadata = await sharp(filePath, { failOn: 'none' }).metadata();
  if (!metadata || !metadata.width || !metadata.height) {
    const error = new Error('jpeg_verify_failed');
    error.code = 'JPEG_VERIFY_FAIL';
    throw error;
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: String(metadata.format || '').toLowerCase(),
  };
}

async function convertHeicToJpeg({ inputPath, outputPath, customConvertCmd = '' }) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const candidates = [];
  const customToken = String(customConvertCmd || '').trim();
  if (customToken) {
    candidates.push({
      tool: customToken,
      command: customToken,
      args: [inputPath, outputPath],
    });
  }
  if (commandExists('sips')) {
    candidates.push({
      tool: 'sips',
      command: 'sips',
      args: ['-s', 'format', 'jpeg', inputPath, '--out', outputPath],
    });
  }
  if (commandExists('magick')) {
    candidates.push({
      tool: 'magick',
      command: 'magick',
      args: [inputPath, '-auto-orient', outputPath],
    });
  }
  if (commandExists('convert')) {
    candidates.push({
      tool: 'convert',
      command: 'convert',
      args: [inputPath, outputPath],
    });
  }
  if (!candidates.length) {
    return {
      ok: false,
      tool: null,
      error_code: 'heic_no_converter',
      error_message: 'no local HEIC converter found (sips/magick/convert)',
    };
  }

  for (const candidate of candidates) {
    const run = runConvertCommand(candidate.command, candidate.args);
    if (!run.ok) continue;
    try {
      const verified = await verifyJpeg(outputPath);
      return {
        ok: true,
        tool: candidate.tool,
        width: verified.width,
        height: verified.height,
      };
    } catch (error) {
      await fsp.unlink(outputPath).catch(() => {});
      return {
        ok: false,
        tool: candidate.tool,
        error_code: 'heic_convert_verify_fail',
        error_message: String(error && error.message ? error.message : error),
      };
    }
  }

  return {
    ok: false,
    tool: candidates.map((item) => item.tool).join(','),
    error_code: 'heic_convert_fail',
    error_message: 'all local HEIC converters failed',
  };
}

export async function transcodeToPackJpeg({
  inputPath,
  outputPath,
  customHeicConvertCmd = '',
}) {
  const absInputPath = path.resolve(String(inputPath || ''));
  const extFromPath = fileExtToken(absInputPath);
  const readBuffer = await fsp.readFile(absInputPath);
  const magic = detectMagicInfo(readBuffer.slice(0, 32));
  const heicMismatch = isHeicMismatch(extFromPath, magic.magic_type);
  const info = {
    ext_from_path: extFromPath,
    magic_type: magic.magic_type,
    container_hint: magic.container_hint,
    heic_mismatch: heicMismatch,
    converted: false,
    convert_tool: null,
  };

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  if (isHeicMagicType(magic.magic_type) || isHeicExt(extFromPath)) {
    try {
      const output = await sharp(readBuffer, { failOn: 'none' }).rotate().jpeg({ quality: 95 }).toFile(outputPath);
      return {
        ...info,
        width: output.width || null,
        height: output.height || null,
        converted: false,
      };
    } catch (_error) {
      const converted = await convertHeicToJpeg({
        inputPath: absInputPath,
        outputPath,
        customConvertCmd: customHeicConvertCmd,
      });
      if (!converted.ok) {
        const error = new Error(converted.error_message || 'heic_convert_fail');
        error.code = 'HEIC_CONVERT_FAIL';
        error.reason_detail = 'HEIC_CONVERT_FAIL';
        error.error_code = converted.error_code || 'heic_convert_fail';
        error.debug = info;
        throw error;
      }
      return {
        ...info,
        width: converted.width || null,
        height: converted.height || null,
        converted: true,
        convert_tool: converted.tool || null,
      };
    }
  }

  try {
    const output = await sharp(readBuffer, { failOn: 'none' }).rotate().jpeg({ quality: 95 }).toFile(outputPath);
    return {
      ...info,
      width: output.width || null,
      height: output.height || null,
      converted: false,
    };
  } catch (error) {
    const wrapped = new Error(String(error && error.message ? error.message : error));
    wrapped.code = 'DECODE_FAIL';
    wrapped.reason_detail = 'DECODE_FAIL';
    wrapped.error_code = 'decode_fail';
    wrapped.debug = info;
    throw wrapped;
  }
}

export async function resolvePackImage({
  source,
  imagePathRel,
  internalDir,
  cacheDir,
}) {
  const sourceToken = String(source || '').trim().toLowerCase();
  const rel = String(imagePathRel || '').trim();
  if (!sourceToken || !rel) return null;
  if (/^https?:\/\//i.test(rel)) return null;

  let baseDir = '';
  if (sourceToken === 'internal') baseDir = internalDir;
  if (sourceToken === 'lapa') baseDir = path.join(cacheDir, 'lapa');
  if (sourceToken === 'celebamaskhq') baseDir = path.join(cacheDir, 'celebamaskhq');
  if (!baseDir) return null;

  const absPath = path.resolve(baseDir, rel);
  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  return absPath;
}

export async function readJsonlRows(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return String(raw)
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

export function existsSync(filePath) {
  return fs.existsSync(filePath);
}
