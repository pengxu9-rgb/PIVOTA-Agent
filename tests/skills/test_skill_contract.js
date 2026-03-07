const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { SkillRouter } = require('../../src/auroraBff/orchestrator/skill_router');
const LlmGateway = require('../../src/auroraBff/services/llm_gateway');
const { validateSkillResponse } = require('../../src/auroraBff/validators/schema_validator');

const FIXTURES_PATH = path.resolve(__dirname, '../golden_fixtures/fixture_manifest.json');

function toBool(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function ensureLiveKeys() {
  const geminiKey =
    String(process.env.GEMINI_API_KEY || '').trim() ||
    String(process.env.GEMINI_API_KEY_1 || '').trim() ||
    String(process.env.GEMINI_API_KEY_2 || '').trim() ||
    String(process.env.GEMINI_API_KEY_3 || '').trim();
  if (!geminiKey) {
    throw new Error('AURORA_SKILL_CONTRACT_LIVE=1 requires one of GEMINI_API_KEY, GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_API_KEY_3');
  }
}

async function runTests() {
  const liveMode = toBool(process.env.AURORA_SKILL_CONTRACT_LIVE);
  if (liveMode) {
    ensureLiveKeys();
  }

  const manifest = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8'));
  const gateway = new LlmGateway({ stubResponses: !liveMode });
  const router = new SkillRouter(gateway);

  let passed = 0;
  let failed = 0;

  console.log(`Mode: ${liveMode ? 'live' : 'offline-stub'}\n`);

  for (const fixture of manifest.fixtures) {
    const label = `[${fixture.fixture_id}] ${fixture.scenario}`;
    try {
      const result = await router.route(fixture.request);
      const { errors } = validateSkillResponse(result, fixture.skill_id);

      assertBasicContract(result, errors);

      if (fixture.assertions.quality_ok !== undefined) {
        assert.strictEqual(
          result.quality.quality_ok,
          fixture.assertions.quality_ok,
          `quality_ok mismatch: expected ${fixture.assertions.quality_ok}`
        );
      }

      if (fixture.assertions.preconditions_met !== undefined) {
        assert.strictEqual(
          result.quality.preconditions_met,
          fixture.assertions.preconditions_met,
          'preconditions_met mismatch'
        );
      }

      if (fixture.assertions.cards_min_count) {
        assert.ok(
          result.cards.length >= fixture.assertions.cards_min_count,
          `Expected >= ${fixture.assertions.cards_min_count} cards, got ${result.cards.length}`
        );
      }

      if (fixture.assertions.cards_must_include_types) {
        const cardTypes = new Set(result.cards.map((card) => card.card_type));
        for (const expected of fixture.assertions.cards_must_include_types) {
          assert.ok(cardTypes.has(expected), `Missing expected card type: ${expected}`);
        }
      }

      if (fixture.assertions.next_actions_min_count) {
        assert.ok(
          result.next_actions.length >= fixture.assertions.next_actions_min_count,
          `Expected >= ${fixture.assertions.next_actions_min_count} next_actions, got ${result.next_actions.length}`
        );
      }

      if (fixture.assertions.must_not_contain_visual_analysis) {
        const hasVisual = result.cards.some((card) =>
          (card.sections || []).some((section) => section.type === 'visual_analysis')
        );
        assert.ok(!hasVisual, 'Must not contain visual_analysis section');
      }

      if (fixture.assertions.must_not_contain_product_claims_for_unverified) {
        const serialized = JSON.stringify(result).toLowerCase();
        const forbidden = ['products containing', 'products with this ingredient', '含该成分的产品'];
        for (const phrase of forbidden) {
          assert.ok(!serialized.includes(phrase), `Must not contain forbidden claim: ${phrase}`);
        }
      }

      if (fixture.assertions.all_claims_must_have_evidence_badge) {
        const claimsSections = result.cards.flatMap((card) =>
          (card.sections || []).filter((section) => section.type === 'ingredient_claims')
        );
        assert.ok(claimsSections.length > 0, 'Expected ingredient_claims section');
        for (const section of claimsSections) {
          for (const claim of section.claims || []) {
            assert.ok(claim.evidence_badge, 'Each claim must include evidence_badge');
          }
        }
      }

      if (fixture.assertions.must_not_contain_visual_references) {
        const serialized = JSON.stringify(result).toLowerCase();
        const forbidden = ['visible improvement', 'can see', 'looks like', 'photo shows', '可见改善', '看起来'];
        for (const phrase of forbidden) {
          assert.ok(!serialized.includes(phrase), `Must not contain visual reference: ${phrase}`);
        }
      }

      if (fixture.assertions.next_actions_should_include_photo_prompt) {
        const hasPhotoPrompt = result.next_actions.some((action) => action.action_type === 'trigger_photo');
        assert.ok(hasPhotoPrompt, 'Expected next_actions to include trigger_photo');
      }

      if (fixture.assertions.usage_time_of_day) {
        const usage = findStructuredSection(result, 'product_verdict_structured')?.usage;
        assert.ok(usage, 'Expected product_verdict_structured.usage');
        assert.strictEqual(usage.time_of_day, fixture.assertions.usage_time_of_day);
      }

      if (fixture.assertions.usage_must_include_reapply) {
        const usage = findStructuredSection(result, 'product_verdict_structured')?.usage;
        assert.ok(usage?.reapply, 'Expected usage.reapply');
      }

      if (fixture.assertions.usage_must_not_include) {
        const usageText = JSON.stringify(findStructuredSection(result, 'product_verdict_structured')?.usage || {});
        for (const forbidden of fixture.assertions.usage_must_not_include) {
          assert.ok(!usageText.includes(forbidden), `Usage must not contain: ${forbidden}`);
        }
      }

      if (fixture.assertions.adjustments_must_include_type) {
        const adjustments = findStructuredSection(result, 'travel_structured')?.adjustments || [];
        assert.ok(
          adjustments.some((item) => item.type === fixture.assertions.adjustments_must_include_type),
          `Missing required adjustment type: ${fixture.assertions.adjustments_must_include_type}`
        );
      }

      if (fixture.assertions.adjustments_should_include_type) {
        const adjustments = findStructuredSection(result, 'travel_structured')?.adjustments || [];
        assert.ok(
          adjustments.some((item) => item.type === fixture.assertions.adjustments_should_include_type),
          `Missing expected adjustment type: ${fixture.assertions.adjustments_should_include_type}`
        );
      }

      console.log(`  PASS  ${label}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL  ${label}`);
      console.error(`        ${error.message}`);
      failed += 1;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${manifest.fixtures.length} fixtures`);
  process.exit(failed > 0 ? 1 : 0);
}

function assertBasicContract(result, schemaErrors) {
  assert.ok(schemaErrors.length === 0, `Schema validation failed: ${schemaErrors.join('; ')}`);
  assert.ok(result.cards !== undefined, 'Missing cards');
  assert.ok(result.ops !== undefined, 'Missing ops');
  assert.ok(result.quality !== undefined, 'Missing quality');
  assert.ok(result.telemetry !== undefined, 'Missing telemetry');
  assert.ok(Array.isArray(result.next_actions), 'Missing next_actions');
  assert.ok(result.next_actions.length >= 1, 'next_actions must be non-empty');
  assert.ok(result.telemetry.skill_id.includes('.'), 'skill_id must be dot-separated');
  assert.ok(!('session_patch' in result), 'MUST NOT return session_patch');
  assert.ok(!('assistant_message' in result), 'MUST NOT return assistant_message');
  assert.ok(!('suggested_chips' in result), 'MUST NOT return suggested_chips');
}

function findStructuredSection(result, sectionType) {
  for (const card of result.cards || []) {
    for (const section of card.sections || []) {
      if (section.type === sectionType) {
        return section;
      }
    }
  }
  return null;
}

console.log('Aurora Skill Contract Tests');
console.log('==========================\n');
runTests().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
