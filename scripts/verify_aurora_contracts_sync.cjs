const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contractsDir = path.resolve(__dirname, '../contracts/aurora_skills');
const manifestPath = path.join(contractsDir, 'contract_manifest.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const failures = [];

  for (const [filename, expected] of Object.entries(manifest.files || {})) {
    const filePath = path.join(contractsDir, filename);
    if (!fs.existsSync(filePath)) {
      failures.push(`Missing contract file: ${filename}`);
      continue;
    }

    const actual = sha256(filePath);
    if (actual !== expected) {
      failures.push(`Hash mismatch for ${filename}: expected ${expected}, got ${actual}`);
    }
  }

  const qualityGates = JSON.parse(
    fs.readFileSync(path.join(contractsDir, 'quality_gates.json'), 'utf8')
  );

  for (const gate of qualityGates.gates || []) {
    if (!Object.prototype.hasOwnProperty.call(gate, 'kb_ref')) {
      failures.push(`Gate ${gate.gate_id} must explicitly declare kb_ref`);
    }
  }

  if (failures.length > 0) {
    console.error('Aurora contract sync verification failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `Aurora contract sync verified for ${Object.keys(manifest.files || {}).length} files and ${(qualityGates.gates || []).length} quality gates.`
  );
}

main();
