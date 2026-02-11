#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!cur.startsWith('--')) continue;
    const key = cur.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${ms}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parsePromLabels(raw = '') {
  const labels = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
  for (const match of raw.matchAll(re)) {
    labels[match[1]] = match[2];
  }
  return labels;
}

function extractCounterTotal(metricsText, metricName, labelPredicate = null) {
  const re = new RegExp(`^${metricName}(?:\\{([^}]*)\\})?\\s+([0-9.eE+-]+)$`, 'gm');
  let total = 0;
  for (const match of metricsText.matchAll(re)) {
    const labelsRaw = match[1] || '';
    const labels = parsePromLabels(labelsRaw);
    if (typeof labelPredicate === 'function' && !labelPredicate(labels)) continue;
    total += Number(match[2] || 0);
  }
  return total;
}

function mustContainCards(cardTypes, required) {
  return required.every((card) => cardTypes.includes(card));
}

function asksIntakeProfile(text) {
  const content = String(text || '');
  const patterns = [
    /skin\s*type/i,
    /皮肤类型/u,
    /肤质/u,
    /油皮/u,
    /干皮/u,
    /混合皮/u,
    /屏障/u,
    /耐受/u,
    /最想优先解决/u,
  ];
  return patterns.some((re) => re.test(content));
}

function buildMarkdown(summary) {
  const lines = [];
  lines.push('# Chat Follow-up Canary');
  lines.push('');
  lines.push(`- generated_at: ${summary.generated_at}`);
  lines.push(`- base: ${summary.base}`);
  lines.push(`- pass: ${summary.pass}`);
  lines.push(`- request_status: ${summary.request_status}`);
  lines.push(`- uid: ${summary.uid}`);
  lines.push(`- message: ${summary.message}`);
  lines.push('');
  lines.push('## Card Checks');
  lines.push('');
  lines.push(`- has_product_parse: ${summary.card_checks.has_product_parse}`);
  lines.push(`- has_offers_resolved: ${summary.card_checks.has_offers_resolved}`);
  lines.push(`- has_diagnosis_gate: ${summary.card_checks.has_diagnosis_gate}`);
  lines.push(`- asks_profile_intake: ${summary.card_checks.asks_profile_intake}`);
  lines.push('');
  lines.push('## Metric Deltas');
  lines.push('');
  lines.push(`- catalog_availability_shortcircuit_total_delta: ${summary.metric_deltas.catalog_availability_shortcircuit_total_delta}`);
  lines.push(`- repeated_clarify_field_total_skinType_delta: ${summary.metric_deltas.repeated_clarify_field_total_skinType_delta}`);
  lines.push(`- claims_violation_total_delta: ${summary.metric_deltas.claims_violation_total_delta}`);
  lines.push('');
  lines.push('## Gate Results');
  lines.push('');
  for (const gate of summary.gates) {
    lines.push(`- ${gate.name}: ${gate.pass ? 'PASS' : 'FAIL'} (${gate.detail})`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = String(args.base || process.env.BASE || 'https://pivota-agent-production.up.railway.app').replace(/\/+$/, '');
  const message = String(args.message || '有没有薇诺娜的产品');
  const lang = String(args.lang || 'CN');
  const uid = String(args.uid || `canary_${Date.now()}`);
  const timeoutMs = Number(args.timeout_ms || 20000);
  const outPath = String(args.out || path.join('reports', `chat_followup_canary_${nowStamp()}.md`));

  const metricsBeforeResp = await fetchWithTimeout(`${base}/metrics`, {}, timeoutMs);
  const metricsBefore = await metricsBeforeResp.text();
  const beforeCatalog = extractCounterTotal(metricsBefore, 'catalog_availability_shortcircuit_total');
  const beforeClaims = extractCounterTotal(metricsBefore, 'claims_violation_total');
  const beforeRepeatedSkin = extractCounterTotal(
    metricsBefore,
    'repeated_clarify_field_total',
    (labels) => {
      const field = String(labels.field || '').toLowerCase();
      return field === 'skintype' || field === 'skin_type';
    },
  );

  const chatResp = await fetchWithTimeout(
    `${base}/v1/chat`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aurora-uid': uid,
        'x-lang': lang,
      },
      body: JSON.stringify({ message, session: { state: 'S0' } }),
    },
    timeoutMs,
  );

  let chatJson = {};
  try {
    chatJson = await chatResp.json();
  } catch (_err) {
    chatJson = {};
  }
  const cardTypes = Array.isArray(chatJson.cards) ? chatJson.cards.map((c) => c?.type).filter(Boolean) : [];
  const assistantText = String(chatJson?.assistant_message?.content || '');

  const metricsAfterResp = await fetchWithTimeout(`${base}/metrics`, {}, timeoutMs);
  const metricsAfter = await metricsAfterResp.text();
  const afterCatalog = extractCounterTotal(metricsAfter, 'catalog_availability_shortcircuit_total');
  const afterClaims = extractCounterTotal(metricsAfter, 'claims_violation_total');
  const afterRepeatedSkin = extractCounterTotal(
    metricsAfter,
    'repeated_clarify_field_total',
    (labels) => {
      const field = String(labels.field || '').toLowerCase();
      return field === 'skintype' || field === 'skin_type';
    },
  );

  const gates = [
    {
      name: 'chat_status_200',
      pass: chatResp.status === 200,
      detail: `status=${chatResp.status}`,
    },
    {
      name: 'cards_include_product_parse_offers_resolved',
      pass: mustContainCards(cardTypes, ['product_parse', 'offers_resolved']),
      detail: `cards=${cardTypes.join(',') || 'none'}`,
    },
    {
      name: 'no_diagnosis_gate_card',
      pass: !cardTypes.includes('diagnosis_gate'),
      detail: `has_diagnosis_gate=${cardTypes.includes('diagnosis_gate')}`,
    },
    {
      name: 'no_profile_intake_ask_in_message',
      pass: !asksIntakeProfile(assistantText),
      detail: `message_len=${assistantText.length}`,
    },
    {
      name: 'catalog_shortcircuit_counter_increased',
      pass: afterCatalog - beforeCatalog >= 1,
      detail: `delta=${afterCatalog - beforeCatalog}`,
    },
    {
      name: 'repeated_skinType_counter_not_increased',
      pass: afterRepeatedSkin - beforeRepeatedSkin === 0,
      detail: `delta=${afterRepeatedSkin - beforeRepeatedSkin}`,
    },
    {
      name: 'claims_violation_counter_not_increased',
      pass: afterClaims - beforeClaims === 0,
      detail: `delta=${afterClaims - beforeClaims}`,
    },
  ];

  const summary = {
    generated_at: new Date().toISOString(),
    base,
    uid,
    message,
    request_status: chatResp.status,
    pass: gates.every((g) => g.pass),
    card_checks: {
      has_product_parse: cardTypes.includes('product_parse'),
      has_offers_resolved: cardTypes.includes('offers_resolved'),
      has_diagnosis_gate: cardTypes.includes('diagnosis_gate'),
      asks_profile_intake: asksIntakeProfile(assistantText),
    },
    metric_deltas: {
      catalog_availability_shortcircuit_total_delta: afterCatalog - beforeCatalog,
      repeated_clarify_field_total_skinType_delta: afterRepeatedSkin - beforeRepeatedSkin,
      claims_violation_total_delta: afterClaims - beforeClaims,
    },
    gates,
    cards: cardTypes,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildMarkdown(summary), 'utf8');
  console.log(JSON.stringify(summary));
  console.error(`wrote ${outPath}`);

  if (!summary.pass) process.exit(2);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
