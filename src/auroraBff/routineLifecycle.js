'use strict';

/**
 * Routine lifecycle stage detection and context builder.
 *
 * Stages:
 *   - first_time:  No previous routine in profile
 *   - follow_up:   Previous routine exists and user submitted a new one
 *   - optimization: Routine expert detected issues, or user requested optimization
 *   - photo_trigger: Routine was updated recently, prompting a follow-up diagnosis
 */

function detectRoutineLifecycleStage({
  routineCandidate,
  previousRoutine,
  routineExpertIssues,
  lastRoutineUpdateTs,
  intent,
} = {}) {
  if (intent === 'optimize' || intent === 'analysis_optimize_existing' || intent === 'analysis_review_products') {
    return 'optimization';
  }

  const hasPrevious = hasNonEmptyRoutine(previousRoutine);
  const hasCurrent = hasNonEmptyRoutine(routineCandidate);

  if (hasCurrent && hasPrevious) {
    return 'follow_up';
  }

  if (hasCurrent && !hasPrevious) {
    return 'first_time';
  }

  if (lastRoutineUpdateTs) {
    const daysSinceUpdate = (Date.now() - new Date(lastRoutineUpdateTs).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate >= 6 && daysSinceUpdate <= 21) {
      return 'photo_trigger';
    }
  }

  if (routineExpertIssues && routineExpertIssues.length > 0) {
    return 'optimization';
  }

  return hasCurrent ? 'first_time' : null;
}

function hasNonEmptyRoutine(routine) {
  if (!routine) return false;
  if (typeof routine === 'string') return routine.trim().length > 0;
  if (typeof routine !== 'object' || Array.isArray(routine)) return false;
  const am = Array.isArray(routine.am) ? routine.am : [];
  const pm = Array.isArray(routine.pm) ? routine.pm : [];
  const notes = String(routine.notes || '').trim();
  return am.length > 0 || pm.length > 0 || notes.length > 0;
}

function diffRoutines(previousRoutine, currentRoutine) {
  const prev = normalizeRoutineStepsForDiff(previousRoutine);
  const curr = normalizeRoutineStepsForDiff(currentRoutine);

  const added = [];
  const removed = [];
  const replaced = [];
  const unchanged = [];

  for (const slot of ['am', 'pm']) {
    const prevSlot = prev[slot] || {};
    const currSlot = curr[slot] || {};
    const allSteps = new Set([...Object.keys(prevSlot), ...Object.keys(currSlot)]);

    for (const step of allSteps) {
      const prevProduct = prevSlot[step] || null;
      const currProduct = currSlot[step] || null;

      if (!prevProduct && currProduct) {
        added.push({ slot, step, product: currProduct });
      } else if (prevProduct && !currProduct) {
        removed.push({ slot, step, product: prevProduct });
      } else if (prevProduct && currProduct && prevProduct.toLowerCase() !== currProduct.toLowerCase()) {
        replaced.push({ slot, step, from: prevProduct, to: currProduct });
      } else if (prevProduct && currProduct) {
        unchanged.push({ slot, step, product: currProduct });
      }
    }
  }

  const prevNotes = String((previousRoutine && previousRoutine.notes) || '').trim();
  const currNotes = String((currentRoutine && currentRoutine.notes) || '').trim();
  const notesChanged = prevNotes !== currNotes;

  const changeScale = added.length + removed.length + replaced.length;
  const magnitude = changeScale === 0 ? 'none' : changeScale <= 2 ? 'minor' : 'major';

  return { added, removed, replaced, unchanged, notes_changed: notesChanged, magnitude };
}

function normalizeRoutineStepsForDiff(routine) {
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) return { am: {}, pm: {} };
  const result = { am: {}, pm: {} };

  for (const slot of ['am', 'pm']) {
    const steps = Array.isArray(routine[slot]) ? routine[slot] : [];
    for (const entry of steps) {
      if (!entry || typeof entry !== 'object') continue;
      const step = String(entry.step || '').trim().toLowerCase();
      const product = String(entry.product || '').trim();
      if (step && product) result[slot][step] = product;
    }
  }

  return result;
}

function buildRoutineLifecycleContext({
  stage,
  routineCandidate,
  previousRoutine,
  profileSummary,
  routineExpert,
  lastDiagnosisTs,
  lastRoutineUpdateTs,
  language,
} = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const context = { stage, language: lang };

  if (stage === 'first_time') {
    const profile = profileSummary || {};
    const hasDiagnosis = Boolean(profile.skinType || (profile.goals && profile.goals.length));
    context.has_diagnosis = hasDiagnosis;
    context.profile_completeness = assessProfileCompleteness(profile);
    if (hasDiagnosis) {
      context.diagnosis_context = {
        skinType: profile.skinType || null,
        sensitivity: profile.sensitivity || null,
        barrierStatus: profile.barrierStatus || null,
        goals: profile.goals || [],
      };
    }
  }

  if (stage === 'follow_up') {
    context.diff = diffRoutines(previousRoutine, routineCandidate);
    context.profile_completeness = assessProfileCompleteness(profileSummary || {});
  }

  if (stage === 'optimization') {
    if (routineExpert && routineExpert.key_issues) {
      context.existing_issues = routineExpert.key_issues;
    }
  }

  if (stage === 'photo_trigger') {
    context.last_diagnosis_ts = lastDiagnosisTs || null;
    context.last_routine_update_ts = lastRoutineUpdateTs || null;
    if (lastRoutineUpdateTs) {
      context.days_since_update = Math.floor(
        (Date.now() - new Date(lastRoutineUpdateTs).getTime()) / (1000 * 60 * 60 * 24),
      );
    }
  }

  return context;
}

function assessProfileCompleteness(profile) {
  const fields = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
  const missing = [];
  for (const f of fields) {
    const val = profile[f];
    if (!val || (Array.isArray(val) && val.length === 0)) missing.push(f);
  }

  const safetyFields = ['pregnancy_status', 'age_band'];
  const missingSafety = [];
  for (const f of safetyFields) {
    if (!profile[f] || profile[f] === 'unknown') missingSafety.push(f);
  }

  return {
    complete_pct: Math.round(((fields.length - missing.length) / fields.length) * 100),
    missing_fields: missing,
    missing_safety_fields: missingSafety,
  };
}

function buildLifecyclePromptInstructions(lifecycleContext, language) {
  if (!lifecycleContext || !lifecycleContext.stage) return '';
  const lang = language === 'CN' ? 'CN' : 'EN';
  const stage = lifecycleContext.stage;

  if (stage === 'first_time') {
    if (lang === 'CN') {
      const hasDx = lifecycleContext.has_diagnosis;
      return (
        `\nroutine_lifecycle: first_time\n` +
        (hasDx
          ? `routine_first_time_rule: 这是用户首次提交routine。必须将routine中的产品与用户的诊断结果（肤质、目标、皮肤发现）做交叉匹配分析。输出：(1)目标覆盖度——哪些目标被routine中的产品覆盖、哪些存在缺口；(2)产品配合分析——成分协同或冲突；(3)匹配度评分(0-100)和各维度得分(成分安全/目标覆盖/屏障友好/刺激风险)；(4)个性化使用计划——基于用户皮肤耐受度建议引入节奏。\n`
          : `routine_first_time_rule: 这是用户首次提交routine但无历史诊断。输出：(1)产品组合效果分析——基于成分分析配合使用效果；(2)适用人群——这套routine适合什么肤质和皮肤状态；(3)成分安全检查；(4)建议用户上传照片做皮肤诊断以获得更精准的匹配分析。\n`)
      );
    }
    const hasDx = lifecycleContext.has_diagnosis;
    return (
      `\nroutine_lifecycle: first_time\n` +
      (hasDx
        ? `routine_first_time_rule: This is the user's first routine submission. Cross-match routine products against their diagnosis (skin type, goals, findings). Output: (1) goal coverage—which goals are addressed by routine products and which have gaps; (2) product compatibility—ingredient synergies or conflicts; (3) match score (0-100) with dimension scores (ingredient safety / goal coverage / barrier friendliness / irritation risk); (4) personalized onboarding plan based on skin tolerance.\n`
        : `routine_first_time_rule: This is the user's first routine submission with no prior diagnosis. Output: (1) product combination analysis—effectiveness based on ingredients; (2) suitability—what skin types/conditions this routine suits; (3) ingredient safety check; (4) suggest uploading a photo for skin diagnosis to enable more precise matching.\n`)
    );
  }

  if (stage === 'follow_up') {
    const diff = lifecycleContext.diff || {};
    const diffSummary = JSON.stringify({
      added: (diff.added || []).length,
      removed: (diff.removed || []).length,
      replaced: (diff.replaced || []).length,
      magnitude: diff.magnitude || 'unknown',
    });

    if (lang === 'CN') {
      return (
        `\nroutine_lifecycle: follow_up\n` +
        `routine_diff_summary: ${diffSummary}\n` +
        `routine_followup_rule: 用户更新了routine。必须输出：(1)变更对比——新增/移除/替换了什么；(2)对现有目标的影响评估——变更是否有助于目标；(3)观察计划——变更后应观察什么指标、观察多久；(4)信息补全提醒——检查用户profile中是否缺失关键字段（如涉及强活性成分时确认是否在备孕或怀孕中）。\n`
      );
    }
    return (
      `\nroutine_lifecycle: follow_up\n` +
      `routine_diff_summary: ${diffSummary}\n` +
      `routine_followup_rule: The user updated their routine. Output: (1) change comparison—what was added/removed/replaced; (2) impact on existing goals—whether changes help achieve goals; (3) observation plan—what to monitor after changes and for how long; (4) info completeness check—flag missing profile fields (e.g., confirm whether planning pregnancy or pregnant when strong actives are involved).\n`
    );
  }

  if (stage === 'optimization') {
    const issues = lifecycleContext.existing_issues || [];
    const issueIds = issues.map((i) => i.id || i.title || 'unknown').slice(0, 5);

    if (lang === 'CN') {
      return (
        `\nroutine_lifecycle: optimization\n` +
        `routine_known_issues: ${JSON.stringify(issueIds)}\n` +
        `routine_optimization_rule: routine存在已知问题。必须从以下维度输出优化建议：(1)成分匹配——当前成分是否最优、是否有更好替代；(2)目标对齐——routine是否充分覆盖目标；(3)皮肤状况适配——是否过于激进/保守；(4)结构合理性——步骤顺序、AM/PM分配、频率；(5)安全性。给出keep/replace/add/remove/reorder的可执行方案和优先级。\n`
      );
    }
    return (
      `\nroutine_lifecycle: optimization\n` +
      `routine_known_issues: ${JSON.stringify(issueIds)}\n` +
      `routine_optimization_rule: Routine has known issues. Provide optimization from these dimensions: (1) ingredient match—are current actives optimal, better alternatives; (2) goal alignment—does routine fully cover goals; (3) skin condition fit—too aggressive/conservative; (4) structural soundness—step order, AM/PM allocation, frequency; (5) safety. Output actionable keep/replace/add/remove/reorder recommendations with priority ranking.\n`
    );
  }

  if (stage === 'photo_trigger') {
    const days = lifecycleContext.days_since_update || 0;
    if (lang === 'CN') {
      return (
        `\nroutine_lifecycle: photo_trigger\n` +
        `routine_photo_trigger_rule: 用户在${days}天前更新了routine。建议用户拍照做跟进诊断，以对比变更前后的皮肤变化。如果用户已有之前的诊断结果，应比较前后差异并评估routine变更的效果。\n`
      );
    }
    return (
      `\nroutine_lifecycle: photo_trigger\n` +
      `routine_photo_trigger_rule: User updated routine ${days} days ago. Suggest a follow-up photo diagnosis to compare skin changes before and after the routine update. If prior diagnosis exists, compare findings and assess the effectiveness of routine changes.\n`
    );
  }

  return '';
}

function buildSupplementaryPromptInstructions({ routineCandidate, profileSummary, language } = {}) {
  if (!routineCandidate || typeof routineCandidate !== 'object') return '';
  const lang = language === 'CN' ? 'CN' : 'EN';
  const instructions = [];

  const parsed = parseRoutineForSupplementary(routineCandidate);
  const actives = parsed.actives;

  const strongActives = actives.filter((a) =>
    ['retinoid', 'aha', 'bha', 'benzoyl_peroxide', 'hydroquinone', 'vitamin_c_laa'].includes(a),
  );
  if (strongActives.length > 0) {
    if (lang === 'CN') {
      instructions.push(
        `tolerance_ladder_rule: routine中包含强活性成分(${strongActives.join(', ')})。` +
        `在plan_7d和upgrade_path中，建议渐进式引入：Phase 1(1-2周)每周2次建立耐受 → Phase 2(3-4周)隔日 → Phase 3(5周+)每日。` +
        `若notes中提到刺痛/泛红/脱皮，应降级频率而非增加。`,
      );
    } else {
      instructions.push(
        `tolerance_ladder_rule: Routine contains strong actives (${strongActives.join(', ')}). ` +
        `In plan_7d and upgrade_path, suggest progressive introduction: Phase 1 (weeks 1-2) 2x/week to build tolerance → Phase 2 (weeks 3-4) every other day → Phase 3 (week 5+) daily. ` +
        `If notes mention stinging/redness/peeling, downgrade frequency instead of increasing.`,
      );
    }
  }

  if (actives.length >= 3) {
    const conflictPairs = detectActiveConflicts(actives);
    if (conflictPairs.length > 0) {
      const pairsStr = conflictPairs.map((p) => `${p[0]}+${p[1]}`).join(', ');
      if (lang === 'CN') {
        instructions.push(
          `conflict_alert_rule: 检测到潜在成分冲突：${pairsStr}。在routine_expert中必须标记这些冲突并建议分时使用(AM/PM分开或隔天交替)。`,
        );
      } else {
        instructions.push(
          `conflict_alert_rule: Potential ingredient conflicts detected: ${pairsStr}. Flag these in routine_expert and suggest time-separation (AM/PM split or alternate days).`,
        );
      }
    }
  }

  const allSteps = [...(parsed.amSteps || []), ...(parsed.pmSteps || [])];
  if (allSteps.length > 7) {
    if (lang === 'CN') {
      instructions.push(
        `simplification_rule: routine步骤较多(${allSteps.length}步)。考虑在routine_expert中建议简化——找出冗余步骤，合并可替代的步骤，按80/20法则排出核心3-4步。`,
      );
    } else {
      instructions.push(
        `simplification_rule: Routine has many steps (${allSteps.length}). Consider suggesting simplification in routine_expert—identify redundant steps, merge substitutable steps, prioritize core 3-4 steps using 80/20 principle.`,
      );
    }
  }

  if (actives.length >= 4) {
    if (lang === 'CN') {
      instructions.push(
        `active_overload_rule: routine中活性成分过多(${actives.length}种: ${actives.join(', ')})。建议在routine_expert中标记"活性成分过载"风险，优先精简到2-3种核心活性。`,
      );
    } else {
      instructions.push(
        `active_overload_rule: Routine has many actives (${actives.length}: ${actives.join(', ')}). Flag "active overload" risk in routine_expert and recommend trimming to 2-3 core actives.`,
      );
    }
  }

  const profile = profileSummary || {};
  if (profile.sensitivity === 'high' || profile.barrierStatus === 'impaired') {
    if (lang === 'CN') {
      instructions.push(
        `sensitivity_guard_rule: 用户报告高敏感或屏障受损。routine_expert中所有建议必须以屏障修复为优先，暂停非必要活性成分，保持极简(洁面+修护保湿+防晒)。`,
      );
    } else {
      instructions.push(
        `sensitivity_guard_rule: User reports high sensitivity or impaired barrier. All routine_expert recommendations must prioritize barrier repair, pause non-essential actives, keep minimal (cleanser + barrier moisturizer + SPF).`,
      );
    }
  }

  return instructions.length ? '\n' + instructions.join('\n') : '';
}

function parseRoutineForSupplementary(routineCandidate) {
  if (!routineCandidate || typeof routineCandidate !== 'object') return { actives: [], amSteps: [], pmSteps: [] };

  const amSteps = Array.isArray(routineCandidate.am) ? routineCandidate.am : [];
  const pmSteps = Array.isArray(routineCandidate.pm) ? routineCandidate.pm : [];
  const allText = [...amSteps, ...pmSteps]
    .map((s) => String((s && s.product) || '').toLowerCase())
    .join(' ');
  const notes = String(routineCandidate.notes || '').toLowerCase();
  const combined = `${allText} ${notes}`;

  const actives = [];
  if (/retino|retinol|tretinoin|adapalene|tazarotene|维a/i.test(combined)) actives.push('retinoid');
  if (/glycolic|lactic|mandelic|aha|果酸/i.test(combined)) actives.push('aha');
  if (/salicyl|bha|水杨酸/i.test(combined)) actives.push('bha');
  if (/benzoyl|过氧化苯甲酰/i.test(combined)) actives.push('benzoyl_peroxide');
  if (/vitamin\s*c|ascorb|l-ascorb|维c|维生素c/i.test(combined)) actives.push('vitamin_c_laa');
  if (/niacinamide|烟酰胺/i.test(combined)) actives.push('niacinamide');
  if (/azelaic|壬二酸/i.test(combined)) actives.push('azelaic_acid');
  if (/hydroquinone|氢醌|对苯二酚/i.test(combined)) actives.push('hydroquinone');
  if (/tranexamic|传明酸|氨甲环酸/i.test(combined)) actives.push('tranexamic_acid');

  return { actives, amSteps, pmSteps };
}

function detectActiveConflicts(actives) {
  const highRiskPairs = [
    ['retinoid', 'aha'],
    ['retinoid', 'bha'],
    ['aha', 'bha'],
    ['aha', 'benzoyl_peroxide'],
    ['bha', 'benzoyl_peroxide'],
    ['retinoid', 'benzoyl_peroxide'],
    ['retinoid', 'vitamin_c_laa'],
    ['vitamin_c_laa', 'benzoyl_peroxide'],
  ];
  const set = new Set(actives);
  return highRiskPairs.filter(([a, b]) => set.has(a) && set.has(b));
}

module.exports = {
  detectRoutineLifecycleStage,
  hasNonEmptyRoutine,
  diffRoutines,
  buildRoutineLifecycleContext,
  assessProfileCompleteness,
  buildLifecyclePromptInstructions,
  buildSupplementaryPromptInstructions,
  detectActiveConflicts,
  parseRoutineForSupplementary,
};
