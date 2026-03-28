#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(nextPath));
      continue;
    }
    if (entry.isFile()) files.push(nextPath);
  }
  return files;
}

function escapeForRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPathLiteral(text, literal) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeForRegex(literal)}([^A-Za-z0-9_]|$)`, 'm');
  return pattern.test(String(text || ''));
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const inventoryPath = path.join(__dirname, 'fixtures', 'commerce_invoke_rail_inventory.json');
  const inventory = readJson(inventoryPath);
  const excluded = new Set(inventory.excluded_scan_files || []);
  const publicAllowlist = new Set(inventory.public_observability_allowlist || []);
  const forbiddenAllowlist = new Set(inventory.forbidden_path_allowlist || []);
  const authoritativeFiles = new Set(inventory.authoritative_files || []);
  const invokeLiteralRequiredFiles = new Set(inventory.invoke_literal_required_files || []);
  const publicLiteral = String(inventory.public_literal || '/api/gateway');
  const invokeLiteral = String(inventory.invoke_literal || '/agent/shop/v1/invoke');
  const forbiddenLiteral = String(inventory.forbidden_literal || '/agent/gateway');
  const scanRoots = Array.isArray(inventory.scan_roots) ? inventory.scan_roots : [];
  const violations = [];

  const scannedFiles = scanRoots.flatMap((relativeRoot) =>
    walkFiles(path.join(repoRoot, relativeRoot)).map((filePath) => path.relative(repoRoot, filePath)),
  );

  for (const relativePath of scannedFiles) {
    if (excluded.has(relativePath)) continue;
    const text = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    if (containsPathLiteral(text, forbiddenLiteral) && !forbiddenAllowlist.has(relativePath)) {
      violations.push(`${relativePath}:forbidden_literal:${forbiddenLiteral}`);
    }
    if (containsPathLiteral(text, publicLiteral) && !publicAllowlist.has(relativePath)) {
      violations.push(`${relativePath}:unexpected_public_literal:${publicLiteral}`);
    }
  }

  for (const relativePath of authoritativeFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      violations.push(`${relativePath}:missing_authoritative_file`);
      continue;
    }
    const text = fs.readFileSync(absolutePath, 'utf8');
    if (invokeLiteralRequiredFiles.has(relativePath) && !containsPathLiteral(text, invokeLiteral)) {
      violations.push(`${relativePath}:missing_invoke_literal:${invokeLiteral}`);
    }
    if (containsPathLiteral(text, publicLiteral)) {
      violations.push(`${relativePath}:authoritative_contains_public_literal:${publicLiteral}`);
    }
  }

  const payload = {
    ok: violations.length === 0,
    scanned_file_count: scannedFiles.length,
    authoritative_file_count: authoritativeFiles.size,
    public_observability_allowlist_count: publicAllowlist.size,
    violations,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.ok) {
    process.exit(1);
  }
}

main();
