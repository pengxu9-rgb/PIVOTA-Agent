const usCompatibilityWeights = {
  geometry: {
    faceAspect: 10,
    jawToCheekRatio: 9,
    chinLengthRatio: 7,
    midfaceRatio: 8,
    eyeSpacingRatio: 6,
    eyeTiltDeg: 8,
    eyeOpennessRatio: 6,
    lipFullnessRatio: 6,
  },
  risk: {
    missingSelfie: 10,
    invalidQuality: 8,
    poseLarge: 6,
    faceBorderCutoff: 6,
  },
  adaptability: {
    eyeTiltDeg: 5,
    eyeOpennessRatio: 4,
    lipFullnessRatio: 6,
  },
  preferenceMultipliers: {
    structure: {
      geometryScale: 1.15,
      riskScale: 1.0,
      adaptabilityScale: 0.85,
      preferEasyAdjustments: false,
    },
    vibe: {
      geometryScale: 0.9,
      riskScale: 0.95,
      adaptabilityScale: 1.15,
      preferEasyAdjustments: false,
    },
    ease: {
      geometryScale: 0.95,
      riskScale: 1.2,
      adaptabilityScale: 0.85,
      preferEasyAdjustments: true,
    },
  },
};

module.exports = { usCompatibilityWeights };

