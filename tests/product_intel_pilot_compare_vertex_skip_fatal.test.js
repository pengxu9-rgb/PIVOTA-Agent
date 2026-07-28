/**
 * A missing Vertex credential must FAIL the run, not quietly degrade it.
 *
 * THE DEFECT THIS PINS. `runGeminiDraft` returns
 * `{skipped:true, reason:'missing_gemini_api_key'}` when the credential is
 * unavailable, and nothing downstream treated that as an error — the script
 * exited 0 with a Gemini-less report. So a rotated, expired, or wrong-project
 * credential produced a GREEN run and an empty packet, which is worse than a
 * failure because nothing prompts anyone to look.
 *
 * `.github/workflows/pivota-insights-coverage.yml` already asserted this
 * behaviour in a comment — "fail fast rather than silently producing a
 * Gemini-less report" — while its verify step only catches an EMPTY credential,
 * never a call-time one. The comment described an intent the code did not
 * honour, which is exactly why it sat unnoticed.
 *
 * WHAT IS DELIBERATELY *NOT* FATAL, each for a different reason:
 *   - `VERTEX_AI_ENABLED` off — the AI Studio arm is the legitimate local-dev
 *     default; unmigrated environments must not start failing.
 *   - `--skip-gemini` — the operator ASKED. "I chose not to call it" and "I could
 *     not call it" are different events and must not converge.
 *   - `model_call_failed:` / `model_fallback_exhausted:` /
 *     `human_standard_rewrite_failed:` / `gemini_quality_failed:` — transient or
 *     quality outcomes the report is designed to express. Making these fatal
 *     would convert working soft paths into hard failures.
 *
 * The predicate is duplicated here rather than exported, because exporting it
 * from a 4,700-line CLI script to satisfy a test is a worse trade than 4 lines
 * of duplication. `test_predicate_matches_source` below pins them together, so
 * the copy cannot silently drift.
 */

const fs = require('fs');
const path = require('path');

const vertexGemini = require('../src/llm/vertexGemini');
// The REAL classifier, imported — not a copy. An earlier revision duplicated the
// predicate here and guarded the copy with a source-substring test; importing it
// removes the drift risk entirely and means these cases assert shipped behaviour.
const { isCredentialFailureReason } = require('../scripts/product_intel_pilot_compare');

const SOURCE = path.join(__dirname, '..', 'scripts', 'product_intel_pilot_compare.js');

function isFatal(rows, args) {
  const credentialSkips = rows.filter(
    (row) => row.gemini?.skipped && isCredentialFailureReason(row.gemini.reason),
  );
  return Boolean(vertexGemini.vertexEnabled() && !args.skipGemini && credentialSkips.length);
}

const row = (reason, skipped = true) => [{ gemini: { skipped, reason } }];

describe('vertex credential skip is fatal', () => {
  const prev = process.env.VERTEX_AI_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.VERTEX_AI_ENABLED;
    else process.env.VERTEX_AI_ENABLED = prev;
  });

  test('vertex ON + credential skip => FATAL', () => {
    process.env.VERTEX_AI_ENABLED = 'true';
    expect(isFatal(row('missing_gemini_api_key'), {})).toBe(true);
  });

  test('vertex ON + healthy run => not fatal', () => {
    process.env.VERTEX_AI_ENABLED = 'true';
    expect(isFatal(row(null, false), {})).toBe(false);
  });

  test('vertex OFF + credential skip => not fatal (AI Studio is the local default)', () => {
    process.env.VERTEX_AI_ENABLED = '';
    expect(isFatal(row('missing_gemini_api_key'), {})).toBe(false);
  });

  test('operator --skip-gemini => not fatal, even carrying a credential reason', () => {
    process.env.VERTEX_AI_ENABLED = 'true';
    // The call site short-circuits so this pairing cannot arise today; the case
    // exists so the `!args.skipGemini` conjunct is observable rather than
    // decorative. Mutation testing showed no other fixture could distinguish it.
    expect(isFatal(row('skip_gemini_flag'), { skipGemini: true })).toBe(false);
    expect(isFatal(row('missing_gemini_api_key'), { skipGemini: true })).toBe(false);
  });

  // TRANSIENT / QUALITY — must stay soft. Making these fatal would turn a busy
  // afternoon or a picky quality gate into a red pipeline.
  test.each([
    'model_call_failed:model_call_failed_429:rate limited',
    'model_call_failed:model_call_failed_503:backend unavailable',
    'model_call_failed:ETIMEDOUT',
    'model_fallback_exhausted:model_call_failed_500:internal',
    'human_standard_rewrite_failed:too_short',
    'gemini_quality_failed:no_candidate',
  ])('non-credential skip %s => not fatal', (reason) => {
    process.env.VERTEX_AI_ENABLED = 'true';
    expect(isCredentialFailureReason(reason)).toBe(false);
    expect(isFatal(row(reason), {})).toBe(false);
  });

  // CREDENTIAL-CLASS BEYOND "absent". This is the case that motivated the guard
  // and that the first revision MISSED: `credentialsAvailable()` only checks a
  // credential source is configured and parses, so a revoked/expired/wrong-project
  // key sails past it and fails at the API instead — landing in what used to be
  // the non-fatal bucket and exiting 0. A rotation is exactly this.
  test.each([
    'model_call_failed:model_call_failed_401:API key not valid',
    'model_call_failed:model_call_failed_403:PERMISSION_DENIED',
    'model_fallback_exhausted:model_call_failed_401:UNAUTHENTICATED',
    'model_call_failed:UNAUTHENTICATED',
    'model_call_failed:Could not load the default credentials',
    'model_call_failed:invalid_grant',
  ])('credential-class skip %s => FATAL', (reason) => {
    process.env.VERTEX_AI_ENABLED = 'true';
    expect(isCredentialFailureReason(reason)).toBe(true);
    expect(isFatal(row(reason), {})).toBe(true);
  });

  test('429 is not mistaken for 401 by a loose match', () => {
    expect(isCredentialFailureReason('model_call_failed_4010')).toBe(false);
    expect(isCredentialFailureReason('model_call_failed_429')).toBe(false);
  });

  test('a reason without the skipped flag => not fatal', () => {
    process.env.VERTEX_AI_ENABLED = 'true';
    expect(isFatal(row('missing_gemini_api_key', false), {})).toBe(false);
  });

  // The classifier itself is imported, so it cannot drift. What a substring check
  // still buys is that the SHIPPED guard actually consults it and actually exits
  // non-zero — neither of which is observable from the exported function.
  test('the shipped guard uses the classifier and exits non-zero', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    expect(src).toContain('isCredentialFailureReason(row.gemini.reason)');
    expect(src).toContain('vertexGemini.vertexEnabled() && !args.skipGemini && credentialSkips.length');
    expect(src).toContain('VERTEX_CREDENTIALS_UNAVAILABLE');
    expect(src).toContain('process.exitCode = 1');
  });
});
