const fs = require("node:fs");

const sharp = require("sharp");

const { computeSimilarity, isTooSimilar } = require("./imageSimilarity");

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseFaceBox(raw, { width, height }) {
  if (!raw || typeof raw !== "object") return null;

  const hasLTRB = ["left", "top", "right", "bottom"].every((k) => Number.isFinite(Number(raw[k])));
  const hasXYWH = ["x", "y", "width", "height"].every((k) => Number.isFinite(Number(raw[k])));
  const hasLTWH = ["left", "top", "width", "height"].every((k) => Number.isFinite(Number(raw[k])));
  if (!hasLTRB && !hasXYWH && !hasLTWH) return null;

  let left;
  let top;
  let right;
  let bottom;
  if (hasLTRB) {
    left = Number(raw.left);
    top = Number(raw.top);
    right = Number(raw.right);
    bottom = Number(raw.bottom);
  } else if (hasXYWH) {
    left = Number(raw.x);
    top = Number(raw.y);
    right = left + Number(raw.width);
    bottom = top + Number(raw.height);
  } else {
    left = Number(raw.left);
    top = Number(raw.top);
    right = left + Number(raw.width);
    bottom = top + Number(raw.height);
  }

  const looksNormalized = [left, top, right, bottom].every((v) => v >= 0 && v <= 1.5);
  if (looksNormalized) {
    left *= width;
    right *= width;
    top *= height;
    bottom *= height;
  }

  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  left = clamp(Math.round(left), 0, Math.max(0, width - 1));
  top = clamp(Math.round(top), 0, Math.max(0, height - 1));
  right = clamp(Math.round(left + w), left + 1, width);
  bottom = clamp(Math.round(top + h), top + 1, height);

  return { left, top, width: right - left, height: bottom - top };
}

function defaultFaceBox({ width, height }) {
  // Conservative default oval-ish region: centered and slightly up (typical selfies).
  const w = Math.round(width * 0.78);
  const h = Math.round(height * 0.62);
  const left = clamp(Math.round((width - w) / 2), 0, width - 1);
  const top = clamp(Math.round(height * 0.14), 0, height - 1);
  return { left, top, width: clamp(w, 1, width), height: clamp(h, 1, height) };
}

function svgEllipseMask({ width, height, box, pad = 0.18 }) {
  const b = box || defaultFaceBox({ width, height });
  const cx = b.left + b.width / 2;
  const cy = b.top + b.height / 2;
  const rx = (b.width / 2) * (1 + pad);
  const ry = (b.height / 2) * (1 + pad);

  // White ellipse on black background.
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="black" />
  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white" />
</svg>
`.trim();
}

async function loadOrientedBufferFromPath(imagePath) {
  const buf = fs.readFileSync(String(imagePath));
  const meta = await sharp(buf).rotate().metadata();
  const width = Number(meta?.width) || 0;
  const height = Number(meta?.height) || 0;
  return { buffer: buf, width, height };
}

async function buildMaskBuffer({ selfie, faceMaskPath, faceBox, featherPx, pad }) {
  const w = selfie.width;
  const h = selfie.height;

  let mask;
  if (faceMaskPath) {
    const src = fs.readFileSync(String(faceMaskPath));
    // Make sure mask is aligned with the oriented selfie coordinate system.
    mask = sharp(src)
      .rotate()
      .resize(w, h, { fit: "fill" })
      .grayscale()
      .toColourspace("b-w");
  } else {
    const svg = svgEllipseMask({ width: w, height: h, box: faceBox, pad });
    mask = sharp(Buffer.from(svg)).png().grayscale();
  }

  const px = Math.max(
    0,
    Math.floor(featherPx != null && Number.isFinite(Number(featherPx)) ? Number(featherPx) : Math.round(Math.min(w, h) * 0.02))
  );
  if (px > 0) mask = mask.blur(px / 2);

  // Return raw 1-channel mask bytes for alpha channel injection.
  const { data } = await mask.raw().toBuffer({ resolveWithObject: true });
  return { maskRaw: data, width: w, height: h };
}

async function applyTryOnFaceComposite({
  selfieImagePath,
  tryOnImageBytes,
  faceMaskPath,
  faceBox,
  pad,
  featherPx,
}) {
  const selfie = await loadOrientedBufferFromPath(selfieImagePath);
  const origW = selfie.width;
  const origH = selfie.height;
  if (!origW || !origH) throw new Error("SELFIE_DIMENSIONS_MISSING");

  const maxEdge = Math.max(256, Number(process.env.LOOK_REPLICATOR_TRYON_BLEND_MAX_EDGE || "1280"));
  const scale = Math.min(1, maxEdge / Math.max(origW, origH));
  const w = Math.max(1, Math.round(origW * scale));
  const h = Math.max(1, Math.round(origH * scale));

  const parsedFaceBoxOrig = parseFaceBox(faceBox, { width: origW, height: origH }) || null;
  const regionOrig = parsedFaceBoxOrig || defaultFaceBox({ width: origW, height: origH });
  const left = clamp(Math.round(regionOrig.left * scale), 0, Math.max(0, w - 1));
  const top = clamp(Math.round(regionOrig.top * scale), 0, Math.max(0, h - 1));
  const right = clamp(left + Math.max(1, Math.round(regionOrig.width * scale)), left + 1, w);
  const bottom = clamp(top + Math.max(1, Math.round(regionOrig.height * scale)), top + 1, h);
  const region = { left, top, width: right - left, height: bottom - top };

  const { maskRaw } = await buildMaskBuffer({
    selfie: { width: w, height: h },
    faceMaskPath,
    faceBox: parsedFaceBoxOrig
      ? {
          left: region.left,
          top: region.top,
          width: region.width,
          height: region.height,
        }
      : null,
    pad: Number.isFinite(Number(pad)) ? Number(pad) : 0.18,
    featherPx,
  });

  // Resize try-on output to selfie canvas size.
  const tryOnRgb = await sharp(tryOnImageBytes)
    .rotate()
    .resize(w, h, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const overlayWithAlpha = await sharp(tryOnRgb.data, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(maskRaw, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();

  const compositedPng = await sharp(selfie.buffer)
    .rotate()
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .composite([{ input: overlayWithAlpha, left: 0, top: 0 }])
    .png()
    .toBuffer();

  // Similarity check should focus on the face region (outside is mostly unchanged by design).
  const [selfieRegion, outRegion] = await Promise.all([
    sharp(selfie.buffer).rotate().resize(w, h, { fit: "fill" }).extract(region).png().toBuffer(),
    sharp(compositedPng).extract(region).png().toBuffer(),
  ]);

  const similarity = await computeSimilarity(selfieRegion, outRegion).catch(() => null);
  const minDiff = Number(process.env.LOOK_REPLICATOR_TRYON_MIN_DIFF || "6");
  const maxDhashDist = Number(process.env.LOOK_REPLICATOR_TRYON_MAX_DHASH_DIST || "4");
  const tooSimilar = similarity && isTooSimilar(similarity, { minDiff, maxDhashDist });

  if (tooSimilar) {
    return {
      ok: false,
      error: {
        code: "OUTPUT_TOO_SIMILAR",
        message: `Try-on output too similar after face mask blend (diff=${Number(similarity?.diffScore || 0).toFixed(2)} dhash=${similarity?.dhashDist})`,
      },
      meta: { ...(similarity || {}), tooSimilar: true, maskMode: faceMaskPath ? "uploaded_mask" : "ellipse", region },
    };
  }

  return {
    ok: true,
    value: { mimeType: "image/png", dataB64: Buffer.from(compositedPng).toString("base64"), region },
    meta: { ...(similarity || {}), maskMode: faceMaskPath ? "uploaded_mask" : "ellipse", region },
  };
}

module.exports = {
  applyTryOnFaceComposite,
  parseFaceBox,
};
