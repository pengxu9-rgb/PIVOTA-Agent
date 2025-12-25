function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function getDelta(deltas, key) {
  return deltas.find((d) => d.key === key);
}

function sev(deltas, key) {
  return clamp01(getDelta(deltas, key)?.severity ?? 0);
}

function signedDiff(deltas, key) {
  const v = getDelta(deltas, key)?.signedDiff;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function baseConfidence(userFace, refFace) {
  if (!userFace) return 'low';
  if (userFace.quality.valid && refFace.quality.valid) return 'high';
  return 'medium';
}

function buildUSRuleCandidates({ preferenceMode, userFace, refFace, deltas }) {
  const candidates = [];
  const conf = baseConfidence(userFace, refFace);

  // Eye: tilt mismatch -> liner direction/wing.
  const eyeTiltKey = 'geometry.eyeTiltDeg';
  const eyeTiltSev = sev(deltas, eyeTiltKey);
  if (userFace && eyeTiltSev >= 0.35) {
    const diff = signedDiff(deltas, eyeTiltKey);
    const userLower = diff < 0;
    candidates.push({
      id: 'eye_tilt_liner_direction',
      impactArea: 'eye',
      title: userLower ? 'Keep the wing shorter and more horizontal' : 'Lift the wing slightly and keep it clean',
      because: userLower
        ? 'Your eye tilt is flatter than the reference, so a steep wing can overshoot the reference direction.'
        : 'Your eye tilt is more lifted than the reference, so a slightly higher wing can align the direction to the look.',
      do: userLower
        ? 'Start liner from the outer third, keep the wing shorter, and follow the lower lash line angle rather than aiming upward.'
        : 'Start liner from the outer third, angle the wing slightly upward, and keep the edge crisp to match the look’s direction.',
      confidence: conf,
      evidence: [`delta:${eyeTiltKey}`, ...(getDelta(deltas, eyeTiltKey)?.evidence || [])],
      difficulty: 'easy',
      score: 10 + eyeTiltSev * 10,
    });
  }

  // Eye: openness mismatch -> liner thickness.
  const eyeOpenKey = 'geometry.eyeOpennessRatio';
  const eyeOpenSev = sev(deltas, eyeOpenKey);
  if (userFace && eyeOpenSev >= 0.35) {
    const diff = signedDiff(deltas, eyeOpenKey);
    const userLower = diff < 0;
    candidates.push({
      id: 'eye_openness_balance',
      impactArea: 'eye',
      title: userLower ? 'Keep liner thinner and brighten the center' : 'Add a slightly thicker liner at the outer third',
      because: userLower
        ? 'If your eyes read more closed than the reference, heavy liner can reduce visible lid space.'
        : 'If your eyes read more open than the reference, a bit more outer-third definition can match the reference intensity.',
      do: userLower
        ? 'Use a thinner liner, tightline lightly, and add a touch of highlight on the center of the lid.'
        : 'Add a slightly thicker liner at the outer third and blend shadow outward to match the reference emphasis.',
      confidence: conf,
      evidence: [`delta:${eyeOpenKey}`, ...(getDelta(deltas, eyeOpenKey)?.evidence || [])],
      difficulty: 'medium',
      score: 8 + eyeOpenSev * 8,
    });
  }

  // Lip: fullness mismatch -> finish/liner placement.
  const lipKey = 'geometry.lipFullnessRatio';
  const lipSev = sev(deltas, lipKey);
  if (userFace && lipSev >= 0.35) {
    const diff = signedDiff(deltas, lipKey);
    const userLower = diff < 0;
    candidates.push({
      id: 'lip_fullness_match',
      impactArea: 'lip',
      title: userLower ? 'Add fullness with liner + gloss placement' : 'Keep lip edges crisp and reduce shine',
      because: userLower
        ? 'If your lips read thinner than the reference, placement can recreate the same fullness effect.'
        : 'If your lips read fuller than the reference, crisp edges and controlled shine can match the reference shape.',
      do: userLower
        ? 'Slightly overline only at the cupid’s bow and center, then add gloss to the middle of the lips.'
        : 'Use a precise lip line, keep color within the natural border, and choose a satin finish over a high-gloss center.',
      confidence: conf,
      evidence: [`delta:${lipKey}`, ...(getDelta(deltas, lipKey)?.evidence || [])],
      difficulty: 'easy',
      score: 9 + lipSev * 9,
    });
  }

  // Base: face shape mismatch -> placement guidance.
  const faceShapeKey = 'categorical.faceShape';
  const faceShapeSev = sev(deltas, faceShapeKey);
  if (userFace && faceShapeSev >= 0.9) {
    candidates.push({
      id: 'base_shape_balance',
      impactArea: 'base',
      title: 'Use placement to echo the reference structure',
      because: 'When face shape differs, placement is the safest way to align the look’s structure.',
      do: 'Place blush slightly higher toward the outer cheek, and keep contour subtle—build only where it supports the reference’s structure.',
      confidence: conf,
      evidence: [`delta:${faceShapeKey}`, ...(getDelta(deltas, faceShapeKey)?.evidence || [])],
      difficulty: 'medium',
      score: 7 + faceShapeSev * 6,
    });
  }

  // Base: jaw ratio mismatch -> shading.
  const jawKey = 'geometry.jawToCheekRatio';
  const jawSev = sev(deltas, jawKey);
  if (userFace && jawSev >= 0.4) {
    candidates.push({
      id: 'base_jaw_soften_define',
      impactArea: 'base',
      title: 'Match the jaw definition with subtle shading',
      because: 'Jaw definition reads strongly in many looks; subtle shading can align the perceived structure.',
      do: 'Use a soft bronzer under the cheekbone and a light contour near the jawline—blend until edges disappear.',
      confidence: conf,
      evidence: [`delta:${jawKey}`, ...(getDelta(deltas, jawKey)?.evidence || [])],
      difficulty: 'easy',
      score: 6 + jawSev * 6,
    });
  }

  return candidates;
}

function usFallbackAdjustments({ userMissing }) {
  const confidence = userMissing ? 'low' : 'medium';
  return [
    {
      id: 'fallback_base_thin',
      impactArea: 'base',
      title: 'Keep base thin and build only where needed',
      because: 'A thin base preserves texture and makes it easier to match the reference finish.',
      do: 'Apply a light layer first, then spot-conceal only where needed and re-blend.',
      confidence,
      evidence: ['fallback:base'],
      difficulty: 'easy',
      score: 1,
    },
    {
      id: 'fallback_eye_short_wing',
      impactArea: 'eye',
      title: 'Start liner from the outer third and keep the wing shorter',
      because: 'A shorter, controlled wing is a safe way to match the reference direction without relying on exact geometry.',
      do: 'Start at the outer third, keep the wing short, and connect back to the lash line with a thin stroke.',
      confidence,
      evidence: ['fallback:eye'],
      difficulty: 'easy',
      score: 1,
    },
    {
      id: 'fallback_lip_finish',
      impactArea: 'lip',
      title: 'Match the reference finish and stay within a close shade family',
      because: 'Finish (gloss vs satin) changes the look more reliably than chasing exact lip shape.',
      do: 'Choose a similar finish and stay in a close shade family; adjust intensity with a light blot if needed.',
      confidence,
      evidence: ['fallback:lip'],
      difficulty: 'easy',
      score: 1,
    },
  ];
}

module.exports = {
  buildUSRuleCandidates,
  usFallbackAdjustments,
};

