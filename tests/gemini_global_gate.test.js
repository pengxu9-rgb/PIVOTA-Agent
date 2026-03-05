const { createGeminiGlobalGate } = require('../src/lib/geminiGlobalGate');

function buildTimeoutError() {
  const err = new Error('request timed out');
  err.code = 'ETIMEDOUT';
  return err;
}

describe('geminiGlobalGate timeout hybrid policy', () => {
  test('single timeout does not open circuit', async () => {
    const gate = createGeminiGlobalGate({
      concurrencyMax: 1,
      ratePerMin: 1000,
      circuitFailThreshold: 1,
      circuitCooldownMs: 60_000,
      timeoutStreakThreshold: 3,
      timeoutMinSamples: 8,
      timeoutRatioThresholdPct: 60,
      timeoutWindowMs: 60_000,
    });

    await expect(
      gate.withGate('unit_timeout_once', async () => {
        throw buildTimeoutError();
      }),
    ).rejects.toBeInstanceOf(Error);

    const snap = gate.snapshot();
    expect(snap.gate.circuitOpen).toBe(false);
    expect(snap._debug.timeout_tracker.timeoutStreak).toBe(1);
    expect(snap._debug.timeout_tracker.wouldTrigger).toBe(false);
  });

  test('timeout streak opens circuit when threshold reached', async () => {
    const gate = createGeminiGlobalGate({
      concurrencyMax: 1,
      ratePerMin: 1000,
      circuitFailThreshold: 1,
      circuitCooldownMs: 60_000,
      timeoutStreakThreshold: 3,
      timeoutMinSamples: 100,
      timeoutRatioThresholdPct: 100,
      timeoutWindowMs: 60_000,
    });

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        gate.withGate('unit_timeout_streak', async () => {
          throw buildTimeoutError();
        }),
      ).rejects.toBeInstanceOf(Error);
    }

    const snap = gate.snapshot();
    expect(snap.gate.circuitOpen).toBe(true);
    expect(snap._debug.timeout_tracker.timeoutStreak).toBe(3);
    expect(snap._debug.timeout_tracker.triggerReason).toBe('streak');
  });

  test('high timeout ratio in window opens circuit', async () => {
    const gate = createGeminiGlobalGate({
      concurrencyMax: 1,
      ratePerMin: 1000,
      circuitFailThreshold: 1,
      circuitCooldownMs: 60_000,
      timeoutStreakThreshold: 10,
      timeoutMinSamples: 3,
      timeoutRatioThresholdPct: 60,
      timeoutWindowMs: 60_000,
    });

    await expect(
      gate.withGate('unit_timeout_ratio', async () => {
        throw buildTimeoutError();
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(gate.withGate('unit_timeout_ratio', async () => 'ok')).resolves.toBe('ok');
    await expect(
      gate.withGate('unit_timeout_ratio', async () => {
        throw buildTimeoutError();
      }),
    ).rejects.toBeInstanceOf(Error);

    const snap = gate.snapshot();
    expect(snap.gate.circuitOpen).toBe(true);
    expect(snap._debug.timeout_tracker.timeoutStreak).toBe(1);
    expect(snap._debug.timeout_tracker.triggerReason).toBe('ratio');
  });

  test('success resets timeout streak', async () => {
    const gate = createGeminiGlobalGate({
      concurrencyMax: 1,
      ratePerMin: 1000,
      circuitFailThreshold: 1,
      circuitCooldownMs: 60_000,
      timeoutStreakThreshold: 2,
      timeoutMinSamples: 100,
      timeoutRatioThresholdPct: 100,
      timeoutWindowMs: 60_000,
    });

    await expect(
      gate.withGate('unit_timeout_reset', async () => {
        throw buildTimeoutError();
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(gate.withGate('unit_timeout_reset', async () => 'ok')).resolves.toBe('ok');
    await expect(
      gate.withGate('unit_timeout_reset', async () => {
        throw buildTimeoutError();
      }),
    ).rejects.toBeInstanceOf(Error);

    const snap = gate.snapshot();
    expect(snap.gate.circuitOpen).toBe(false);
    expect(snap._debug.timeout_tracker.timeoutStreak).toBe(1);
  });
});
