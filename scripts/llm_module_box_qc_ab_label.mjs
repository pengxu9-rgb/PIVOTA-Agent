#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';

const SIDE_ORDER = Object.freeze(['A', 'B']);

const HELP_TEXT = `llm_module_box_qc_ab_label.mjs

Usage:
  node scripts/llm_module_box_qc_ab_label.mjs --llm_results <path> [options]

Required:
  --llm_results <path>                   llm_qc_results.jsonl

Options:
  --tasks_json <path>                    preference pack tasks.json (for role mapping)
  --out <dir>                            output dir (default: <llm_results_dir>/ab_label_from_llm_qc)
  --decision_mode <qa|consumer>          decision policy mode (default: qa)
  --hard_block_only <bool>               if true, both_bad blocks only hard-failure pairs (default: false in qa, true in consumer)
  --reject_delta <n>                     minimum score gap to force decision (default: 0.03)
  --enable_both_bad <bool>               mark pair as both_bad when A/B are both low quality (default: true)
  --both_bad_score_max <n>               low-quality score threshold per side (default: 0.22)
  --both_bad_max_diff <n>                max |scoreA-scoreB| for both_bad (default: 0.2)
  --both_bad_ignore_diff_if_both_low <bool>  if true, block when both sides are low even when diff is large (default: true)
  --both_bad_winner_not_clean_enabled <bool> block when winner is still not clean and loser is low quality (default: true)
  --both_bad_winner_not_clean_score_max <n>  winner score max for not-clean gate (default: 0.35)
  --both_bad_winner_not_clean_min_violations <n> min winner violations for not-clean gate (default: 1)
  --both_bad_winner_not_clean_require_loser_low <bool> require loser side low quality for winner-not-clean gate (default: true)
  --both_bad_min_corrected <n>           min corrected modules to mark side as poor (default: 2)
  --both_bad_min_mean_delta <n>          min mean_delta_l1 to mark side as poor (default: 0.1)
  --both_bad_min_severity_penalty <n>    min violation severity penalty to mark side as poor (default: 0.2)
  --both_bad_risk_gate_enabled <bool>    treat selected risk reasons as low-quality signals (default: false)
  --both_bad_risk_reasons_csv <csv>      risk reasons for risk gate (default: module_guard_triggered,module_pixels_min_low)
  --help                                 show help
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseCsvList(value, fallback = []) {
  const token = String(value == null ? '' : value).trim();
  const source = token || String(Array.isArray(fallback) ? fallback.join(',') : fallback || '');
  if (!source) return [];
  const out = [];
  for (const partRaw of source.split(',')) {
    const part = String(partRaw || '').trim().toLowerCase();
    if (!part) continue;
    if (out.includes(part)) continue;
    out.push(part);
  }
  return out;
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeLocalFilesQueryPath(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const marker = '?d=';
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const encoded = text.slice(idx + marker.length).trim();
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function resolveImagePathRaw(rawPath, tasksBaseDir) {
  const text = String(rawPath || '').trim();
  if (!text) return null;
  if (path.isAbsolute(text)) return text;
  return path.resolve(tasksBaseDir, text);
}

function resolveImagePathWithFallback({ absPath, localFileUri, tasksBaseDir }) {
  const viaAbs = resolveImagePathRaw(absPath, tasksBaseDir);
  if (viaAbs) return viaAbs;
  const decoded = decodeLocalFilesQueryPath(localFileUri);
  return resolveImagePathRaw(decoded, tasksBaseDir);
}

function toHtmlHref(targetPath, fromDir, fallbackRel = null) {
  const raw = String(targetPath || '').trim();
  if (raw) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(fromDir, raw);
    let rel = path.relative(fromDir, abs);
    if (!rel) rel = '.';
    rel = rel.split(path.sep).join('/');
    if (!rel.startsWith('.') && !rel.startsWith('/')) rel = `./${rel}`;
    return encodeURI(rel);
  }
  if (!fallbackRel) return null;
  const safeFallback = String(fallbackRel).split(path.sep).join('/');
  return encodeURI(safeFallback);
}

async function readJsonl(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function findNearbyTasksJson(startDir, maxDepth = 6) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, 'tasks.json');
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function buildRoleMap(tasksPayload, tasksBaseDir) {
  const rows = Array.isArray(tasksPayload)
    ? tasksPayload
    : Array.isArray(tasksPayload && tasksPayload.tasks)
      ? tasksPayload.tasks
      : [];
  const out = new Map();
  for (const row of rows) {
    const data = row && typeof row === 'object' && row.data && typeof row.data === 'object'
      ? row.data
      : {};
    const meta = row && typeof row === 'object' && row.meta && typeof row.meta === 'object'
      ? row.meta
      : {};
    const sampleHash = String(data.sample_hash || meta.sample_hash || '').trim();
    if (!sampleHash) continue;
    const roleA = String(data.role_a || meta.role_a || '').trim().toLowerCase();
    const roleB = String(data.role_b || meta.role_b || '').trim().toLowerCase();
    const baselineId = String(data.baseline_id || meta.baseline_id || '').trim() || null;
    const variantId = String(data.variant_id || meta.variant_id || '').trim() || null;
    const imageAPath = resolveImagePathWithFallback({
      absPath: data.image_a_path || meta.image_a_path || '',
      localFileUri: data.image_a || meta.image_a || '',
      tasksBaseDir,
    });
    const imageBPath = resolveImagePathWithFallback({
      absPath: data.image_b_path || meta.image_b_path || '',
      localFileUri: data.image_b || meta.image_b || '',
      tasksBaseDir,
    });
    out.set(sampleHash, {
      role_a: roleA || null,
      role_b: roleB || null,
      baseline_id: baselineId,
      variant_id: variantId,
      image_a_path: imageAPath,
      image_b_path: imageBPath,
    });
  }
  return out;
}

function resolveRoleForSide(side, roleMeta) {
  if (!roleMeta || typeof roleMeta !== 'object') return null;
  const key = String(side || '').toUpperCase() === 'A' ? 'role_a' : 'role_b';
  const value = String(roleMeta[key] || '').trim().toLowerCase();
  if (!value) return null;
  return value;
}

function resolvePipelineForRole(role, roleMeta) {
  const normalized = String(role || '').trim().toLowerCase();
  if (!normalized || !roleMeta || typeof roleMeta !== 'object') return null;
  if (normalized === 'baseline') return roleMeta.baseline_id || null;
  if (normalized === 'variant') return roleMeta.variant_id || null;
  return null;
}

function decisionPenalty(decision) {
  const token = String(decision || '').trim().toLowerCase();
  if (token === 'accept') return 0;
  if (token === 'revise') return 0.45;
  if (token === 'reject') return 1.0;
  return 0.8;
}

function severityPenalty(violations) {
  const list = Array.isArray(violations) ? violations.map((item) => String(item || '').toLowerCase()) : [];
  if (!list.length) return 0;
  let penalty = 0;
  for (const item of list) {
    if (item.includes('cross') || item.includes('multi_face') || item.includes('another person')) penalty += 0.25;
    if (item.includes('chin') && (item.includes('neck') || item.includes('clothing'))) penalty += 0.16;
    if (item.includes('provider_error')) penalty += 0.2;
    if (item.includes('nose') && item.includes('misplaced')) penalty += 0.08;
  }
  return Math.min(0.6, penalty);
}

function hasCriticalViolation(violations) {
  const list = Array.isArray(violations) ? violations.map((item) => String(item || '').toLowerCase()) : [];
  if (!list.length) return false;
  return list.some((item) => (
    item.includes('cross')
    || item.includes('multi_face')
    || item.includes('another person')
  ));
}

function sideScore(row) {
  const decision = String((row && row.decision) || '').trim().toLowerCase();
  const conf = Number.isFinite(Number(row && row.confidence)) ? Number(row.confidence) : 0;
  const correctedCount = Number.isFinite(Number(row && row.corrected_modules_count))
    ? Math.max(0, Number(row.corrected_modules_count))
    : 0;
  const delta = Number.isFinite(Number(row && row.mean_delta_l1)) ? Math.max(0, Number(row.mean_delta_l1)) : 0;
  const penaltyDecision = decisionPenalty(decision);
  const penaltySeverity = severityPenalty(row && row.violations);
  const penaltyFixCount = Math.min(0.35, correctedCount * 0.045);
  const penaltyDelta = Math.min(0.35, delta * 1.6);
  const confidenceBonus = Math.min(0.12, conf * 0.12);
  const score = 1 - penaltyDecision - penaltySeverity - penaltyFixCount - penaltyDelta + confidenceBonus;
  return round4(score);
}

function buildSideSnapshot(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    decision: row.decision || null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    corrected_modules_count: Number.isFinite(Number(row.corrected_modules_count))
      ? Math.max(0, Number(row.corrected_modules_count))
      : 0,
    mean_delta_l1: Number.isFinite(Number(row.mean_delta_l1)) ? Math.max(0, Number(row.mean_delta_l1)) : 0,
    violations: Array.isArray(row.violations) ? row.violations.slice(0, 6) : [],
    escalation_applied: Boolean(row.escalation_applied),
    escalation_selected_secondary: Boolean(row.escalation_selected_secondary),
    primary_decision: row.primary_decision || null,
    secondary_decision: row.secondary_decision || null,
  };
}

function classifySideQuality({ row, score, config }) {
  const decision = String((row && row.decision) || '').trim().toLowerCase();
  const correctedCount = Number.isFinite(Number(row && row.corrected_modules_count))
    ? Math.max(0, Number(row.corrected_modules_count))
    : 0;
  const delta = Number.isFinite(Number(row && row.mean_delta_l1))
    ? Math.max(0, Number(row.mean_delta_l1))
    : 0;
  const severity = severityPenalty(row && row.violations);
  const riskReasons = Array.isArray(row && row.risk_reasons)
    ? row.risk_reasons.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const riskReasonHits = config.riskGateEnabled
    ? riskReasons.filter((reason) => config.riskReasonList.includes(reason))
    : [];
  const flags = [];
  if (decision === 'reject') flags.push('decision_reject');
  if (score <= config.scoreMax) flags.push('score_low');
  if (correctedCount >= config.minCorrected) flags.push('corrected_many');
  if (delta >= config.minMeanDelta) flags.push('delta_high');
  if (severity >= config.minSeverityPenalty) flags.push('violations_severe');
  if (decision === 'revise') flags.push('decision_revise');
  for (const reason of riskReasonHits) flags.push(`risk_reason_${reason}`);

  const lowByReject = decision === 'reject';
  const lowByScoreAndSignal = score <= config.scoreMax
    && (decision !== 'accept' || correctedCount >= config.minCorrected || delta >= config.minMeanDelta || severity >= config.minSeverityPenalty);
  const lowByRevise = decision === 'revise' && correctedCount >= config.minCorrected && delta >= config.minMeanDelta;
  const lowBySeverity = severity >= config.minSeverityPenalty && (decision !== 'accept' || score <= config.scoreMax + 0.06);
  const lowByRiskGate = config.riskGateEnabled
    && riskReasonHits.length > 0
    && decision !== 'accept'
    && (
      correctedCount >= config.minCorrected
      || delta >= config.minMeanDelta
      || severity >= config.minSeverityPenalty
      || score <= config.scoreMax + 0.08
    );

  return {
    is_low_quality: Boolean(lowByReject || lowByScoreAndSignal || lowByRevise || lowBySeverity || lowByRiskGate),
    decision,
    score: round4(score),
    corrected_modules_count: correctedCount,
    mean_delta_l1: round4(delta),
    severity_penalty: round4(severity),
    risk_reason_hits: riskReasonHits,
    flags,
  };
}

function buildPairDecision({ sampleHash, source, rowA, rowB, rejectDelta, roleMeta, bothBadConfig, decisionPolicy }) {
  const scoreA = sideScore(rowA);
  const scoreB = sideScore(rowB);
  const diff = round4(scoreA - scoreB);
  const roleA = resolveRoleForSide('A', roleMeta);
  const roleB = resolveRoleForSide('B', roleMeta);
  const imageAPath = roleMeta && typeof roleMeta === 'object' ? roleMeta.image_a_path || null : null;
  const imageBPath = roleMeta && typeof roleMeta === 'object' ? roleMeta.image_b_path || null : null;
  const sideQualityA = classifySideQuality({ row: rowA, score: scoreA, config: bothBadConfig });
  const sideQualityB = classifySideQuality({ row: rowB, score: scoreB, config: bothBadConfig });
  const bothLowQuality = sideQualityA.is_low_quality && sideQualityB.is_low_quality;

  const provisionalWinnerSide = scoreA >= scoreB ? 'A' : 'B';
  const provisionalWinnerRow = provisionalWinnerSide === 'A' ? rowA : rowB;
  const provisionalWinnerScore = provisionalWinnerSide === 'A' ? scoreA : scoreB;
  const provisionalWinnerQuality = provisionalWinnerSide === 'A' ? sideQualityA : sideQualityB;
  const provisionalLoserQuality = provisionalWinnerSide === 'A' ? sideQualityB : sideQualityA;
  const provisionalWinnerViolations = Array.isArray(provisionalWinnerRow && provisionalWinnerRow.violations)
    ? provisionalWinnerRow.violations.length
    : 0;
  const winnerNotCleanTriggered = Boolean(
    bothBadConfig.enabled
    && bothBadConfig.winnerNotCleanGateEnabled
    && String((provisionalWinnerRow && provisionalWinnerRow.decision) || '').trim().toLowerCase() !== 'accept'
    && provisionalWinnerScore <= bothBadConfig.winnerNotCleanScoreMax
    && provisionalWinnerViolations >= bothBadConfig.winnerNotCleanMinViolations
    && (!bothBadConfig.winnerNotCleanRequiresLoserLow || provisionalLoserQuality.is_low_quality),
  );

  const bothLowTriggered = Boolean(
    bothBadConfig.enabled
    && bothLowQuality
    && (
      bothBadConfig.ignoreDiffWhenBothLow
      || Math.abs(diff) <= bothBadConfig.maxDiff
    ),
  );
  const gateReasons = [];
  if (bothLowTriggered) gateReasons.push('both_sides_low_quality');
  if (winnerNotCleanTriggered) gateReasons.push('winner_not_clean_and_loser_low_quality');
  const bothBadTriggered = Boolean(gateReasons.length);

  const hardFailureReasons = [];
  if (hasCriticalViolation(rowA && rowA.violations) || hasCriticalViolation(rowB && rowB.violations)) {
    hardFailureReasons.push('critical_violation');
  }
  if (sideQualityA.decision === 'reject' && sideQualityB.decision === 'reject') {
    hardFailureReasons.push('double_reject');
  }
  const veryLowScoreThreshold = round4(Math.max(-2, bothBadConfig.scoreMax - 0.08));
  if (scoreA <= veryLowScoreThreshold && scoreB <= veryLowScoreThreshold) {
    const hasAnyReject = sideQualityA.decision === 'reject' || sideQualityB.decision === 'reject';
    const bothSevereViolations = sideQualityA.severity_penalty >= bothBadConfig.minSeverityPenalty
      && sideQualityB.severity_penalty >= bothBadConfig.minSeverityPenalty;
    // Consumer hard-block should not block "both revise but repairable" pairs only due low scores.
    if (hasAnyReject || bothSevereViolations) {
      hardFailureReasons.push('both_scores_very_low');
    }
  }
  const hardFailure = hardFailureReasons.length > 0;
  const hardBlockOnly = Boolean(decisionPolicy && decisionPolicy.hardBlockOnly);
  const shouldBlock = bothBadTriggered && (!hardBlockOnly || hardFailure);

  if (shouldBlock) {
    return {
      sample_hash: sampleHash,
      source: source || null,
      decision_class: 'both_bad',
      preferred_side: null,
      rejected_side: null,
      role_a: roleA,
      role_b: roleB,
      preferred_role: null,
      rejected_role: null,
      preferred_pipeline_id: null,
      rejected_pipeline_id: null,
      image_a_path: imageAPath,
      image_b_path: imageBPath,
      preference_strength: 'both_bad',
      needs_manual_review: false,
      blocked_before_manual: true,
      score_a: scoreA,
      score_b: scoreB,
      score_diff_a_minus_b: diff,
      decision_mode: decisionPolicy && decisionPolicy.mode ? decisionPolicy.mode : 'qa',
      hard_block_only: hardBlockOnly,
      both_bad_triggered: bothBadTriggered,
      both_bad_reasons: gateReasons,
      hard_failure_signals: hardFailureReasons,
      rationale: {
        reason: gateReasons.length === 1 ? gateReasons[0] : 'multi_gate_block',
        reasons: gateReasons,
        decision_policy: {
          mode: decisionPolicy && decisionPolicy.mode ? decisionPolicy.mode : 'qa',
          hard_block_only: hardBlockOnly,
          hard_failure: hardFailure,
          hard_failure_reasons: hardFailureReasons,
          bypassed_soft_block: false,
        },
        both_low_quality: bothLowQuality,
        both_bad_max_diff: bothBadConfig.maxDiff,
        both_bad_ignore_diff_if_both_low: bothBadConfig.ignoreDiffWhenBothLow,
        winner_not_clean_gate: {
          enabled: bothBadConfig.winnerNotCleanGateEnabled,
          winner_side: provisionalWinnerSide,
          winner_score: provisionalWinnerScore,
          winner_low_quality: provisionalWinnerQuality.is_low_quality,
          winner_decision: String((provisionalWinnerRow && provisionalWinnerRow.decision) || '').trim().toLowerCase() || null,
          winner_violations_count: provisionalWinnerViolations,
          winner_score_max: bothBadConfig.winnerNotCleanScoreMax,
          winner_min_violations: bothBadConfig.winnerNotCleanMinViolations,
          require_loser_low_quality: bothBadConfig.winnerNotCleanRequiresLoserLow,
        },
        side_a_quality: sideQualityA,
        side_b_quality: sideQualityB,
      },
      side_quality: {
        A: sideQualityA,
        B: sideQualityB,
      },
      side_a: buildSideSnapshot(rowA),
      side_b: buildSideSnapshot(rowB),
    };
  }

  let preferredSide = null;
  let label = 'tie';
  const softBlockBypassed = bothBadTriggered && !shouldBlock;
  if (softBlockBypassed) {
    preferredSide = provisionalWinnerSide;
    label = 'weak_preference';
  } else if (Math.abs(diff) < rejectDelta) {
    preferredSide = scoreA >= scoreB ? 'A' : 'B';
    label = 'weak_preference';
  } else {
    preferredSide = diff > 0 ? 'A' : 'B';
    label = 'strong_preference';
  }

  const loserSide = preferredSide === 'A' ? 'B' : 'A';
  const winner = preferredSide === 'A' ? rowA : rowB;
  const loser = preferredSide === 'A' ? rowB : rowA;
  const preferredRole = preferredSide === 'A' ? roleA : roleB;
  const rejectedRole = preferredSide === 'A' ? roleB : roleA;
  const preferredPipelineId = resolvePipelineForRole(preferredRole, roleMeta);
  const rejectedPipelineId = resolvePipelineForRole(rejectedRole, roleMeta);
  const baseNeedsManualReview = label === 'weak_preference' || !preferredRole || !rejectedRole;
  const needsManualReview = decisionPolicy && decisionPolicy.mode === 'consumer'
    ? (!preferredRole || !rejectedRole)
    : baseNeedsManualReview;

  const reason = {
    winner_decision: winner ? winner.decision : null,
    loser_decision: loser ? loser.decision : null,
    winner_corrected_modules_count: winner ? winner.corrected_modules_count : null,
    loser_corrected_modules_count: loser ? loser.corrected_modules_count : null,
    winner_mean_delta_l1: winner ? winner.mean_delta_l1 : null,
    loser_mean_delta_l1: loser ? loser.mean_delta_l1 : null,
    winner_violations: winner && Array.isArray(winner.violations) ? winner.violations.slice(0, 6) : [],
    loser_violations: loser && Array.isArray(loser.violations) ? loser.violations.slice(0, 6) : [],
    both_bad_gate: {
      triggered: bothBadTriggered,
      reasons: gateReasons,
      hard_failure: hardFailure,
      hard_failure_reasons: hardFailureReasons,
      blocked_by_policy: false,
      bypassed_soft_block: softBlockBypassed,
      mode: decisionPolicy && decisionPolicy.mode ? decisionPolicy.mode : 'qa',
      hard_block_only: hardBlockOnly,
    },
  };

  return {
    sample_hash: sampleHash,
    source: source || null,
    decision_class: preferredSide === 'A' ? 'a_win' : 'b_win',
    preferred_side: preferredSide,
    rejected_side: loserSide,
    role_a: roleA,
    role_b: roleB,
    preferred_role: preferredRole,
    rejected_role: rejectedRole,
    preferred_pipeline_id: preferredPipelineId,
    rejected_pipeline_id: rejectedPipelineId,
    image_a_path: imageAPath,
    image_b_path: imageBPath,
    preference_strength: label,
    needs_manual_review: needsManualReview,
    blocked_before_manual: false,
    score_a: scoreA,
    score_b: scoreB,
    score_diff_a_minus_b: diff,
    decision_mode: decisionPolicy && decisionPolicy.mode ? decisionPolicy.mode : 'qa',
    hard_block_only: hardBlockOnly,
    both_bad_triggered: bothBadTriggered,
    both_bad_reasons: gateReasons,
    hard_failure_signals: hardFailureReasons,
    rationale: reason,
    side_quality: {
      A: sideQualityA,
      B: sideQualityB,
    },
    side_a: buildSideSnapshot(rowA),
    side_b: buildSideSnapshot(rowB),
  };
}

function renderReviewHtml({ title, subtitle, rows, outDir }) {
  const total = rows.length;
  const baselineWins = rows.filter((row) => String(row.preferred_role || '') === 'baseline').length;
  const variantWins = rows.filter((row) => String(row.preferred_role || '') === 'variant').length;
  const weakCount = rows.filter((row) => String(row.preference_strength || '') === 'weak_preference').length;
  const blockedCount = rows.filter((row) => Boolean(row.blocked_before_manual)).length;

  const items = rows.map((row, idx) => {
    const sampleHash = String(row.sample_hash || '');
    const source = String(row.source || '-');
    const strength = String(row.preference_strength || 'unknown');
    const isBlocked = Boolean(row.blocked_before_manual) || String(row.decision_class || '') === 'both_bad';
    const tagClass = isBlocked ? 'miss' : (strength === 'weak_preference' ? 'weak' : 'strong');
    const tagText = isBlocked ? 'blocked_before_manual' : strength;

    const preferredSide = row.preferred_side || null;
    const rejectedSide = row.rejected_side || null;
    const preferredRole = row.preferred_role || null;
    const rejectedRole = row.rejected_role || null;

    const fallbackA = `../../images/${sampleHash}_A.png`;
    const fallbackB = `../../images/${sampleHash}_B.png`;
    const imageA = toHtmlHref(row.image_a_path, outDir, fallbackA);
    const imageB = toHtmlHref(row.image_b_path, outDir, fallbackB);
    const panelClassA = preferredSide === 'A' ? 'panel win' : 'panel lose';
    const panelClassB = preferredSide === 'B' ? 'panel win' : 'panel lose';

    const scoreDiff = Number.isFinite(Number(row.score_diff_a_minus_b)) ? Number(row.score_diff_a_minus_b) : 0;
    const scoreA = Number.isFinite(Number(row.score_a)) ? Number(row.score_a) : 0;
    const scoreB = Number.isFinite(Number(row.score_b)) ? Number(row.score_b) : 0;

    const sideA = row.side_a && typeof row.side_a === 'object' ? row.side_a : {};
    const sideB = row.side_b && typeof row.side_b === 'object' ? row.side_b : {};
    const sideSummary = `A:${String(sideA.decision || '-')}/corr=${Number(sideA.corrected_modules_count || 0)}/delta=${Number(sideA.mean_delta_l1 || 0).toFixed(3)} | B:${String(sideB.decision || '-')}/corr=${Number(sideB.corrected_modules_count || 0)}/delta=${Number(sideB.mean_delta_l1 || 0).toFixed(3)}`;

    const decisionLine = isBlocked
      ? 'status: <b>BLOCKED</b> (both_bad) | winner: - | loser: -'
      : `winner: <b>${escapeHtml(String(preferredSide || '-'))}</b> (${escapeHtml(String(preferredRole || '-'))}) | loser: ${escapeHtml(String(rejectedSide || '-'))} (${escapeHtml(String(rejectedRole || '-'))})`;

    return `<section class="item"><div class="meta">#${idx + 1} <b>${escapeHtml(sampleHash)}</b> [${escapeHtml(source)}] <span class="tag ${tagClass}">${escapeHtml(tagText)}</span>${decisionLine} | diff(A-B)=<b>${escapeHtml(scoreDiff.toFixed(4))}</b> | scoreA=<b>${escapeHtml(scoreA.toFixed(4))}</b> scoreB=<b>${escapeHtml(scoreB.toFixed(4))}</b><br/>${escapeHtml(sideSummary)} | <a href="${escapeHtml(String(imageA || ''))}" target="_blank">open A</a> | <a href="${escapeHtml(String(imageB || ''))}" target="_blank">open B</a></div><div class="grid"><div class="${panelClassA}"><div>A (${escapeHtml(String(row.role_a || '-'))})</div><img loading="lazy" src="${escapeHtml(String(imageA || ''))}" alt="${escapeHtml(`${sampleHash}_A`)}" /></div><div class="${panelClassB}"><div>B (${escapeHtml(String(row.role_b || '-'))})</div><img loading="lazy" src="${escapeHtml(String(imageB || ''))}" alt="${escapeHtml(`${sampleHash}_B`)}" /></div></div></section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(title)}</title><style>body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0b0e12;color:#e8eef7;margin:0;padding:16px;}.summary{background:#121722;border:1px solid #2c3445;border-radius:8px;padding:12px;margin-bottom:14px;}.item{border:1px solid #2c3445;background:#111521;border-radius:10px;padding:10px;margin:12px 0;}.meta{font-size:13px;line-height:1.5;margin-bottom:8px;color:#d7deea;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}.panel{border:1px solid #3a4254;border-radius:8px;padding:8px;background:#0f1420;}.win{border-color:#2ec27e;box-shadow:inset 0 0 0 1px #2ec27e;}.lose{border-color:#8a93a6;}img{width:100%;height:auto;border-radius:4px;background:#05070a;}.tag{display:inline-block;padding:1px 6px;border-radius:999px;font-size:12px;margin-right:8px;border:1px solid #42506b;}.weak{color:#ffd58a;border-color:#7a5b2b;}.strong{color:#8be9b5;border-color:#2d6e4f;}.miss{color:#ff9a9a;border-color:#7a2b2b;}a{color:#8ab4ff;}</style></head><body><div class="summary"><div><b>${escapeHtml(title)}</b></div><div>${escapeHtml(subtitle || '')}</div><div>rows: ${total} | baseline_wins: ${baselineWins} | variant_wins: ${variantWins} | weak: ${weakCount} | blocked: ${blockedCount}</div></div>${items}</body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBool(args.help, false)) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const llmResultsRaw = String(args.llm_results || '').trim();
  if (!llmResultsRaw) {
    process.stderr.write('Missing --llm_results\n');
    process.exitCode = 2;
    return;
  }

  const llmResultsPath = path.resolve(llmResultsRaw);
  const rejectDelta = parseNumber(args.reject_delta, 0.03, 0, 1);
  const decisionModeToken = String(args.decision_mode || 'qa').trim().toLowerCase();
  const decisionMode = decisionModeToken === 'consumer' ? 'consumer' : 'qa';
  const hardBlockOnly = parseBool(args.hard_block_only, decisionMode === 'consumer');
  const decisionPolicy = {
    mode: decisionMode,
    hardBlockOnly,
  };
  const bothBadConfig = {
    enabled: parseBool(args.enable_both_bad, true),
    scoreMax: parseNumber(args.both_bad_score_max, 0.22, -2, 1),
    maxDiff: parseNumber(args.both_bad_max_diff, 0.2, 0, 2),
    ignoreDiffWhenBothLow: parseBool(args.both_bad_ignore_diff_if_both_low, true),
    winnerNotCleanGateEnabled: parseBool(args.both_bad_winner_not_clean_enabled, true),
    winnerNotCleanScoreMax: parseNumber(args.both_bad_winner_not_clean_score_max, 0.35, -2, 1),
    winnerNotCleanMinViolations: Math.max(0, Math.min(20, Math.trunc(parseNumber(args.both_bad_winner_not_clean_min_violations, 1, 0, 20)))),
    winnerNotCleanRequiresLoserLow: parseBool(args.both_bad_winner_not_clean_require_loser_low, true),
    minCorrected: Math.max(0, Math.min(20, Math.trunc(parseNumber(args.both_bad_min_corrected, 2, 0, 20)))),
    minMeanDelta: parseNumber(args.both_bad_min_mean_delta, 0.1, 0, 2),
    minSeverityPenalty: parseNumber(args.both_bad_min_severity_penalty, 0.2, 0, 1),
    riskGateEnabled: parseBool(args.both_bad_risk_gate_enabled, false),
    riskReasonList: parseCsvList(
      args.both_bad_risk_reasons_csv,
      ['module_guard_triggered', 'module_pixels_min_low'],
    ),
  };
  const outDir = path.resolve(String(args.out || path.join(path.dirname(llmResultsPath), 'ab_label_from_llm_qc')).trim());
  await fsp.mkdir(outDir, { recursive: true });

  let tasksJsonPath = String(args.tasks_json || '').trim();
  if (!tasksJsonPath) {
    tasksJsonPath = await findNearbyTasksJson(path.dirname(llmResultsPath), 8);
  } else {
    tasksJsonPath = path.resolve(tasksJsonPath);
  }

  const rows = await readJsonl(llmResultsPath);
  const tasksPayload = tasksJsonPath ? await readJsonSafe(tasksJsonPath) : null;
  const tasksBaseDir = tasksJsonPath ? path.dirname(tasksJsonPath) : process.cwd();
  const roleMap = buildRoleMap(tasksPayload, tasksBaseDir);

  const bySample = new Map();
  for (const row of rows) {
    const sampleHash = String(row.sample_hash || '').trim();
    const side = String(row.side || '').trim().toUpperCase();
    if (!sampleHash || !SIDE_ORDER.includes(side)) continue;
    if (!bySample.has(sampleHash)) bySample.set(sampleHash, { source: String(row.source || '').trim() || null });
    bySample.get(sampleHash)[side] = row;
  }

  const decisions = [];
  const missingPairs = [];
  for (const [sampleHash, pair] of bySample.entries()) {
    const rowA = pair.A || null;
    const rowB = pair.B || null;
    if (!rowA || !rowB) {
      missingPairs.push({ sample_hash: sampleHash, has_a: Boolean(rowA), has_b: Boolean(rowB) });
      continue;
    }
    decisions.push(
      buildPairDecision({
        sampleHash,
        source: pair.source,
        rowA,
        rowB,
        rejectDelta,
        bothBadConfig,
        decisionPolicy,
        roleMeta: roleMap.get(sampleHash) || null,
      }),
    );
  }

  decisions.sort((a, b) => String(a.sample_hash || '').localeCompare(String(b.sample_hash || '')));

  const strengthCounts = decisions.reduce((acc, row) => {
    const key = String(row.preference_strength || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const preferredCounts = decisions.reduce((acc, row) => {
    const key = String(row.preferred_side || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const preferredRoleCounts = decisions.reduce((acc, row) => {
    const key = String(row.preferred_role || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const preferredPipelineCounts = decisions.reduce((acc, row) => {
    const key = String(row.preferred_pipeline_id || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const decisionClassCounts = decisions.reduce((acc, row) => {
    const key = String(row.decision_class || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const manualReviewRows = decisions
    .filter((row) => row.needs_manual_review)
    .sort((a, b) => {
      const rankA = String(a.decision_class || '') === 'both_bad' ? 0 : 1;
      const rankB = String(b.decision_class || '') === 'both_bad' ? 0 : 1;
      if (rankA !== rankB) return rankA - rankB;
      return Math.abs(a.score_diff_a_minus_b) - Math.abs(b.score_diff_a_minus_b);
    });
  const blockedRows = decisions
    .filter((row) => Boolean(row.blocked_before_manual))
    .sort((a, b) => Math.abs(a.score_diff_a_minus_b) - Math.abs(b.score_diff_a_minus_b));

  const summary = {
    ok: true,
    llm_results_path: llmResultsPath,
    tasks_json_path: tasksJsonPath || null,
    tasks_role_map_count: roleMap.size,
    out_dir: outDir,
    reject_delta: rejectDelta,
    decision_policy: decisionPolicy,
    both_bad: bothBadConfig,
    rows_total: rows.length,
    paired_total: decisions.length,
    missing_pairs_total: missingPairs.length,
    decision_class_counts: decisionClassCounts,
    preferred_counts: preferredCounts,
    preferred_role_counts: preferredRoleCounts,
    preferred_pipeline_counts: preferredPipelineCounts,
    preference_strength_counts: strengthCounts,
    blocked_total: blockedRows.length,
    manual_review_total: manualReviewRows.length,
  };

  const summaryPath = path.join(outDir, 'summary.json');
  const jsonlPath = path.join(outDir, 'ab_labels.jsonl');
  const labelStudioPath = path.join(outDir, 'ab_labels_for_labelstudio.json');
  const manualReviewPath = path.join(outDir, 'manual_review_queue.jsonl');
  const blockedPath = path.join(outDir, 'blocked_before_manual_queue.jsonl');
  const reviewAllHtmlPath = path.join(outDir, 'review_all_with_images.html');
  const reviewManualHtmlPath = path.join(outDir, 'review_manual_with_images.html');
  const reviewBlockedHtmlPath = path.join(outDir, 'review_blocked_with_images.html');

  await fsp.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    jsonlPath,
    `${decisions.map((row) => JSON.stringify(row)).join('\n')}${decisions.length ? '\n' : ''}`,
    'utf8',
  );
  await fsp.writeFile(
    manualReviewPath,
    `${manualReviewRows.map((row) => JSON.stringify(row)).join('\n')}${manualReviewRows.length ? '\n' : ''}`,
    'utf8',
  );
  await fsp.writeFile(
    blockedPath,
    `${blockedRows.map((row) => JSON.stringify(row)).join('\n')}${blockedRows.length ? '\n' : ''}`,
    'utf8',
  );
  await fsp.writeFile(
    reviewAllHtmlPath,
    renderReviewHtml({
      title: 'A/B Label Review (All)',
      subtitle: `all decisions from ${path.basename(outDir)}`,
      rows: decisions,
      outDir,
    }),
    'utf8',
  );
  await fsp.writeFile(
    reviewManualHtmlPath,
    renderReviewHtml({
      title: 'A/B Label Review (Manual Queue Only)',
      subtitle: `manual queue only from ${path.basename(outDir)}`,
      rows: manualReviewRows,
      outDir,
    }),
    'utf8',
  );
  await fsp.writeFile(
    reviewBlockedHtmlPath,
    renderReviewHtml({
      title: 'A/B Label Review (Blocked Before Manual)',
      subtitle: `blocked before manual from ${path.basename(outDir)}`,
      rows: blockedRows,
      outDir,
    }),
    'utf8',
  );

  const lsTasks = decisions.map((row, idx) => ({
    id: idx + 1,
    data: {
      sample_hash: row.sample_hash,
      source: row.source || null,
      role_a: row.role_a || null,
      role_b: row.role_b || null,
      decision_class: row.decision_class || null,
      is_both_bad: String(row.decision_class || '') === 'both_bad',
      preferred_side: row.preferred_side,
      rejected_side: row.rejected_side,
      preferred_role: row.preferred_role || null,
      rejected_role: row.rejected_role || null,
      preferred_pipeline_id: row.preferred_pipeline_id || null,
      rejected_pipeline_id: row.rejected_pipeline_id || null,
      preference_strength: row.preference_strength,
      blocked_before_manual: Boolean(row.blocked_before_manual),
      needs_manual_review: Boolean(row.needs_manual_review),
      image_a_path: row.image_a_path || null,
      image_b_path: row.image_b_path || null,
      score_a: row.score_a,
      score_b: row.score_b,
      score_diff_a_minus_b: row.score_diff_a_minus_b,
      rationale: row.rationale,
      side_quality: row.side_quality || null,
      decision_mode: row.decision_mode || null,
      hard_block_only: Boolean(row.hard_block_only),
      both_bad_triggered: Boolean(row.both_bad_triggered),
      hard_failure_signals: Array.isArray(row.hard_failure_signals) ? row.hard_failure_signals : [],
    },
  }));
  await fsp.writeFile(labelStudioPath, `${JSON.stringify(lsTasks, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        ...summary,
        artifacts: {
          summary_json: summaryPath,
          ab_labels_jsonl: jsonlPath,
          ab_labels_for_labelstudio_json: labelStudioPath,
          manual_review_queue_jsonl: manualReviewPath,
          blocked_before_manual_queue_jsonl: blockedPath,
          review_all_html: reviewAllHtmlPath,
          review_manual_html: reviewManualHtmlPath,
          review_blocked_html: reviewBlockedHtmlPath,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`llm_module_box_qc_ab_label failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});
