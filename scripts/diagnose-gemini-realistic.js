'use strict';

/**
 * Realistic Gemini latency test simulating Aurora BFF production call patterns.
 * Tests both gemini-2.0-flash and gemini-3-flash-preview with production-like prompts.
 */

const ROUNDS = 5;
const MODELS = [
  process.env.AURORA_INGREDIENT_SYNC_MODEL_GEMINI || 'gemini-2.0-flash',
  process.env.AURORA_ANALYSIS_STORY_MODEL_GEMINI || 'gemini-3-flash-preview',
];

const SYSTEM_PROMPT = `You are an expert cosmetics ingredient analyst. Analyze the given ingredients list and return a structured JSON object with safety assessment, efficacy ratings, and concerns. Follow the exact schema provided. Be thorough but concise. Consider ingredient interactions, concentrations, and skin type compatibility.`;

const USER_PROMPT = `Analyze these skincare ingredients:
Water, Glycerin, Niacinamide, Hyaluronic Acid, Salicylic Acid, Retinol, Vitamin C (Ascorbic Acid), Ceramide NP, Peptide Complex, Squalane, Dimethicone, Phenoxyethanol, Fragrance, Alcohol Denat.

Return JSON with: { "safety_score": number, "efficacy_score": number, "concerns": string[], "highlights": string[], "interactions": string[] }`;

async function measureCall(ai, model, systemPrompt, userPrompt, timeoutMs) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        maxOutputTokens: 512,
        temperature: 0,
      },
    });

    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const text = String(resp?.text || resp?.candidates?.[0]?.content?.parts?.[0]?.text || '').slice(0, 100);
    return { ok: true, latencyMs, text, timedOut: false };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = String(err.message || '').slice(0, 120);
    const isTimeout = latencyMs >= timeoutMs - 100 || msg.includes('abort') || msg.includes('timeout');
    return { ok: false, latencyMs, error: msg, timedOut: isTimeout };
  }
}

async function main() {
  const apiKey =
    process.env.AURORA_SKIN_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    console.error('No Gemini API key found in environment.');
    process.exit(1);
  }

  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const TIMEOUTS_TO_TEST = [2500, 3000, 4000, 5000, 7000, 10000];

  console.log('=== Realistic Gemini Latency Test ===\n');
  console.log(`Prompt: ~${SYSTEM_PROMPT.length + USER_PROMPT.length} chars (system + user)`);
  console.log(`Response: JSON, max 512 tokens\n`);

  for (const model of MODELS) {
    console.log(`\n--- Model: ${model} (${ROUNDS} rounds) ---\n`);
    const latencies = [];

    for (let i = 0; i < ROUNDS; i++) {
      const result = await measureCall(ai, model, SYSTEM_PROMPT, USER_PROMPT, 30000);
      latencies.push(result.latencyMs);
      const status = result.ok ? 'OK' : `FAIL: ${result.error}`;
      console.log(`  Round ${i + 1}: ${result.latencyMs}ms [${status}]`);
      if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, 500));
    }

    const sorted = latencies.filter((_, i) => true).sort((a, b) => a - b);
    const okLatencies = sorted;
    if (okLatencies.length) {
      const stats = {
        min: okLatencies[0],
        median: okLatencies[Math.floor(okLatencies.length / 2)],
        avg: Math.round(okLatencies.reduce((a, b) => a + b, 0) / okLatencies.length),
        p95: okLatencies[Math.floor(okLatencies.length * 0.95)] || okLatencies[okLatencies.length - 1],
        max: okLatencies[okLatencies.length - 1],
      };
      console.log(`\n  Stats: min=${stats.min}ms median=${stats.median}ms avg=${stats.avg}ms p95=${stats.p95}ms max=${stats.max}ms`);

      console.log('\n  Timeout analysis:');
      for (const t of TIMEOUTS_TO_TEST) {
        const wouldTimeout = okLatencies.filter((l) => l > t).length;
        const pct = Math.round((wouldTimeout / okLatencies.length) * 100);
        const icon = pct > 20 ? 'XX' : pct > 0 ? '!!' : 'OK';
        console.log(`    [${icon}] ${t}ms: ${wouldTimeout}/${okLatencies.length} would timeout (${pct}%)`);
      }
    }
  }

  console.log('\n\n--- Concurrency stress test (simulating 4 parallel calls) ---\n');
  const model = MODELS[1]; // gemini-3-flash-preview
  const parallelResults = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      measureCall(ai, model, SYSTEM_PROMPT, USER_PROMPT + `\n(batch call ${i + 1})`, 30000),
    ),
  );
  for (let i = 0; i < parallelResults.length; i++) {
    const r = parallelResults[i];
    const status = r.ok ? 'OK' : `FAIL: ${r.error}`;
    console.log(`  Parallel ${i + 1}: ${r.latencyMs}ms [${status}]`);
  }
  const parallelLatencies = parallelResults.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(`  Parallel stats: min=${parallelLatencies[0]}ms max=${parallelLatencies[parallelLatencies.length - 1]}ms`);

  const wouldTimeout3s = parallelResults.filter((r) => r.latencyMs > 3000).length;
  const wouldTimeout5s = parallelResults.filter((r) => r.latencyMs > 5000).length;
  console.log(`  Would timeout at 3s: ${wouldTimeout3s}/4, at 5s: ${wouldTimeout5s}/4`);

  console.log('\n=== Test complete ===');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
