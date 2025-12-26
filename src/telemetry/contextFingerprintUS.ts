type FaceProfileLike = {
  categorical?: {
    faceShape?: string;
    eyeType?: string;
    lipType?: string;
  };
} | null;

type LookSpecLike = {
  breakdown?: {
    base?: { finish?: string };
    lip?: { finish?: string };
  };
  styleTags?: unknown;
} | null;

function uniqueStrings(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return Array.from(
    new Set(items.map((s) => String(s || "").trim()).filter(Boolean)),
  );
}

function safeString(v: unknown): string | null {
  const s = String(v || "").trim();
  return s || null;
}

export function buildContextFingerprintUS(opts: {
  userFaceProfile: FaceProfileLike;
  refFaceProfile: FaceProfileLike;
  lookSpec: LookSpecLike;
}): {
  faceShape?: string;
  eyeType?: string;
  lipType?: string;
  baseFinish?: string;
  lipFinish?: string;
  vibeTags?: string[];
} {
  const { userFaceProfile, refFaceProfile, lookSpec } = opts;
  const face = userFaceProfile || refFaceProfile || null;

  const faceShape = safeString(face?.categorical?.faceShape);
  const eyeType = safeString(face?.categorical?.eyeType);
  const lipType = safeString(face?.categorical?.lipType);

  const baseFinish = safeString(lookSpec?.breakdown?.base?.finish);
  const lipFinish = safeString(lookSpec?.breakdown?.lip?.finish);

  const vibeTags = uniqueStrings(lookSpec?.styleTags).slice(0, 12);

  return {
    ...(faceShape && { faceShape }),
    ...(eyeType && { eyeType }),
    ...(lipType && { lipType }),
    ...(baseFinish && { baseFinish }),
    ...(lipFinish && { lipFinish }),
    ...(vibeTags.length ? { vibeTags } : {}),
  };
}

