const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMask,
  iouScore,
  coverageScore,
  leakageScore,
  encodeRleBinary,
  decodeRleBinary,
  polygonNormToMask,
} = require('../src/auroraBff/evalAdapters/common/metrics');

function fillRect(mask, width, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      mask[y * width + x] = 1;
    }
  }
}

test('eval metrics compute IoU/coverage/leakage from synthetic masks', () => {
  const width = 10;
  const height = 10;
  const gt = createMask(width, height, 0);
  const pred = createMask(width, height, 0);

  fillRect(gt, width, 2, 2, 5, 5); // area 16
  fillRect(pred, width, 3, 2, 6, 5); // area 16, overlap 12

  const iou = iouScore(pred, gt);
  const coverage = coverageScore(pred, gt);
  const leakage = leakageScore(pred, gt);

  assert.equal(Number(iou.toFixed(6)), 0.6);
  assert.equal(Number(coverage.toFixed(6)), 0.75);
  assert.equal(Number(leakage.toFixed(6)), 0.25);
});

test('RLE binary encode/decode roundtrip is stable', () => {
  const width = 12;
  const height = 8;
  const source = createMask(width, height, 0);
  fillRect(source, width, 1, 1, 4, 3);
  fillRect(source, width, 7, 2, 10, 6);

  const rle = encodeRleBinary(source);
  const decoded = decodeRleBinary(rle, width * height);

  assert.equal(decoded.length, source.length);
  for (let i = 0; i < source.length; i += 1) {
    assert.equal(decoded[i], source[i], `mismatch at index ${i}`);
  }
});

test('polygon to mask conversion produces positive area', () => {
  const mask = polygonNormToMask(
    {
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
      closed: true,
    },
    64,
    64,
  );
  const positives = Array.from(mask).reduce((acc, value) => acc + (value ? 1 : 0), 0);
  assert.equal(positives > 0, true);
});

test('thin under-eye-like polygon keeps positive pixels at 128 grid', () => {
  const mask = polygonNormToMask(
    {
      points: [
        { x: 0.2, y: 0.24 },
        { x: 0.42, y: 0.24 },
        { x: 0.42, y: 0.27 },
        { x: 0.2, y: 0.27 },
      ],
      closed: true,
    },
    128,
    128,
  );
  const positives = Array.from(mask).reduce((acc, value) => acc + (value ? 1 : 0), 0);
  assert.equal(positives > 0, true);
});
