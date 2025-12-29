import { getIntentSelection, loadIntentSelectionV0 } from "../../src/layer2/dicts/intentSelection";

describe("intentSelection", () => {
  test("defaults to sequence when intentId not configured", () => {
    const dict = loadIntentSelectionV0();
    expect(getIntentSelection("SOME_UNKNOWN_INTENT", "US", dict)).toBe("sequence");
  });

  test("returns configured selection for known intents", () => {
    const dict = loadIntentSelectionV0();
    expect(getIntentSelection("BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK", "US", dict)).toBe("choose_one");
  });
});
