const { z } = require('zod');
const { buildRequestContext } = require('../requestContext');
const {
  getActiveRoutineForIdentity,
  getLatestRoutineVersion,
  saveRoutineVersion,
  updateRoutineSteps,
} = require('../routineStore');
const { simulateConflicts } = require('../routineRules');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RoutineStepSchema = z.object({
  step: z.string().min(1).max(120),
  product: z.string().max(300).optional(),
  product_id: z.string().max(120).optional(),
  sku_id: z.string().max(120).optional(),
  brand: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  image_url: z.string().max(2000).optional(),
  link: z.string().max(2000).optional(),
  area: z.string().max(60).optional(),
  time: z.enum(['am', 'pm', 'both', 'anytime']).optional(),
  manual_entry: z.boolean().optional(),
  usage_note: z.string().max(500).optional(),
});

const RoutineSaveSchema = z.object({
  routine_id: z.string().max(120).optional(),
  label: z.string().max(200).optional(),
  intensity: z.enum(['gentle', 'balanced', 'active']).optional(),
  am_steps: z.array(RoutineStepSchema).max(30),
  pm_steps: z.array(RoutineStepSchema).max(30),
  areas: z.array(z.string().max(40)).max(20).optional(),
}).strict();

const RoutinePatchStepsSchema = z.object({
  am_steps: z.array(RoutineStepSchema).max(30).optional(),
  pm_steps: z.array(RoutineStepSchema).max(30).optional(),
}).strict();

const RoutineAuditSchema = z.object({
  am_steps: z.array(RoutineStepSchema).max(30),
  pm_steps: z.array(RoutineStepSchema).max(30),
}).strict();

// ---------------------------------------------------------------------------
// Audit engine
// ---------------------------------------------------------------------------

const EXPECTED_CATEGORIES = ['cleanser', 'treatment', 'moisturizer', 'sunscreen', 'spf'];

function buildAudit(amSteps, pmSteps, language) {
  const gaps = [];
  const conflicts = [];
  const amCategories = (amSteps || []).map((s) => String(s.category || s.step || '').toLowerCase());
  const pmCategories = (pmSteps || []).map((s) => String(s.category || s.step || '').toLowerCase());

  if (!amCategories.some((c) => /spf|sunscreen|sun\s*block/i.test(c))) {
    gaps.push({ type: 'missing_spf', message: language === 'CN' ? 'AM 缺少防晒' : 'AM routine is missing SPF' });
  }
  if (!amCategories.some((c) => /cleanser|wash|foam/i.test(c)) && !pmCategories.some((c) => /cleanser|wash|foam/i.test(c))) {
    gaps.push({ type: 'missing_cleanser', message: language === 'CN' ? '缺少洁面产品' : 'No cleanser in routine' });
  }
  if (!amCategories.some((c) => /moistur|cream|lotion/i.test(c)) && !pmCategories.some((c) => /moistur|cream|lotion/i.test(c))) {
    gaps.push({ type: 'missing_moisturizer', message: language === 'CN' ? '缺少保湿产品' : 'No moisturizer in routine' });
  }

  const sim = simulateConflicts({
    routine: { am: amSteps || [], pm: pmSteps || [] },
    testProduct: null,
    language: language || 'EN',
  });
  if (sim && Array.isArray(sim.conflicts)) {
    for (const c of sim.conflicts) {
      conflicts.push({
        type: 'active_conflict',
        pair: c.pair || c.actives || [],
        severity: c.severity || 'warn',
        message: c.message || c.explanation || '',
      });
    }
  }

  const totalSteps = (amSteps || []).length + (pmSteps || []).length;
  let intensity = 'gentle';
  if (totalSteps >= 6) intensity = 'balanced';
  if (totalSteps >= 10 || conflicts.some((c) => c.severity === 'block')) intensity = 'active';

  const structuredCount = [...(amSteps || []), ...(pmSteps || [])].filter((s) => s.product_id).length;
  const fit = structuredCount / Math.max(1, totalSteps);

  const nextActions = [];
  if (gaps.length > 0) {
    nextActions.push({
      action_id: 'fill_gap',
      label: language === 'CN' ? `补齐缺口：${gaps[0].message}` : `Fill gap: ${gaps[0].message}`,
      type: 'add_product',
    });
  }
  if (conflicts.some((c) => c.severity === 'block')) {
    nextActions.push({
      action_id: 'resolve_conflict',
      label: language === 'CN' ? '解决活性成分冲突' : 'Resolve active ingredient conflict',
      type: 'adjust_frequency',
    });
  }

  return {
    gaps,
    conflicts,
    intensity,
    fit_score: Math.round(fit * 100),
    total_steps: totalSteps,
    structured_count: structuredCount,
    next_actions: nextActions.slice(0, 2),
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function mountRoutineRoutes(app, { logger, requireAuroraUid, resolveIdentity, classifyStorageError }) {

  app.get('/v1/routine/current', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      const routine = await getActiveRoutineForIdentity(identity);
      if (!routine) {
        return res.json({ routine: null, state: 'S0' });
      }
      const updatedAt = routine.created_at;
      const now = Date.now();
      const daysSince = updatedAt ? (now - new Date(updatedAt).getTime()) / 86400000 : 999;
      const state = daysSince > 30 ? 'S2' : 'S1';
      return res.json({
        routine: {
          routine_id: routine.routine_id,
          version_id: routine.version_id,
          label: routine.label,
          intensity: routine.intensity,
          status: routine.status,
          am_steps: routine.am_steps || [],
          pm_steps: routine.pm_steps || [],
          areas: routine.areas || ['face'],
          audit: routine.audit || null,
          created_at: routine.created_at,
        },
        version_history: routine.version_history || [],
        state,
      });
    } catch (err) {
      const fail = classifyStorageError(err);
      logger?.warn({ err: err?.message }, 'routine/current failed');
      return res.status(fail.dbError ? 503 : 500).json({ error: 'ROUTINE_LOAD_FAILED' });
    }
  });

  app.post('/v1/routine/save', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutineSaveSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      }
      const identity = await resolveIdentity(req, ctx);
      const { routine_id, label, intensity, am_steps, pm_steps, areas } = parsed.data;
      const lang = String(req.headers['x-aurora-lang'] || req.query.lang || 'EN').toUpperCase();
      const audit = buildAudit(am_steps, pm_steps, lang);
      const saved = await saveRoutineVersion({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        routineId: routine_id || undefined,
        label,
        intensity: intensity || audit.intensity,
        amSteps: am_steps,
        pmSteps: pm_steps,
        areas,
        audit,
      });
      return res.json({ ...saved, audit });
    } catch (err) {
      const fail = classifyStorageError(err);
      logger?.warn({ err: err?.message }, 'routine/save failed');
      return res.status(fail.dbError ? 503 : 500).json({ error: 'ROUTINE_SAVE_FAILED' });
    }
  });

  app.post('/v1/routine/audit', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutineAuditSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      }
      const lang = String(req.headers['x-aurora-lang'] || req.query.lang || 'EN').toUpperCase();
      const audit = buildAudit(parsed.data.am_steps, parsed.data.pm_steps, lang);
      return res.json({ audit });
    } catch (err) {
      logger?.warn({ err: err?.message }, 'routine/audit failed');
      return res.status(500).json({ error: 'AUDIT_FAILED' });
    }
  });

  app.patch('/v1/routine/:routineId/steps', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutinePatchStepsSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      }
      const identity = await resolveIdentity(req, ctx);
      const current = await getLatestRoutineVersion(req.params.routineId);
      if (!current) {
        return res.status(404).json({ error: 'ROUTINE_NOT_FOUND' });
      }
      const nextAmSteps = parsed.data.am_steps !== undefined ? parsed.data.am_steps : current.am_steps;
      const nextPmSteps = parsed.data.pm_steps !== undefined ? parsed.data.pm_steps : current.pm_steps;
      const lang = String(req.headers['x-aurora-lang'] || req.query.lang || 'EN').toUpperCase();
      const nextAudit = buildAudit(nextAmSteps, nextPmSteps, lang);
      const saved = await updateRoutineSteps({
        routineId: req.params.routineId,
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        amSteps: nextAmSteps,
        pmSteps: nextPmSteps,
        audit: nextAudit,
      });
      return res.json({ ...saved, audit: nextAudit });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'ROUTINE_NOT_FOUND' });
      const fail = classifyStorageError(err);
      logger?.warn({ err: err?.message }, 'routine/steps patch failed');
      return res.status(fail.dbError ? 503 : 500).json({ error: 'ROUTINE_PATCH_FAILED' });
    }
  });
}

module.exports = {
  mountRoutineRoutes,
  buildAudit,
  RoutineSaveSchema,
  RoutineAuditSchema,
  RoutineStepSchema,
};
