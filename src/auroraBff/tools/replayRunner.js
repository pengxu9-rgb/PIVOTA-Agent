const fs = require('fs');
const path = require('path');

const { buildEnvelope, normalizeNextState, FieldMissingEnforcer } = require('../envelope');
const { applyReplyTemplates } = require('../replyTemplates');
const { scoreReplyQuality } = require('../replyQualityScorer');

const DEFAULT_FIXTURES_DIR = path.join(__dirname, 'fixtures');

const HARD_FAIL_ALIAS_MAP = Object.freeze({
  medical_diagnosis: ['forbidden_medical_diagnosis_term'],
  absolute_cure_claim: ['forbidden_absolute_cure_claim'],
  inventory_assertion_without_offer: ['asserted_in_stock_or_buy_now_with_null_offer'],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value) {
  if (value == null) return '';
  return String(value);
}

function copyDeep(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function mergeObjects(base, patch) {
  const left = isPlainObject(base) ? base : {};
  const right = isPlainObject(patch) ? patch : {};
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (isPlainObject(value) && isPlainObject(left[key])) {
      out[key] = mergeObjects(left[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizeLangToken(raw) {
  const token = safeString(raw).trim();
  if (!token) return 'CN';
  if (/^en/i.test(token)) return 'EN';
  if (/^(zh|cn)/i.test(token)) return 'CN';
  return token.toUpperCase();
}

function listFixtureFiles(fixturesDir = DEFAULT_FIXTURES_DIR) {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(fixturesDir, file));
}

function loadReplayFixtures({ fixturesDir = DEFAULT_FIXTURES_DIR, onlyNames = [] } = {}) {
  const only = new Set((Array.isArray(onlyNames) ? onlyNames : []).map((name) => safeString(name).trim()).filter(Boolean));
  const fixtures = [];

  for (const filePath of listFixtureFiles(fixturesDir)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      const fixture = isPlainObject(record) ? copyDeep(record) : null;
      if (!fixture) continue;
      if (!safeString(fixture.name).trim()) {
        throw new Error(`Fixture missing name: ${filePath}`);
      }
      if (only.size > 0 && !only.has(fixture.name)) continue;
      fixture.__file = filePath;
      fixtures.push(fixture);
    }
  }

  const seen = new Set();
  for (const fixture of fixtures) {
    if (seen.has(fixture.name)) {
      throw new Error(`Duplicate fixture name: ${fixture.name}`);
    }
    seen.add(fixture.name);
  }

  return fixtures;
}

function buildReplayCtx(inputCtx, index, fixtureName) {
  const rawCtx = isPlainObject(inputCtx) ? inputCtx : {};
  const lang = normalizeLangToken(rawCtx.lang || rawCtx.locale || rawCtx.accept_language);
  const acceptLanguage = safeString(rawCtx.accept_language || rawCtx.locale).trim() || (lang === 'EN' ? 'en-US' : 'zh-CN');

  return {
    request_id: safeString(rawCtx.request_id).trim() || `replay_req_${index + 1}`,
    trace_id: safeString(rawCtx.trace_id).trim() || `replay_trace_${index + 1}`,
    aurora_uid: safeString(rawCtx.aurora_uid).trim() || `replay_uid_${index + 1}`,
    brief_id: safeString(rawCtx.brief_id).trim() || `replay_brief_${index + 1}`,
    lang,
    trigger_source: safeString(rawCtx.trigger_source).trim() || 'text_explicit',
    state: safeString(rawCtx.state).trim() || 'idle',
    intent: safeString(rawCtx.intent).trim(),
    locale: safeString(rawCtx.locale).trim(),
    accept_language: acceptLanguage,
    fixture_name: safeString(fixtureName).trim(),
  };
}

function buildSeedEnvelopeInput(fixtureInput) {
  const input = isPlainObject(fixtureInput) ? fixtureInput : {};
  const seedEnvelope = isPlainObject(input.seed_envelope) ? input.seed_envelope : {};
  const sessionFromInput = isPlainObject(input.session) ? input.session : {};

  const seedSessionPatch = isPlainObject(seedEnvelope.session_patch) ? seedEnvelope.session_patch : {};
  const sessionPatch = mergeObjects(seedSessionPatch, sessionFromInput);

  return {
    assistant_message: seedEnvelope.assistant_message == null ? null : copyDeep(seedEnvelope.assistant_message),
    suggested_chips: Array.isArray(seedEnvelope.suggested_chips) ? copyDeep(seedEnvelope.suggested_chips) : [],
    cards: Array.isArray(seedEnvelope.cards) ? copyDeep(seedEnvelope.cards) : [],
    session_patch: sessionPatch,
    events: Array.isArray(seedEnvelope.events) ? copyDeep(seedEnvelope.events) : [],
  };
}

function collectQualityFailureReasons(qualityResult) {
  const out = new Set();
  const hardFail = Array.isArray(qualityResult && qualityResult.hard_fail_reasons)
    ? qualityResult.hard_fail_reasons
    : [];
  for (const reason of hardFail) out.add(safeString(reason).trim());

  const breakdown = Array.isArray(qualityResult && qualityResult.breakdown) ? qualityResult.breakdown : [];
  for (const row of breakdown) {
    if (!row || row.passed !== false) continue;
    const reason = safeString(row.reason).trim();
    if (!reason || reason === 'not_applicable' || reason === 'ok') continue;
    out.add(reason);
  }

  return out;
}

function expandForbiddenAliases(token) {
  const raw = safeString(token).trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const aliases = HARD_FAIL_ALIAS_MAP[lower] || [];
  return [raw, ...aliases];
}

function cardTypesSet(cards) {
  return new Set(
    (Array.isArray(cards) ? cards : [])
      .map((card) => safeString(card && card.type).trim().toLowerCase())
      .filter(Boolean),
  );
}

function hasFieldMissingEntry(card, expectedField, expectedReason) {
  const missing = Array.isArray(card && card.field_missing) ? card.field_missing : [];
  return missing.some((entry) => {
    const field = safeString(entry && entry.field).trim();
    const reason = safeString(entry && entry.reason).trim();
    if (expectedField && field !== expectedField) return false;
    if (expectedReason && reason !== expectedReason) return false;
    return Boolean(field && reason);
  });
}

function evaluateFixtureExpectations({ fixture, envelope, quality }) {
  const expected = isPlainObject(fixture && fixture.expected) ? fixture.expected : {};
  const failures = [];

  const cards = Array.isArray(envelope && envelope.cards) ? envelope.cards : [];
  const cardTypes = cardTypesSet(cards);
  const uiNextState = safeString(envelope && envelope.session_patch && envelope.session_patch.next_state).trim();

  const pushFailure = (rule, details) => {
    failures.push({ rule, ...details });
  };

  if (expected.ui_next_state != null) {
    const expectedState = safeString(expected.ui_next_state).trim();
    if (uiNextState !== expectedState) {
      pushFailure('ui_next_state', { expected: expectedState, actual: uiNextState });
    }
  }

  const mustHaveCards = Array.isArray(expected.must_have_cards) ? expected.must_have_cards : [];
  for (const typeRaw of mustHaveCards) {
    const type = safeString(typeRaw).trim().toLowerCase();
    if (!type) continue;
    if (!cardTypes.has(type)) {
      pushFailure('must_have_cards', { expected: type, actual: 'missing' });
    }
  }

  const mustNotHaveCards = Array.isArray(expected.must_not_have_cards) ? expected.must_not_have_cards : [];
  for (const typeRaw of mustNotHaveCards) {
    const type = safeString(typeRaw).trim().toLowerCase();
    if (!type) continue;
    if (cardTypes.has(type)) {
      pushFailure('must_not_have_cards', { expected: type, actual: 'present' });
    }
  }

  const qualityMinScore = Number(expected.quality_min_score);
  if (Number.isFinite(qualityMinScore)) {
    const actualScore = Number(quality && quality.total_score);
    if (!Number.isFinite(actualScore) || actualScore < qualityMinScore) {
      pushFailure('quality_min_score', { expected: qualityMinScore, actual: actualScore });
    }
  }

  const forbiddenReasons = Array.isArray(expected.hard_fail_forbidden) ? expected.hard_fail_forbidden : [];
  if (forbiddenReasons.length > 0) {
    const seenFailureReasons = collectQualityFailureReasons(quality);
    for (const token of forbiddenReasons) {
      const aliases = expandForbiddenAliases(token);
      const hit = aliases.find((alias) => seenFailureReasons.has(alias));
      if (hit) {
        pushFailure('hard_fail_forbidden', {
          expected: safeString(token).trim(),
          actual: hit,
        });
      }
    }
  }

  const mustHaveFieldMissing = Array.isArray(expected.must_have_field_missing) ? expected.must_have_field_missing : [];
  for (const row of mustHaveFieldMissing) {
    const cardType = safeString(row && row.card_type).trim().toLowerCase();
    const field = safeString(row && row.field).trim();
    const reason = safeString(row && row.reason).trim();
    const targetCards = cardType
      ? cards.filter((card) => safeString(card && card.type).trim().toLowerCase() === cardType)
      : cards;

    const found = targetCards.some((card) => hasFieldMissingEntry(card, field, reason));
    if (!found) {
      pushFailure('must_have_field_missing', {
        expected: { card_type: cardType || null, field, reason },
        actual: 'missing',
      });
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}

function runReplayFixture(fixture, { index = 0 } = {}) {
  const input = isPlainObject(fixture && fixture.input) ? fixture.input : {};
  const ctx = buildReplayCtx(input.ctx, index, fixture && fixture.name);
  const seedInput = buildSeedEnvelopeInput(input);

  let envelope = buildEnvelope(ctx, seedInput);

  const templateCtx = {
    lang: safeString(input && input.ctx && input.ctx.lang).trim() || ctx.lang,
    locale: safeString(input && input.ctx && (input.ctx.locale || input.ctx.accept_language)).trim(),
    accept_language: safeString(input && input.ctx && (input.ctx.accept_language || input.ctx.locale)).trim(),
    intent: safeString(input && input.ctx && input.ctx.intent).trim(),
  };

  const templated = applyReplyTemplates({ envelope, ctx: templateCtx });
  if (templated) envelope = templated;

  FieldMissingEnforcer(envelope);
  normalizeNextState(envelope);

  const quality = scoreReplyQuality(envelope);
  const evaluation = evaluateFixtureExpectations({ fixture, envelope, quality });

  return {
    name: safeString(fixture && fixture.name).trim() || `fixture_${index + 1}`,
    fixture_file: safeString(fixture && fixture.__file).trim() || null,
    input: {
      user_text: safeString(input.user_text).trim(),
      ctx: copyDeep(input.ctx || {}),
      session: copyDeep(input.session || {}),
      bootstrap: copyDeep(input.bootstrap || {}),
    },
    envelope,
    quality,
    pass: evaluation.pass,
    failures: evaluation.failures,
  };
}

function summarizeReplayResults(results) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const passed = list.filter((item) => item && item.pass).length;
  const failed = total - passed;

  const scoreList = list
    .map((item) => Number(item && item.quality && item.quality.total_score))
    .filter((score) => Number.isFinite(score));
  const avgScore = scoreList.length > 0
    ? (scoreList.reduce((sum, score) => sum + score, 0) / scoreList.length)
    : 0;

  const assertionFailCounts = new Map();
  const qualityRuleFailCounts = new Map();

  for (const item of list) {
    const failures = Array.isArray(item && item.failures) ? item.failures : [];
    for (const failure of failures) {
      const key = safeString(failure && failure.rule).trim() || 'unknown';
      assertionFailCounts.set(key, (assertionFailCounts.get(key) || 0) + 1);
    }

    const breakdown = Array.isArray(item && item.quality && item.quality.breakdown)
      ? item.quality.breakdown
      : [];
    for (const row of breakdown) {
      if (!row || row.passed !== false) continue;
      const key = safeString(row.id).trim() || 'unknown_quality_rule';
      qualityRuleFailCounts.set(key, (qualityRuleFailCounts.get(key) || 0) + 1);
    }
  }

  const toSortedRows = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, count]) => ({ rule, count }));

  return {
    total,
    passed,
    failed,
    avg_score: Number(avgScore.toFixed(2)),
    top_failing_rules: toSortedRows(assertionFailCounts),
    top_failing_quality_checks: toSortedRows(qualityRuleFailCounts),
  };
}

function runReplayFixtures(fixtures) {
  const list = Array.isArray(fixtures) ? fixtures : [];
  const results = list.map((fixture, index) => runReplayFixture(fixture, { index }));
  const summary = summarizeReplayResults(results);
  return { results, summary };
}

function runReplayFromDir({ fixturesDir = DEFAULT_FIXTURES_DIR, onlyNames = [] } = {}) {
  const fixtures = loadReplayFixtures({ fixturesDir, onlyNames });
  const report = runReplayFixtures(fixtures);
  return { fixtures, ...report };
}

module.exports = {
  DEFAULT_FIXTURES_DIR,
  listFixtureFiles,
  loadReplayFixtures,
  runReplayFixture,
  runReplayFixtures,
  runReplayFromDir,
  __internal: {
    buildReplayCtx,
    buildSeedEnvelopeInput,
    evaluateFixtureExpectations,
    collectQualityFailureReasons,
    expandForbiddenAliases,
    summarizeReplayResults,
  },
};
