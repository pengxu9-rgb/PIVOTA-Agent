function createSkinDeepeningRuntime(options = {}) {
  const {
    shouldFireDeepening = null,
    buildDeepeningSignalsDto = null,
  } = options;

  function resolveSkinDeepeningPromptVersion(promptVersion) {
    const token = String(promptVersion || '').trim().toLowerCase();
    if (!token) return 'skin_deepening_v2_canonical';
    if (token === 'skin_v3' || token === 'skin_v3_canonical' || token.includes('v3_canonical')) {
      return 'skin_deepening_v2_canonical';
    }
    if (token === 'skin_deepening_v2_canonical' || token.includes('deepening_v2')) return token;
    return 'skin_deepening_v2_canonical';
  }

  function extractSkinDeepeningSymptoms(recentLogsSummary) {
    const logs = Array.isArray(recentLogsSummary) ? recentLogsSummary : [];
    const out = [];
    const pushToken = (raw) => {
      if (typeof raw !== 'string') return;
      const text = raw.trim();
      if (!text) return;
      out.push(text);
    };
    for (const item of logs.slice(0, 7)) {
      if (!item || typeof item !== 'object') continue;
      pushToken(item.reaction);
      pushToken(item.symptom);
      pushToken(item.note);
      pushToken(item.notes);
      pushToken(item.message);
      if (Array.isArray(item.reactions)) {
        for (const reaction of item.reactions) pushToken(reaction);
      }
      if (Array.isArray(item.symptoms)) {
        for (const symptom of item.symptoms) pushToken(symptom);
      }
    }
    return Array.from(new Set(out)).slice(0, 6);
  }

  function resolveSkinDeepeningPhase({
    userRequestedPhoto,
    photosProvided,
    hasRoutine,
    qualityObject,
    observations,
    userReportedSymptoms,
  } = {}) {
    if (!userRequestedPhoto || !photosProvided) {
      return { phase: 'photo_optin', question_intent: 'photo_upload', reason: 'photo_missing' };
    }
    if (!hasRoutine) {
      return { phase: 'products', question_intent: 'routine_share', reason: 'routine_missing' };
    }
    const gate = shouldFireDeepening({
      qualityObject,
      observations,
      userReportedSymptoms,
    });
    if (gate.fire) {
      return { phase: 'reactions', question_intent: 'reaction_check', reason: gate.reason || 'needs_deepening' };
    }
    return { phase: 'refined', question_intent: 'confirm_plan', reason: 'stable_plan' };
  }

  function buildMainlineDeepeningDto({
    promptVersion,
    userRequestedPhoto,
    photosProvided,
    hasRoutine,
    routineCandidate,
    recentLogsSummary,
    qualityObject,
    reportCanonical,
    visionCanonical,
  } = {}) {
    const observations =
      reportCanonical && Array.isArray(reportCanonical.insights) && reportCanonical.insights.length
        ? reportCanonical.insights
        : visionCanonical && Array.isArray(visionCanonical.observations)
          ? visionCanonical.observations
          : [];
    const reactions = extractSkinDeepeningSymptoms(recentLogsSummary);
    const phasePlan = resolveSkinDeepeningPhase({
      userRequestedPhoto,
      photosProvided,
      hasRoutine,
      qualityObject,
      observations,
      userReportedSymptoms: reactions,
    });
    return {
      dto: buildDeepeningSignalsDto({
        phase: phasePlan.phase,
        questionIntent: phasePlan.question_intent,
        photoChoice: userRequestedPhoto && photosProvided ? 'uploaded' : 'unknown',
        productsSubmitted: hasRoutine,
        routineCandidate,
        reactions,
        summaryPriority: reportCanonical && reportCanonical.summary_focus ? reportCanonical.summary_focus.priority : 'mixed',
        watchouts: reportCanonical && Array.isArray(reportCanonical.watchouts) ? reportCanonical.watchouts : [],
        twoWeekFocus: reportCanonical && Array.isArray(reportCanonical.two_week_focus) ? reportCanonical.two_week_focus : [],
        qualityObject,
      }),
      promptVersion: resolveSkinDeepeningPromptVersion(promptVersion),
      phasePlan,
    };
  }

  return {
    resolveSkinDeepeningPromptVersion,
    extractSkinDeepeningSymptoms,
    resolveSkinDeepeningPhase,
    buildMainlineDeepeningDto,
  };
}

module.exports = {
  createSkinDeepeningRuntime,
};
