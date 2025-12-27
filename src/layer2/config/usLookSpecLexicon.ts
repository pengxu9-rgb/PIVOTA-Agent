export const usLookSpecLexicon = {
  market: "US" as const,
  base: {
    finish: ["matte", "natural", "satin", "dewy", "unknown"],
    coverage: ["sheer", "light", "medium", "full", "unknown"],
  },
  eye: {
    shadowShape: ["washed", "defined_crease", "smoky", "winged", "halo", "gradient", "unknown"],
    linerDirection: { direction: ["down", "straight", "up", "unknown"], degreeMin: -20, degreeMax: 20 },
    lashIntensity: ["none", "light", "medium", "bold", "unknown"],
  },
  lip: {
    finish: ["matte", "satin", "gloss", "tint", "hydrated", "unknown"],
  },
  vibeTags: {
    ids: [
      "natural",
      "soft",
      "clean",
      "glowy",
      "fresh",
      "minimal",
      "classic",
      "bold",
      "editorial",
      "romantic",
      "party",
      "everyday",
      "y2k",
      "retro",
      "sporty",
      "elegant",
      "cute",
      "cool",
      "warm",
      "neutral",
    ],
  },
};

