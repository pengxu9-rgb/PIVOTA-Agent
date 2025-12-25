// US Layer1 gate thresholds for server-side safety net.
// These thresholds should remain stable unless we intentionally change policy behavior.

const usGateThresholds = Object.freeze({
  image: {
    // If below these, treat as hard reject (too unreliable for downstream personalization).
    minLightingScoreHard: 35,
    minSharpnessScoreHard: 35,
  },
  pose: {
    // If above these, treat as soft degrade (still usable but less accurate).
    maxAbsYawDegSoft: 18,
    maxAbsPitchDegSoft: 18,
    maxAbsRollDegSoft: 18,
  },
});

module.exports = { usGateThresholds };

