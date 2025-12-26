/*
 * OPTIONAL (US): Generate TechniqueCardV0 proposals from kb_gap_candidates.jsonl.
 *
 * This script is intentionally conservative:
 * - It does not run by default in CI.
 * - It only runs if an LLM provider is configured.
 * - It must generate ORIGINAL text (no copying), no identity language.
 */

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv, LlmError } = require('../../llm/provider');
const { TechniqueCardV0Schema } = require('../../layer2/schemas/techniqueCardV0');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = String(a || '').match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidatesPath = args.candidates
    ? String(args.candidates)
    : path.join(__dirname, '..', '..', '..', '..', 'artifacts', 'kb', 'us', 'kb_gap_candidates.jsonl');

  const outDir = args.outDir
    ? String(args.outDir)
    : path.join(__dirname, '..', '..', '..', '..', 'artifacts', 'kb', 'us', 'proposals');

  if (!fs.existsSync(candidatesPath)) {
    // eslint-disable-next-line no-console
    console.log(`[kb] candidates file not found: ${candidatesPath}`);
    process.exitCode = 1;
    return;
  }

  let provider;
  try {
    provider = createProviderFromEnv('generic');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[kb] LLM provider not configured; skipping proposals.');
    return;
  }

  const candidates = readJsonl(candidatesPath).slice(0, Number(args.limit || 5));
  ensureDir(outDir);

  const OutputSchema = z.object({ proposals: z.array(TechniqueCardV0Schema).min(1).max(10) }).strict();

  const prompt = `
You are helping improve a US-only Technique KB for a makeup look replication product.

Rules:
- Output VALID JSON only matching the schema.
- Generate ORIGINAL concise steps; do NOT copy any external tutorials.
- No celebrity/identity language.
- Each proposal must be market=US and schemaVersion=v0.
- IDs must be unique and start with "T_".
- Steps must be short, atomic imperatives, and brand-free.
- triggers must only use allowed keys from FaceProfileV0 categorical fields or LookSpec breakdown fields.

Create 1-3 TechniqueCard proposals to help with the following gap clusters:
${JSON.stringify(candidates, null, 2)}
`;

  try {
    const parsed = await provider.analyzeTextToJson({ prompt, schema: OutputSchema });
    let i = 0;
    for (const card of parsed.proposals) {
      const filename = `${card.id}.json`;
      fs.writeFileSync(path.join(outDir, filename), JSON.stringify(card, null, 2) + '\n', 'utf8');
      i += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`[kb] wrote ${i} proposals to ${outDir}`);
  } catch (err) {
    const msg = err instanceof LlmError ? `${err.code}: ${err.message}` : err?.message || String(err);
    // eslint-disable-next-line no-console
    console.error(`[kb] proposal generation failed: ${msg}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };

