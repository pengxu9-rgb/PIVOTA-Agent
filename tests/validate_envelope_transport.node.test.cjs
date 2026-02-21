const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'validate_envelope.js');

function runValidator(inputPath, outputPath) {
  const result = spawnSync(process.execPath, [TOOL, '--input', inputPath, '--output', outputPath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `validator exited with ${result.status}: ${result.stderr || result.stdout}`);
  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

test('validate_envelope: missing response file is classified as transport_error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-transport-missing-'));
  const outputPath = path.join(dir, 'out.json');
  const missingPath = path.join(dir, 'missing.json');
  const out = runValidator(missingPath, outputPath);

  assert.equal(out.schema_ok, true);
  assert.equal(out.stats.transport_error, true);
  assert.equal(out.stats.response_received, false);
  assert.equal(out.stats.empty_cards_without_notice, false);
  assert.equal(out.violations[0].code, 'transport_error');
});

test('validate_envelope: transport placeholder remains transport_error (not schema_violation)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-transport-marker-'));
  const inputPath = path.join(dir, 'in.json');
  const outputPath = path.join(dir, 'out.json');
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        transport_error: true,
        curl_exit_code: 35,
        curl_error: 'Recv failure: Connection reset by peer',
        response_received: false,
      },
      null,
      2,
    ),
    'utf8',
  );
  const out = runValidator(inputPath, outputPath);

  assert.equal(out.schema_ok, true);
  assert.equal(out.stats.transport_error, true);
  assert.equal(out.stats.response_received, false);
  assert.equal(out.stats.curl_exit_code, 35);
  assert.equal(out.violations[0].code, 'transport_error');
});
