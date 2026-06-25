/**
 * Regression: the Agent Center probe gate must be PER-PROVIDER.
 *
 * The Gemini global gate (circuit breaker + rate limiter + Gemini key pool) is
 * Gemini-specific. ChatGPT/Claude probes were being wrapped in it too, so a
 * Gemini failure streak opened the shared circuit and rejected ChatGPT/Claude
 * with "Gemini global circuit open" — zeroing those providers even though
 * OpenAI/Anthropic were healthy (observed live: every ChatGPT per-SKU probe
 * returned __error__:Gemini global circuit open). These tests lock in that
 * non-Gemini providers bypass the Gemini gate.
 */
'use strict';

// Force the Gemini gate "open": every withGate call rejects. Keep the rest of
// the module real so transitive requires (GeminiGateError, etc.) still resolve.
const withGateSpy = jest.fn(async () => {
  const err = new Error('Gemini global circuit open (reason=open)');
  err.code = 'CIRCUIT_OPEN';
  throw err;
});
jest.mock('../src/lib/geminiGlobalGate', () => {
  const actual = jest.requireActual('../src/lib/geminiGlobalGate');
  return { ...actual, getGeminiGlobalGate: () => ({ withGate: withGateSpy }) };
});

const { _internals } = require('../src/internal/agentCenterLlmProbe');
const { withProbeCostGate, _providerUsesGeminiGate } = _internals;

const INPUT = { merchant_id: 'm1', store_id: 's1' };

describe('agentCenterLlmProbe — probe gate is per-provider', () => {
  beforeEach(() => withGateSpy.mockClear());

  test('_providerUsesGeminiGate: only gemini uses the gemini gate', () => {
    expect(_providerUsesGeminiGate('gemini')).toBe(true);
    expect(_providerUsesGeminiGate('Gemini')).toBe(true);
    expect(_providerUsesGeminiGate('gemini-2.0-flash')).toBe(true);
    for (const p of ['chatgpt', 'claude', 'mock', '', null, undefined]) {
      expect(_providerUsesGeminiGate(p)).toBe(false);
    }
  });

  test('ChatGPT runs even when the Gemini circuit is open (never touches the gate)', async () => {
    const fn = jest.fn(async () => 'chatgpt-result');
    await expect(withProbeCostGate(INPUT, 'chatgpt', fn)).resolves.toBe('chatgpt-result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(withGateSpy).not.toHaveBeenCalled();
  });

  test('Claude runs even when the Gemini circuit is open', async () => {
    const fn = jest.fn(async () => 'claude-result');
    await expect(withProbeCostGate(INPUT, 'claude', fn)).resolves.toBe('claude-result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(withGateSpy).not.toHaveBeenCalled();
  });

  test('Gemini DOES route through the gate (its open circuit still applies)', async () => {
    const fn = jest.fn(async () => 'gemini-result');
    await expect(withProbeCostGate(INPUT, 'gemini', fn)).rejects.toThrow(/circuit open/i);
    expect(withGateSpy).toHaveBeenCalledTimes(1);
  });
});
