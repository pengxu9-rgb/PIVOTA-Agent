import { buildContextFingerprintUS } from "../../src/telemetry/contextFingerprintUS";

describe("buildContextFingerprintUS", () => {
  test("is deterministic and bucketized", () => {
    const lookSpec = {
      breakdown: {
        base: { finish: "satin" },
        eye: { finish: "matte" },
        lip: { finish: "gloss" },
      },
      styleTags: ["soft", "soft", "everyday"],
    };

    const face = {
      categorical: { faceShape: "oval", eyeType: "almond", lipType: "balanced" },
    };

    const a = buildContextFingerprintUS({ userFaceProfile: face, refFaceProfile: null, lookSpec });
    const b = buildContextFingerprintUS({ userFaceProfile: face, refFaceProfile: null, lookSpec });

    expect(a).toEqual(b);
    expect(a).toEqual({
      faceShape: "oval",
      eyeType: "almond",
      lipType: "balanced",
      baseFinish: "satin",
      lipFinish: "gloss",
      vibeTags: ["soft", "everyday"],
    });
  });
});

