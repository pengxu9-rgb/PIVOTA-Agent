const { buildRoleNormalizer } = require("../../src/layer2/dicts/roles");
const { lintRoleHintsForCards } = require("../../src/layer2/kb/roleHintIntegrity");

describe("KB role hints lint", () => {
  test("known hint passes", () => {
    const rolesDict = {
      schemaVersion: "v0",
      roles: [{ id: "blending_brush", synonyms: ["blending brush"] }],
      normalization_rules: {
        lowercase: true,
        trim: true,
        collapse_whitespace: true,
        replace_chars: [
          { from: "-", to: " " },
          { from: "_", to: " " },
        ],
      },
    };

    const normalizer = buildRoleNormalizer(rolesDict);
    const report = lintRoleHintsForCards({
      market: "US",
      cards: [{ id: "card_ok", productRoleHints: ["Blending-Brush"] }],
      rolesDict,
      normalizeRoleHint: normalizer.normalizeRoleHint,
      maxSuggestions: 3,
    });

    expect(report.summary.unknownRoleHintsCount).toBe(0);
    expect(report.summary.cardsAffectedCount).toBe(0);
  });

  test("unknown hint is reported with suggestions", () => {
    const rolesDict = {
      schemaVersion: "v0",
      roles: [
        { id: "flat_brush", synonyms: ["flat brush"] },
        { id: "blending_brush", synonyms: ["blending brush"] },
      ],
      normalization_rules: {
        lowercase: true,
        trim: true,
        collapse_whitespace: true,
        replace_chars: [
          { from: "-", to: " " },
          { from: "_", to: " " },
        ],
      },
    };

    const normalizer = buildRoleNormalizer(rolesDict);
    const report = lintRoleHintsForCards({
      market: "JP",
      cards: [{ id: "card_bad", productRoleHints: ["flat shader brush"] }],
      rolesDict,
      normalizeRoleHint: normalizer.normalizeRoleHint,
      maxSuggestions: 3,
    });

    expect(report.summary.unknownRoleHintsCount).toBe(1);
    expect(report.summary.cardsAffectedCount).toBe(1);
    expect(report.unknownRoleHints[0].cardId).toBe("card_bad");
    expect(report.unknownRoleHints[0].suggestions.length).toBeGreaterThan(0);
    expect(report.unknownRoleHints[0].suggestions).toContain("flat_brush");
  });
});

