const { createGeminiGuards } = require("../../src/layer1/llm/geminiGuards");

describe("geminiGuards", () => {
  test("rate limit fails fast (RATE_LIMITED)", async () => {
    const guards = createGeminiGuards({ concurrencyMax: 2, ratePerMin: 0, circuitFailThreshold: 5, circuitCooldownMs: 60_000 });
    const fn = jest.fn(async () => "ok");

    await expect(guards.withGuards("reference", fn)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fn).toHaveBeenCalledTimes(0);
  });

  test("circuit breaker opens after threshold and recovers after cooldown", async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const guards = createGeminiGuards({
      concurrencyMax: 1,
      ratePerMin: 1000,
      circuitFailThreshold: 2,
      circuitCooldownMs: 1000,
      now,
    });

    const failing = jest.fn(async () => {
      throw new Error("boom");
    });

    await expect(guards.withGuards("selfie", failing)).rejects.toBeInstanceOf(Error);
    await expect(guards.withGuards("selfie", failing)).rejects.toBeInstanceOf(Error);

    const afterOpen = jest.fn(async () => "ok");
    await expect(guards.withGuards("selfie", afterOpen)).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(afterOpen).toHaveBeenCalledTimes(0);

    nowMs = 2_000;
    await expect(guards.withGuards("selfie", afterOpen)).resolves.toBe("ok");
    expect(afterOpen).toHaveBeenCalledTimes(1);
  });

  test("concurrency cap queues work (max=1)", async () => {
    const guards = createGeminiGuards({ concurrencyMax: 1, ratePerMin: 1000, circuitFailThreshold: 5, circuitCooldownMs: 60_000 });

    let releaseBarrier = null;
    const barrier = new Promise((resolve) => {
      releaseBarrier = () => resolve();
    });

    let task2Started = false;

    const t1 = guards.withGuards("reference", async () => {
      await barrier;
      return 1;
    });

    const t2 = guards.withGuards("reference", async () => {
      task2Started = true;
      return 2;
    });

    await Promise.resolve();
    expect(task2Started).toBe(false);

    if (releaseBarrier) releaseBarrier();

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(task2Started).toBe(true);
  });
});

