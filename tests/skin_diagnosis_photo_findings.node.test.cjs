const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { runSkinDiagnosisV1, buildSkinAnalysisFromDiagnosisV1 } = require('../src/auroraBff/skinDiagnosisV1');

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function isInsideEllipse(x, y, cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return false;
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  return nx * nx + ny * ny <= 1;
}

function buildSyntheticSkinRgb({
  width = 224,
  height = 320,
  redPatch = false,
  shinePatch = false,
  textureAmp = 10,
  faceCenterXRatio = 0.5,
  faceCenterYRatio = 0.52,
  faceRadiusXRatio = 0.42,
  faceRadiusYRatio = 0.45,
} = {}) {
  const data = Buffer.alloc(width * height * 3);
  const cx = width * faceCenterXRatio;
  const cy = height * faceCenterYRatio;
  const rx = Math.max(4, width * faceRadiusXRatio);
  const ry = Math.max(4, height * faceRadiusYRatio);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const insideFace = isInsideEllipse(x, y, cx, cy, rx, ry);
      if (!insideFace) {
        data[idx + 0] = 50;
        data[idx + 1] = 46;
        data[idx + 2] = 42;
        continue;
      }

      const pattern = ((x * 11 + y * 7) % 19) - 9;
      const skinNoise = textureAmp > 0 ? Math.round((pattern / 9) * textureAmp) : 0;
      let r = 156 + skinNoise;
      let g = 138 + Math.round(skinNoise * 0.9);
      let b = 128 + Math.round(skinNoise * 0.8);

      if (redPatch && x > width * 0.2 && x < width * 0.42 && y > height * 0.4 && y < height * 0.62) {
        r += 42;
        g -= 18;
        b -= 14;
      }

      if (shinePatch && isInsideEllipse(x, y, width * 0.5, height * 0.5, width * 0.08, height * 0.09)) {
        r = 235;
        g = 218;
        b = 210;
      }

      data[idx + 0] = clampByte(r);
      data[idx + 1] = clampByte(g);
      data[idx + 2] = clampByte(b);
    }
  }
  return { data, width, height };
}

async function toPngBuffer({ data, width, height, blurSigma = 0 }) {
  let image = sharp(data, { raw: { width, height, channels: 3 } }).png();
  if (blurSigma > 0) image = image.blur(blurSigma);
  return image.toBuffer();
}

async function runSyntheticDiagnosis(options) {
  const rgb = buildSyntheticSkinRgb(options);
  const imageBuffer = await toPngBuffer({
    data: rgb.data,
    width: rgb.width,
    height: rgb.height,
    blurSigma: options && options.blurSigma ? options.blurSigma : 0,
  });
  const result = await runSkinDiagnosisV1({
    imageBuffer,
    language: 'EN',
    profileSummary: { goals: ['acne', 'pores'] },
    recentLogsSummary: [],
  });
  assert.equal(result.ok, true);
  assert.ok(result.diagnosis);
  return result.diagnosis;
}

function getFinding(diagnosis, issueType) {
  const findings = Array.isArray(diagnosis && diagnosis.photo_findings) ? diagnosis.photo_findings : [];
  return findings.find((item) => item && item.issue_type === issueType) || null;
}

test('no-vision deterministic analysis still emits photo findings and takeaways', async () => {
  const diagnosis = await runSyntheticDiagnosis({});
  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis, {
    language: 'EN',
    profileSummary: { goals: ['acne'] },
  });
  assert.ok(analysis);
  assert.ok(Array.isArray(analysis.photo_findings));
  assert.ok(analysis.photo_findings.length >= 3);
  assert.ok(Array.isArray(analysis.takeaways));
  assert.ok(analysis.takeaways.some((item) => /^From photo:/i.test(String(item && item.text ? item.text : ''))));
});

test('red patch raises redness finding severity and confidence proxy', async () => {
  const baseline = await runSyntheticDiagnosis({});
  const boosted = await runSyntheticDiagnosis({ redPatch: true });

  const b = getFinding(baseline, 'redness');
  const x = getFinding(boosted, 'redness');
  assert.ok(b);
  assert.ok(x);
  assert.ok(x.severity >= b.severity);
  assert.ok(x.confidence >= Math.max(0, b.confidence - 0.08));
  assert.ok(
    Number(x.computed_features && x.computed_features.red_fraction) >=
      Number(b.computed_features && b.computed_features.red_fraction),
  );
});

test('specular highlight raises shine finding', async () => {
  const baseline = await runSyntheticDiagnosis({});
  const boosted = await runSyntheticDiagnosis({ shinePatch: true });
  const b = getFinding(baseline, 'shine');
  const x = getFinding(boosted, 'shine');
  assert.ok(b);
  assert.ok(x);
  assert.ok(x.severity >= b.severity);
  assert.ok(x.confidence >= Math.max(0, b.confidence - 0.08));
  assert.ok(
    Number(x.computed_features && x.computed_features.specular_fraction) >
      Number(b.computed_features && b.computed_features.specular_fraction),
  );
});

test('gaussian blur lowers texture/pore signal and degrades blur quality factor', async () => {
  const sharpDiag = await runSyntheticDiagnosis({});
  const blurDiag = await runSyntheticDiagnosis({ blurSigma: 0.6 });
  const poresSharp = (sharpDiag.issues || []).find((item) => item && item.issue_type === 'pores');
  const poresBlur = (blurDiag.issues || []).find((item) => item && item.issue_type === 'pores');
  assert.ok(poresSharp);
  assert.ok(poresBlur);
  assert.ok(Number(poresBlur.severity_score || 0) <= Number(poresSharp.severity_score || 0));
  const sharpBlurFactor = Number(sharpDiag?.quality?.metrics?.blur_factor || 0);
  const blurBlurFactor = Number(blurDiag?.quality?.metrics?.blur_factor || 0);
  assert.ok(blurBlurFactor < sharpBlurFactor);
});

test('quality fail produces no photo findings and only retake guidance', async () => {
  const diagnosis = await runSyntheticDiagnosis({ textureAmp: 0, blurSigma: 4.5 });
  assert.equal(diagnosis?.quality?.grade, 'fail');
  assert.equal(Array.isArray(diagnosis.photo_findings), true);
  assert.equal(diagnosis.photo_findings.length, 0);
  assert.ok(Array.isArray(diagnosis.takeaways));
  assert.ok(diagnosis.takeaways.some((item) => /retake|重拍/i.test(String(item && item.text ? item.text : ''))));
});

test('off-center framing fails quality gate with frame reasons', async () => {
  const diagnosis = await runSyntheticDiagnosis({
    faceCenterXRatio: 0.9,
    faceCenterYRatio: 0.55,
    faceRadiusXRatio: 0.18,
    faceRadiusYRatio: 0.35,
  });
  assert.equal(diagnosis?.quality?.grade, 'fail');
  const reasons = Array.isArray(diagnosis?.quality?.reasons) ? diagnosis.quality.reasons : [];
  assert.ok(reasons.some((reason) => /^frame_/.test(String(reason || ''))));
  assert.ok(Array.isArray(diagnosis.takeaways));
  assert.ok(
    diagnosis.takeaways.some((item) => /guide frame|取景框|retake|重拍/i.test(String(item && item.text ? item.text : ''))),
  );
});
