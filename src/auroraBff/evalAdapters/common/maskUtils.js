'use strict';

const sharp = require('sharp');

const { createMask } = require('./metrics');

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function readRawImage(filePath, channels) {
  const pipeline = sharp(filePath, { failOn: 'none' });
  if (typeof channels === 'number') pipeline.ensureAlpha().removeAlpha();
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const width = Number(info && info.width);
  const height = Number(info && info.height);
  const imageChannels = Number(info && info.channels);
  if (!width || !height || !imageChannels) {
    throw new Error(`image_decode_failed:${filePath}`);
  }
  return {
    data: new Uint8Array(data),
    width,
    height,
    channels: imageChannels,
  };
}

async function readMaskLabelImage(filePath) {
  const { data, info } = await sharp(filePath, { failOn: 'none' }).raw().toBuffer({ resolveWithObject: true });
  const width = Number(info && info.width);
  const height = Number(info && info.height);
  const channels = Number(info && info.channels);
  if (!width || !height || !channels) {
    throw new Error(`mask_decode_failed:${filePath}`);
  }
  const out = new Uint16Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    out[i] = data[i * channels];
  }
  return { data: out, width, height };
}

function maskFromAllowedLabelValues(labelImage, allowedValues) {
  const out = new Uint8Array(labelImage.width * labelImage.height);
  const allowed = new Set((Array.isArray(allowedValues) ? allowedValues : []).map((v) => Number(v)));
  if (!allowed.size) return out;
  for (let i = 0; i < labelImage.data.length; i += 1) {
    if (allowed.has(Number(labelImage.data[i]))) out[i] = 1;
  }
  return out;
}

async function readBinaryMaskFromLabelValues(filePath, allowedValues) {
  const label = await readMaskLabelImage(filePath);
  return {
    width: label.width,
    height: label.height,
    mask: maskFromAllowedLabelValues(label, allowedValues),
  };
}

async function readBinaryMaskFromThreshold(filePath, threshold = 1) {
  const label = await readMaskLabelImage(filePath);
  const out = new Uint8Array(label.width * label.height);
  const t = clamp(Number(threshold), 0, 255);
  for (let i = 0; i < label.data.length; i += 1) {
    if (Number(label.data[i]) >= t) out[i] = 1;
  }
  return {
    width: label.width,
    height: label.height,
    mask: out,
  };
}

function resizeMaskNearest(mask, srcW, srcH, dstW, dstH) {
  const out = createMask(dstW, dstH, 0);
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.max(0, Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / dstH)));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.max(0, Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / dstW)));
      out[y * dstW + x] = mask[sy * srcW + sx] ? 1 : 0;
    }
  }
  return out;
}

function cropMaskToNorm(mask, srcW, srcH, cropBoxPx, dstW, dstH) {
  const out = createMask(dstW, dstH, 0);
  const x = clamp(Math.floor(Number(cropBoxPx && cropBoxPx.x)), 0, Math.max(0, srcW - 1));
  const y = clamp(Math.floor(Number(cropBoxPx && cropBoxPx.y)), 0, Math.max(0, srcH - 1));
  const w = clamp(Math.floor(Number(cropBoxPx && cropBoxPx.w)), 1, srcW);
  const h = clamp(Math.floor(Number(cropBoxPx && cropBoxPx.h)), 1, srcH);
  const maxX = Math.min(srcW, x + w);
  const maxY = Math.min(srcH, y + h);
  const cropW = Math.max(1, maxX - x);
  const cropH = Math.max(1, maxY - y);

  for (let dy = 0; dy < dstH; dy += 1) {
    const sy = Math.max(0, Math.min(cropH - 1, Math.floor(((dy + 0.5) * cropH) / dstH)));
    for (let dx = 0; dx < dstW; dx += 1) {
      const sx = Math.max(0, Math.min(cropW - 1, Math.floor(((dx + 0.5) * cropW) / dstW)));
      const srcIndex = (y + sy) * srcW + (x + sx);
      out[dy * dstW + dx] = mask[srcIndex] ? 1 : 0;
    }
  }
  return out;
}

function mergeMasks(maskA, maskB) {
  const len = Math.min(maskA.length, maskB.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = maskA[i] || maskB[i] ? 1 : 0;
  }
  return out;
}

module.exports = {
  readRawImage,
  readMaskLabelImage,
  maskFromAllowedLabelValues,
  readBinaryMaskFromLabelValues,
  readBinaryMaskFromThreshold,
  resizeMaskNearest,
  cropMaskToNorm,
  mergeMasks,
};
