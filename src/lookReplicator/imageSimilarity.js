const sharp = require("sharp");

async function tinyRgbFromImageBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (!buf.length) throw new Error("EMPTY_IMAGE_BYTES");
  const { data } = await sharp(buf)
    .rotate()
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function meanAbsDiff(a, b) {
  const aa = Buffer.isBuffer(a) ? a : Buffer.from(a || "");
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b || "");
  const n = Math.min(aa.length, bb.length);
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs(aa[i] - bb[i]);
  return sum / n;
}

async function dHashFromImageBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (!buf.length) throw new Error("EMPTY_IMAGE_BYTES");

  // Difference hash: grayscale 9x8, compare adjacent pixels horizontally -> 64 bits.
  const { data } = await sharp(buf)
    .rotate()
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits += left < right ? "1" : "0";
    }
  }
  return bits;
}

function hammingDistanceBits(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  const n = Math.min(aa.length, bb.length);
  if (!n) return null;
  let dist = 0;
  for (let i = 0; i < n; i += 1) dist += aa[i] === bb[i] ? 0 : 1;
  // Penalize length mismatch.
  dist += Math.abs(aa.length - bb.length);
  return dist;
}

async function computeSimilarity(selfieBytes, outputBytes) {
  const [tinySelfie, tinyOut] = await Promise.all([tinyRgbFromImageBytes(selfieBytes), tinyRgbFromImageBytes(outputBytes)]);
  const diffScore = meanAbsDiff(tinySelfie, tinyOut);

  const [hashSelfie, hashOut] = await Promise.all([dHashFromImageBytes(selfieBytes), dHashFromImageBytes(outputBytes)]);
  const dhashDist = hammingDistanceBits(hashSelfie, hashOut);

  return { diffScore, dhashDist };
}

function isTooSimilar(similarity, opts) {
  const diff = similarity?.diffScore;
  const dhash = similarity?.dhashDist;
  const minDiff = Number(opts?.minDiff);
  const maxDhashDist = Number(opts?.maxDhashDist);

  const diffOk = Number.isFinite(minDiff) ? diff != null && diff < minDiff : false;
  const dhashOk = Number.isFinite(maxDhashDist) ? dhash != null && dhash <= maxDhashDist : false;
  return Boolean(diffOk || dhashOk);
}

function isSuspectFaceSwap(outSelfie, outTarget, selfieTarget, opts) {
  if (!outSelfie || !outTarget) return false;

  const maxTargetDiff = Number.isFinite(Number(opts?.maxTargetDiff)) ? Number(opts.maxTargetDiff) : 20;
  const maxTargetDhashDist = Number.isFinite(Number(opts?.maxTargetDhashDist)) ? Number(opts.maxTargetDhashDist) : 10;
  const diffMargin = Number.isFinite(Number(opts?.diffMargin)) ? Number(opts.diffMargin) : 6;
  const dhashMargin = Number.isFinite(Number(opts?.dhashMargin)) ? Number(opts.dhashMargin) : 8;

  // If the selfie is already very similar to the target, we cannot reliably detect face swap.
  const selfieTargetVeryClose =
    selfieTarget &&
    ((selfieTarget.diffScore != null && selfieTarget.diffScore <= maxTargetDiff) ||
      (selfieTarget.dhashDist != null && selfieTarget.dhashDist <= maxTargetDhashDist));
  if (selfieTargetVeryClose) return false;

  const outTargetClose =
    (outTarget.diffScore != null && outTarget.diffScore <= maxTargetDiff) ||
    (outTarget.dhashDist != null && outTarget.dhashDist <= maxTargetDhashDist);
  if (!outTargetClose) return false;

  const targetCloserByDiff =
    outTarget.diffScore != null &&
    outSelfie.diffScore != null &&
    outTarget.diffScore + diffMargin < outSelfie.diffScore;

  const targetCloserByHash =
    outTarget.dhashDist != null &&
    outSelfie.dhashDist != null &&
    outTarget.dhashDist + dhashMargin < outSelfie.dhashDist;

  return Boolean(targetCloserByDiff || targetCloserByHash);
}

module.exports = {
  computeSimilarity,
  isTooSimilar,
  isSuspectFaceSwap,
};
