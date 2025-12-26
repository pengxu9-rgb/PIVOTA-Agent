function uniqueStrings(items) {
  return Array.from(new Set((items || []).map((s) => String(s || '').trim()).filter(Boolean)));
}

function safeString(v) {
  const s = String(v || '').trim();
  return s || null;
}

function buildContextFingerprintUS({ userFaceProfile, refFaceProfile, lookSpec }) {
  const face = userFaceProfile || refFaceProfile || null;

  const faceShape = safeString(face?.categorical?.faceShape);
  const eyeType = safeString(face?.categorical?.eyeType);
  const lipType = safeString(face?.categorical?.lipType);

  const baseFinish = safeString(lookSpec?.breakdown?.base?.finish);
  const lipFinish = safeString(lookSpec?.breakdown?.lip?.finish);

  const vibeTags = uniqueStrings(lookSpec?.styleTags || []).slice(0, 12);

  return {
    ...(faceShape && { faceShape }),
    ...(eyeType && { eyeType }),
    ...(lipType && { lipType }),
    ...(baseFinish && { baseFinish }),
    ...(lipFinish && { lipFinish }),
    ...(vibeTags.length ? { vibeTags } : {}),
  };
}

module.exports = {
  buildContextFingerprintUS,
};

