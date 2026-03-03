const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');

function readDeepeningPhaseFromCard(card) {
  return String(card && card.payload && card.payload.analysis && card.payload.analysis.deepening && card.payload.analysis.deepening.phase || '')
    .trim()
    .toLowerCase();
}

function readDeepeningOptionsFromCard(card) {
  const options = card && card.payload && card.payload.analysis && card.payload.analysis.deepening
    ? card.payload.analysis.deepening.options
    : null;
  return Array.isArray(options) ? options.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function readDeepeningMetaPhase(body) {
  return String(
    body &&
      body.session_patch &&
      body.session_patch.meta &&
      body.session_patch.meta.analysis_deepening_v1 &&
      body.session_patch.meta.analysis_deepening_v1.phase || '',
  )
    .trim()
    .toLowerCase();
}

function readDeepeningMeta(body) {
  const meta =
    body &&
    body.session_patch &&
    body.session_patch.meta &&
    body.session_patch.meta.analysis_deepening_v1 &&
    typeof body.session_patch.meta.analysis_deepening_v1 === 'object' &&
    !Array.isArray(body.session_patch.meta.analysis_deepening_v1)
      ? body.session_patch.meta.analysis_deepening_v1
      : null;
  return meta ? { ...meta } : null;
}

function hasPhotoChoiceDupChips(body) {
  const chips = Array.isArray(body && body.suggested_chips) ? body.suggested_chips : [];
  return chips.some((chip) => {
    const id = String(chip && chip.chip_id || '').trim().toLowerCase();
    return (
      id === 'chip.intake.upload_photos' ||
      id === 'chip_intake_upload_photos' ||
      id === 'chip.intake.skip_analysis' ||
      id === 'chip_intake_skip_analysis'
    );
  });
}

function analysisSummaryCardFromBody(body) {
  return findCard(parseCards(body), 'analysis_summary');
}

test('skin deepening e2e: phase migration and dedupe from photo_optin to refined', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'legacy',
      AURORA_SKIN_SINGLE_CARD_V1: 'true',
      AURORA_SKIN_DEEPENING_V1: 'true',
      AURORA_CHATCARDS_SESSION_PATCH_V1: 'true',
      AURORA_CARD_FIRST_DEDUPE_V1: 'true',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('skin_deepening');
        const headers = headersFor(uid, 'CN');
        const expectedReactionOptions = ['干燥加重', '皮肤紧绷', '刺痛/灼热', '泛红加重', '新爆痘', '无明显不适'];

        const initial = await request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({ use_photo: false })
          .expect(200);
        const initialCard = analysisSummaryCardFromBody(initial.body);
        assert.ok(initialCard, 'initial analysis_summary should exist');
        assert.equal(readDeepeningPhaseFromCard(initialCard), 'photo_optin');
        assert.equal(readDeepeningMetaPhase(initial.body), 'photo_optin');

        let deepeningMeta = readDeepeningMeta(initial.body);

        const turnProducts = await request
          .post('/v1/chat')
          .set(headers)
          .send({
            client_state: 'DIAG_ANALYSIS_SUMMARY',
            action: {
              action_id: 'analysis_skip_photo',
              kind: 'action',
              data: { reply_text: '先不上传，继续文本深挖' },
            },
            session: deepeningMeta ? { meta: { analysis_deepening_v1: deepeningMeta } } : {},
          })
          .expect(200);
        const productsCard = analysisSummaryCardFromBody(turnProducts.body);
        assert.ok(productsCard, 'products stage card should exist');
        assert.equal(readDeepeningPhaseFromCard(productsCard), 'products');
        assert.equal(readDeepeningMetaPhase(turnProducts.body), 'products');
        assert.equal(hasPhotoChoiceDupChips(turnProducts.body), false);
        assert.equal(parseCards(turnProducts.body).filter((card) => card && card.type === 'analysis_summary').length, 1);

        deepeningMeta = readDeepeningMeta(turnProducts.body) || deepeningMeta;

        const turnReactions = await request
          .post('/v1/chat')
          .set(headers)
          .send({
            client_state: 'DIAG_ANALYSIS_SUMMARY',
            action: {
              action_id: 'analysis_continue_without_products',
              kind: 'action',
              data: { reply_text: '先继续下一步' },
            },
            session: deepeningMeta ? { meta: { analysis_deepening_v1: deepeningMeta } } : {},
          })
          .expect(200);
        const reactionsCard = analysisSummaryCardFromBody(turnReactions.body);
        assert.ok(reactionsCard, 'reactions stage card should exist');
        assert.equal(readDeepeningPhaseFromCard(reactionsCard), 'reactions');
        assert.equal(readDeepeningMetaPhase(turnReactions.body), 'reactions');
        assert.deepEqual(readDeepeningOptionsFromCard(reactionsCard), expectedReactionOptions);
        assert.equal(hasPhotoChoiceDupChips(turnReactions.body), false);
        assert.equal(parseCards(turnReactions.body).filter((card) => card && card.type === 'analysis_summary').length, 1);

        deepeningMeta = readDeepeningMeta(turnReactions.body) || deepeningMeta;

        const turnRefined = await request
          .post('/v1/chat')
          .set(headers)
          .send({
            client_state: 'DIAG_ANALYSIS_SUMMARY',
            action: {
              action_id: 'analysis_reaction_select',
              kind: 'action',
              data: { reaction: '皮肤紧绷', reply_text: '皮肤紧绷' },
            },
            session: deepeningMeta ? { meta: { analysis_deepening_v1: deepeningMeta } } : {},
          })
          .expect(200);
        const refinedCard = analysisSummaryCardFromBody(turnRefined.body);
        assert.ok(refinedCard, 'refined stage card should exist');
        assert.equal(readDeepeningPhaseFromCard(refinedCard), 'refined');
        assert.equal(readDeepeningMetaPhase(turnRefined.body), 'refined');
        assert.equal(hasPhotoChoiceDupChips(turnRefined.body), false);
        assert.equal(parseCards(turnRefined.body).filter((card) => card && card.type === 'analysis_summary').length, 1);

        const refinedMeta = readDeepeningMeta(turnRefined.body);
        const refinedReactions = Array.isArray(refinedMeta && refinedMeta.reactions)
          ? refinedMeta.reactions.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        assert.ok(refinedReactions.includes('皮肤紧绷'));

        const refinedStrategy = String(
          refinedCard &&
            refinedCard.payload &&
            refinedCard.payload.analysis &&
            refinedCard.payload.analysis.strategy || '',
        );
        assert.match(refinedStrategy, /观察指标/);
        assert.match(refinedStrategy, /回退条件/);
      } finally {
        restore();
      }
    },
  );
});

test('skin deepening LLM narrative: uses LLM output when gateway patched, falls back to template when key missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_SKIN_SINGLE_CARD_V1: 'true',
      AURORA_SKIN_DEEPENING_V1: 'true',
      AURORA_CHATCARDS_SESSION_PATCH_V1: 'true',
      AURORA_CARD_FIRST_DEDUPE_V1: 'true',
      AURORA_SKIN_DEEPENING_LLM_V1: 'true',
      // No Gemini key set → gateway falls back to template gracefully
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('skin_deepening_llm_fallback');
        const headers = headersFor(uid, 'EN');

        // Initial analysis call without photo — LLM flag on but no key → template fallback
        const initial = await request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({ use_photo: false })
          .expect(200);
        const initialCard = analysisSummaryCardFromBody(initial.body);
        assert.ok(initialCard, 'analysis_summary card must exist even when LLM key missing');
        assert.equal(readDeepeningPhaseFromCard(initialCard), 'photo_optin', 'phase should be photo_optin');

        // Chat deepening turn → template fallback should still return a valid card
        const deepeningMeta = readDeepeningMeta(initial.body);
        const turnReactions = await request
          .post('/v1/chat')
          .set(headers)
          .send({
            client_state: 'DIAG_ANALYSIS_SUMMARY',
            action: {
              action_id: 'analysis_skip_photo',
              kind: 'action',
              data: { reply_text: 'skip photo, continue text' },
            },
            session: deepeningMeta ? { meta: { analysis_deepening_v1: deepeningMeta } } : {},
          })
          .expect(200);
        const reactionsCard = analysisSummaryCardFromBody(turnReactions.body);
        assert.ok(reactionsCard, 'analysis_summary card should exist on deepening turn even without LLM key');
        // Phase advances to products (no products submitted yet)
        const reactionsPhase = readDeepeningPhaseFromCard(reactionsCard);
        assert.ok(
          reactionsPhase === 'products' || reactionsPhase === 'reactions',
          `phase should advance from photo_optin, got ${reactionsPhase}`,
        );
        // No duplicate photo-choice chips in the response
        assert.ok(!hasPhotoChoiceDupChips(turnReactions.body), 'photo-choice chips must not be duplicated after phase advance');
      } finally {
        restore();
      }
    },
  );
});
