const usDeltaThresholds = {
  geometry: {
    faceAspect: { soft: 0.06, hard: 0.18 },
    jawToCheekRatio: { soft: 0.05, hard: 0.15 },
    chinLengthRatio: { soft: 0.03, hard: 0.10 },
    midfaceRatio: { soft: 0.04, hard: 0.12 },
    eyeSpacingRatio: { soft: 0.03, hard: 0.10 },
    eyeTiltDeg: { soft: 3, hard: 12 },
    eyeOpennessRatio: { soft: 0.03, hard: 0.10 },
    lipFullnessRatio: { soft: 0.04, hard: 0.14 },
  },
  categorical: {
    faceShape: { severity: 1 },
    eyeType: { severity: 0.8 },
    lipType: { severity: 0.7 },
  },
  missingSelfie: {
    geometrySeverity: 0.25,
    categoricalSeverity: 0.35,
  },
};

module.exports = { usDeltaThresholds };

