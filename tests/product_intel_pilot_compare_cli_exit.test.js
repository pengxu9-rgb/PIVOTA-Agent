/**
 * SPAWNS THE REAL CLI AND ASSERTS THE EXIT CODE.
 *
 * WHY THIS FILE HAD TO EXIST. The sibling unit test pinned the guard with
 * `expect(src).toContain(...)` — a grep. A review demonstrated that wrapping the
 * shipped guard in `if (false && …)`, or following `process.exitCode = 1` with
 * `process.exitCode = 0`, left all 19 of those tests GREEN while the CLI exited 0
 * and the defect was fully restored. A guard whose only coverage is a string
 * match is not covered: the string is still there when the behaviour is gone.
 *
 * These three cases are the only ones that can kill those mutants, because they
 * are the only ones that run `main()`.
 *
 * No network: `--gemini-preload` is a `--require` module that replaces the
 * transport seam, so "Gemini fails" and "Gemini works" are both produced
 * locally. Runtime is ~1s per case.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'product_intel_pilot_compare.js');
const CASES = path.join(ROOT, 'scripts', 'fixtures', 'product_intel_pilot_cases.json');

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-cli-'));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const DRAFT = {
  product_intel_core: {
    what_it_is: 'A lightweight gel-cream that hydrates overnight and supports the skin barrier for comfortable morning skin.',
    best_for: [{ label: 'Overnight hydration' }, { label: 'Barrier support' }],
    key_ingredients: [
      { name: 'Niacinamide', benefit: 'Supports the skin barrier and evens tone over time.' },
      { name: 'Panthenol', benefit: 'Draws in water and soothes.' },
    ],
    how_to_use: 'Apply an even layer as the last step of your evening routine.',
    cautions: ['Patch test if you are sensitive to niacinamide.'],
  },
};

/**
 * A --require preload that forces the Gemini transport to succeed or fail.
 *
 * `failFirstOnly` reproduces the probe race: `credentialsAvailable()` fails
 * closed on its FIRST call on a GCP runtime with no env markers, so case 1 can
 * degrade while the rest of the batch is healthy. An ANY-style guard reddens
 * that run; an ALL-style guard does not. Nothing else in the suite covers it.
 *
 * axios is resolved through `createRequire` anchored at the SCRIPT, not by
 * absolute path: node_modules in this repo is a shared symlink, so an absolute
 * path patches a different axios instance and the stub silently does nothing —
 * the first version of this harness reported a healthy run as broken for exactly
 * that reason. A measurement bug that looks identical to the defect.
 */
function preload(mode) {
  const file = path.join(tmp, `preload_${mode}.js`);
  const throwLine = `{ throw new Error('invalid_grant: account not found'); }`;
  fs.writeFileSync(file, `
    const { createRequire } = require('module');
    const scriptRequire = createRequire(${JSON.stringify(SCRIPT)});
    const vertex = require(${JSON.stringify(path.join(ROOT, 'src', 'llm', 'vertexGemini'))});
    const axios = scriptRequire('axios');
    // Credential "source" looks fine — the revoked-key shape: parses, passes
    // credentialsAvailable(), then fails at call time.
    vertex.credentialsAvailable = () => true;
    axios.post = async () => ({ data: { candidates: [{ content: { parts: [{ text: ${JSON.stringify(JSON.stringify(DRAFT))} }] } }] } });
    ${mode === 'fail'
      ? `vertex.restTarget = async () => ${throwLine};`
      : mode === 'failFirstOnly'
        ? `let n = 0; vertex.restTarget = async () => { n += 1; if (n <= 2) ${throwLine} return { url: 'https://stub.invalid/v1/x:generateContent', headers: {} }; };`
        : `vertex.restTarget = async () => ({ url: 'https://stub.invalid/v1/x:generateContent', headers: {} });`}
  `);
  return file;
}

function runCli({ mode, extraArgs = [], vertex = 'true' }) {
  const out = path.join(tmp, `out_${mode}_${Math.random().toString(36).slice(2)}.json`);
  const md = out.replace(/\.json$/, '.md');
  const res = spawnSync(
    process.execPath,
    ['--require', preload(mode), SCRIPT, '--cases', CASES, '--out', out, '--markdown', md, ...extraArgs],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, VERTEX_AI_ENABLED: vertex, GOOGLE_CLOUD_PROJECT: 'test-project' },
    },
  );
  return { ...res, out };
}

describe('CLI exit code (spawns main())', () => {
  test('dead credential + VERTEX_AI_ENABLED=true => EXIT 1', () => {
    const res = runCli({ mode: 'fail' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('VERTEX_GEMINI_UNUSABLE');
    // and the report is still written, so the failure is diagnosable
    expect(fs.existsSync(res.out)).toBe(true);
    const report = JSON.parse(fs.readFileSync(res.out, 'utf8'));
    // the counter must NOT claim Gemini completed
    expect(report.meta.gemini_completed).toBe(0);
    expect(report.meta.gemini_deterministic_rewrite).toBeGreaterThan(0);
  }, 130000);

  test('dead credential but operator passed --skip-gemini => EXIT 0', () => {
    const res = runCli({ mode: 'fail', extraArgs: ['--skip-gemini'] });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"status":"ok"');
  }, 130000);

  test('dead credential but VERTEX_AI_ENABLED off => EXIT 0 (AI Studio is the local default)', () => {
    const res = runCli({ mode: 'fail', vertex: '' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"status":"ok"');
  }, 130000);

  // THE POSITIVE CONTROL, and the one that matters most. A healthy run reports
  // `model: "deterministic-human-standard-rewrite"` too — the rewrite is a
  // post-processing pass over a real Gemini draft — so an earlier revision of
  // this guard keyed on the model name and would have FAILED the live workflow.
  // Confirmed against the real artifact of prod run 30334494514.
  test('healthy Gemini => EXIT 0, and the model name alone does NOT betray it', () => {
    const res = runCli({ mode: 'ok' });
    expect(res.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(res.out, 'utf8'));
    const gemini = report.rows[0].gemini;
    // the trap, pinned: the reported model is the rewrite in BOTH cases
    expect(gemini.model).toBe('deterministic-human-standard-rewrite');
    // and the only field that actually discriminates
    expect(gemini.gemini_seed_available).toBe(true);
    expect(report.meta.gemini_completed).toBeGreaterThan(0);
  }, 130000);

  // ALL-vs-ANY. Case 1 degrades (the probe race), the rest are healthy: an
  // ANY-style predicate reddens this; the shipped ALL-style one must not.
  test('first case degrades but others succeed => EXIT 0', () => {
    const res = runCli({ mode: 'failFirstOnly' });
    expect(res.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(res.out, 'utf8'));
    expect(report.meta.gemini_completed).toBeGreaterThan(0);
    expect(report.meta.gemini_completed).toBeLessThan(report.rows.length);
  }, 130000);

  // A failure must leave a TRACE in the artifact. It previously left none — the
  // local rewrite rescued the row, `reason` stayed undefined, and the only way to
  // learn Gemini never answered was to reproduce it locally.
  test('a dead credential records why, on the row', () => {
    const res = runCli({ mode: 'fail' });
    const report = JSON.parse(fs.readFileSync(res.out, 'utf8'));
    const errors = report.rows[0].gemini.model_errors;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain('invalid_grant');
  }, 130000);
});
