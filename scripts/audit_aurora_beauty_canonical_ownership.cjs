#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { __internal } = require(path.resolve(__dirname, '../src/auroraBff/routes'));

function parseArgs(argv) {
  const out = {
    input: [],
    jsonOut: '',
    mdOut: '',
    route: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--input' && argv[i + 1]) {
      out.input.push(String(argv[i + 1]));
      i += 1;
      continue;
    }
    if (token === '--json-out' && argv[i + 1]) {
      out.jsonOut = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--md-out' && argv[i + 1]) {
      out.mdOut = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--route' && argv[i + 1]) {
      out.route = String(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstEnvelope(root) {
  if (isPlainObject(root) && Array.isArray(root.cards)) return root;
  const candidates = [
    root && root.envelope,
    root && root.analysis,
    root && root.chat,
    root && root.response,
    root && root.payload,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate) && Array.isArray(candidate.cards)) return candidate;
  }
  return null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildMarkdownReport(entries) {
  const lines = ['# Aurora Beauty Canonical Ownership Audit', ''];
  for (const entry of entries) {
    const audit = entry.audit || {};
    const drift = isPlainObject(audit.drift) ? audit.drift : {};
    const owners = isPlainObject(audit.owner_matrix) ? audit.owner_matrix : {};
    const quality = isPlainObject(entry.quality_contract) ? entry.quality_contract : {};
    const failingDrifts = Object.entries(drift).filter(([, value]) => value === true).map(([key]) => key);
    lines.push(`## ${path.basename(entry.input)}`);
    lines.push('');
    lines.push(`- route: \`${audit.route || 'unknown'}\``);
    lines.push(`- primary focus owner: \`${owners.primary_focus_owner || 'none'}\``);
    lines.push(`- target bundle owner: \`${owners.target_bundle_owner || 'none'}\``);
    lines.push(`- outcome owner: \`${owners.outcome_owner || 'none'}\``);
    lines.push(`- copy owner: \`${owners.copy_owner || 'none'}\``);
    lines.push(`- drifts: ${failingDrifts.length ? failingDrifts.map((item) => `\`${item}\``).join(', ') : 'none'}`);
    lines.push(`- semantic contract pass: \`${quality.semantic_contract_pass === true}\``);
    lines.push(`- owner consistency: primary=\`${quality.primary_focus_owner_consistent === true}\`, target=\`${quality.target_bundle_owner_consistent === true}\`, outcome=\`${quality.outcome_owner_consistent === true}\``);
    lines.push(`- late override absent: \`${quality.late_override_absent === true}\``);
    lines.push(`- context persistence pass: \`${quality.context_persistence_pass === true}\``);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.input.length === 0) {
    console.error('Usage: node audit_aurora_beauty_canonical_ownership.cjs --input <envelope.json> [--input ...] [--json-out file] [--md-out file] [--route route]');
    process.exit(2);
  }

  const entries = [];
  for (const inputFile of args.input) {
    const absPath = path.resolve(process.cwd(), inputFile);
    const root = readJson(absPath);
    const envelope = pickFirstEnvelope(root);
    if (!envelope) {
      entries.push({
        input: absPath,
        error: 'envelope_not_found',
      });
      continue;
    }
    const assistantText =
      isPlainObject(envelope.assistant_message) && typeof envelope.assistant_message.content === 'string'
        ? envelope.assistant_message.content
        : '';
    const audit = __internal.buildBeautyCanonicalOwnershipAudit({
      envelope,
      route: args.route,
      assistantText,
    });
    const qualityContract = __internal.evaluateQualityContractForEnvelope({
      envelope,
      policyMeta: {},
      assistantText,
      profile:
        isPlainObject(envelope.session_patch) && isPlainObject(envelope.session_patch.profile)
          ? envelope.session_patch.profile
          : null,
    });
    entries.push({
      input: absPath,
      audit,
      quality_contract: qualityContract,
    });
  }

  const machine = {
    version: 'aurora.beauty.canonical_ownership_audit_bundle.v1',
    generated_at: new Date().toISOString(),
    entry_count: entries.length,
    entries,
  };
  const md = buildMarkdownReport(entries);

  if (args.jsonOut) {
    fs.writeFileSync(path.resolve(process.cwd(), args.jsonOut), `${JSON.stringify(machine, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
  }
  if (args.mdOut) {
    fs.writeFileSync(path.resolve(process.cwd(), args.mdOut), md);
  }
}

main();
