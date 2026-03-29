#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {
    analysis: '',
    chat: '',
    out: '',
    md: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--analysis' && next) {
      out.analysis = String(next);
      i += 1;
      continue;
    }
    if (token === '--chat' && next) {
      out.chat = String(next);
      i += 1;
      continue;
    }
    if (token === '--out' && next) {
      out.out = String(next);
      i += 1;
      continue;
    }
    if (token === '--md' && next) {
      out.md = String(next);
      i += 1;
      continue;
    }
  }
  if (!out.analysis) {
    throw new Error('missing --analysis <path>');
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function unwrapEnvelope(value) {
  if (value && typeof value === 'object' && value.json && typeof value.json === 'object') {
    return value.json;
  }
  return value;
}

function firstCard(envelope, type) {
  const cards = Array.isArray(envelope && envelope.cards) ? envelope.cards : [];
  return cards.find((card) => card && card.type === type) || null;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function extractPrimaryFocusFromHeadline(headline) {
  return normalizeToken(pickFirstString(headline));
}

function includesAllTokens(haystack, tokens) {
  const normalizedHaystack = normalizeToken(haystack);
  return tokens.filter(Boolean).every((token) => normalizedHaystack.includes(normalizeToken(token)));
}

function humanSummary(summaryCard, storyCard, ingredientPlanCard, latestRecoContext, recoCard) {
  const summary = summaryCard && summaryCard.payload && summaryCard.payload.summary_v1 || {};
  const topFinding = asArray(summary.top_findings)[0] || {};
  const story = storyCard && storyCard.payload || {};
  const uiCard = story.ui_card_v1 && typeof story.ui_card_v1 === 'object' ? story.ui_card_v1 : {};
  const priorityFinding = asArray(story.priority_findings)[0] || {};
  const firstTarget = ingredientPlanCard && ingredientPlanCard.payload && asArray(ingredientPlanCard.payload.targets)[0] || {};
  const recommendationMeta = recoCard && recoCard.payload && recoCard.payload.recommendation_meta || {};
  const primaryRegion = pickFirstString(topFinding.module_id);
  const primaryIssue = pickFirstString(topFinding.issue_type);
  const regionTokens = [primaryRegion.replace(/_/g, ' '), primaryRegion];
  const issueTokens = [primaryIssue.replace(/_/g, ' '), primaryIssue];

  const topActionIngredientId = pickFirstString(summary.top_action_ingredient_id);
  const topProductId = pickFirstString(summary.top_product_id);
  const topModule = summaryCard && summaryCard.payload && asArray(summaryCard.payload.modules)
    .find((row) => pickFirstString(row && row.module_id) === primaryRegion);
  const topAction = asArray(topModule && topModule.actions)
    .find((row) => pickFirstString(row && row.ingredient_canonical_id, row && row.ingredient_id) === topActionIngredientId)
    || null;
  const topActionStrictProductIds = asArray(topAction && topAction.products)
    .map((row) => pickFirstString(row && row.product_id, row && row.productId))
    .filter(Boolean);

  const headline = pickFirstString(uiCard.headline);
  const priorityTitle = pickFirstString(priorityFinding.title, priorityFinding.detail);
  const firstAction = pickFirstString(asArray(uiCard.actions_now)[0]);
  const targetWhy = pickFirstString(firstTarget.why_match_short, asArray(firstTarget.why)[0]);

  return {
    nodes: {
      summary_v1: {
        primary_region: primaryRegion || null,
        primary_issue: primaryIssue || null,
        confidence_bucket: pickFirstString(topFinding.confidence_bucket) || null,
        caveats: asArray(summary.quality_caveats),
        top_action_ingredient_id: topActionIngredientId || null,
        top_product_id: topProductId || null,
        top_action_strict_product_ids: topActionStrictProductIds,
      },
      analysis_story_v2: {
        headline: headline || null,
        priority_finding_0: priorityTitle || null,
        action_0: firstAction || null,
      },
      ingredient_plan_v2: {
        target_count: asArray(ingredientPlanCard && ingredientPlanCard.payload && ingredientPlanCard.payload.targets).length,
        first_target: {
          ingredient_id: pickFirstString(firstTarget.ingredient_id, firstTarget.ingredientId) || null,
          recommendation_mode: pickFirstString(firstTarget.recommendation_mode) || null,
          strict_product_count: Number(firstTarget.strict_product_count || 0),
          resolved_target_step: pickFirstString(firstTarget.resolved_target_step, firstTarget.target_step_family) || null,
          why_match_short: targetWhy || null,
        },
      },
      latest_reco_context: latestRecoContext || null,
      recommendations: {
        mainline_status: pickFirstString(recommendationMeta.mainline_status) || null,
        source_mode: pickFirstString(recommendationMeta.source_mode) || null,
        grounded_count: Number(recommendationMeta.grounded_count || 0),
        resolved_target_step: pickFirstString(recommendationMeta.resolved_target_step) || null,
      },
    },
    flags: {
      primary_focus_mismatch:
        Boolean(primaryRegion && primaryIssue) && !(
          includesAllTokens(headline, [regionTokens[0], issueTokens[0]])
          && includesAllTokens(priorityTitle, [regionTokens[0], issueTokens[0]])
        ),
      missing_confidence_caveat:
        pickFirstString(topFinding.confidence_bucket) === 'low'
        && !asArray(summary.quality_caveats).some((token) => normalizeToken(token).includes('confidence') || normalizeToken(token).includes('conservative')),
      null_target_step:
        asArray(ingredientPlanCard && ingredientPlanCard.payload && ingredientPlanCard.payload.targets)
          .some((row) => !pickFirstString(row && row.resolved_target_step, row && row.target_step_family)),
      displayed_empty_target:
        asArray(ingredientPlanCard && ingredientPlanCard.payload && ingredientPlanCard.payload.targets)
          .some((row) => Number(row && row.strict_product_count || 0) <= 0 && normalizeToken(row && row.recommendation_mode) !== 'cta_only'),
      top_action_product_mismatch:
        Boolean(topActionIngredientId) && Boolean(topProductId) && !topActionStrictProductIds.includes(topProductId),
      reco_step_mismatch:
        Boolean(pickFirstString(firstTarget.resolved_target_step))
        && Boolean(pickFirstString(recommendationMeta.resolved_target_step))
        && pickFirstString(firstTarget.resolved_target_step) !== pickFirstString(recommendationMeta.resolved_target_step),
    },
  };
}

function toMarkdown(report, sources) {
  const lines = [];
  lines.push('# Aurora Photo Quality Audit');
  lines.push('');
  lines.push(`- analysis: \`${sources.analysis}\``);
  if (sources.chat) lines.push(`- chat: \`${sources.chat}\``);
  lines.push('');
  lines.push('## Nodes');
  lines.push('');
  lines.push(`- summary primary: \`${report.nodes.summary_v1.primary_region || 'n/a'} / ${report.nodes.summary_v1.primary_issue || 'n/a'}\``);
  lines.push(`- story headline: ${report.nodes.analysis_story_v2.headline || 'n/a'}`);
  lines.push(`- story priority[0]: ${report.nodes.analysis_story_v2.priority_finding_0 || 'n/a'}`);
  lines.push(`- story action[0]: ${report.nodes.analysis_story_v2.action_0 || 'n/a'}`);
  lines.push(`- first target: \`${report.nodes.ingredient_plan_v2.first_target.ingredient_id || 'n/a'} / ${report.nodes.ingredient_plan_v2.first_target.resolved_target_step || 'n/a'} / ${report.nodes.ingredient_plan_v2.first_target.recommendation_mode || 'n/a'}\``);
  lines.push(`- reco: \`${report.nodes.recommendations.mainline_status || 'n/a'} / ${report.nodes.recommendations.source_mode || 'n/a'} / step=${report.nodes.recommendations.resolved_target_step || 'n/a'}\``);
  lines.push('');
  lines.push('## Flags');
  lines.push('');
  for (const [key, value] of Object.entries(report.flags)) {
    lines.push(`- ${key}: ${value ? 'true' : 'false'}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const analysisOuter = readJson(args.analysis);
  const chatOuter = args.chat ? readJson(args.chat) : null;
  const analysis = unwrapEnvelope(analysisOuter);
  const chat = unwrapEnvelope(chatOuter);
  const summaryCard = firstCard(analysis, 'photo_modules_v1');
  const storyCard = firstCard(analysis, 'analysis_story_v2');
  const ingredientPlanCard = firstCard(analysis, 'ingredient_plan_v2');
  const latestRecoContext = analysis && analysis.session_patch && analysis.session_patch.state
    ? analysis.session_patch.state.latest_reco_context || null
    : null;
  const recoCard = firstCard(chat, 'recommendations');

  const report = humanSummary(summaryCard, storyCard, ingredientPlanCard, latestRecoContext, recoCard);
  const serialized = JSON.stringify(report, null, 2);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), `${serialized}\n`);
  } else {
    process.stdout.write(`${serialized}\n`);
  }
  if (args.md) {
    fs.writeFileSync(path.resolve(args.md), toMarkdown(report, { analysis: args.analysis, chat: args.chat }));
  }
}

main();
