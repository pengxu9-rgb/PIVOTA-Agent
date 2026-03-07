const { buildPhotoModulesCard } = require('../photoModulesV1');
const { runSkill } = require('./contracts');

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const token = String(value || '').trim().toLowerCase();
  if (!token) return fallback;
  if (token === '1' || token === 'true' || token === 'yes' || token === 'on') return true;
  if (token === '0' || token === 'false' || token === 'no' || token === 'off') return false;
  return fallback;
}

async function runPhotoRegionSelectionSkill({
  requestContext,
  logger,
  requestId,
  analysis,
  usedPhotos,
  photoQuality,
  photoNotice,
  diagnosisInternal,
  profileSummary,
  language,
  skinMask,
  options = {},
} = {}) {
  return runSkill({
    skillName: 'photo_region_selection',
    stage: 'photo_region_selection',
    provider: 'photo_modules_v1',
    requestContext,
    logger,
    run: async () => {
      const enabled = parseBool(options.enabled, true);
      const overlayMode = String(options.overlayMode || 'client').trim().toLowerCase();
      if (!enabled || overlayMode !== 'client') {
        return {
          photo_modules_card: null,
          suppressed_reason: !enabled ? 'flag_disabled' : 'overlay_mode_not_client',
          metrics: null,
        };
      }
      if (!analysis || typeof analysis !== 'object') {
        return {
          photo_modules_card: null,
          suppressed_reason: 'analysis_missing',
          metrics: null,
        };
      }

      const built = buildPhotoModulesCard({
        requestId,
        analysis,
        usedPhotos: Boolean(usedPhotos),
        photoQuality,
        photoNotice:
          typeof photoNotice === 'string'
            ? photoNotice
            : photoNotice && typeof photoNotice.message === 'string'
              ? photoNotice.message
              : null,
        diagnosisInternal,
        profileSummary,
        language,
        ingredientRecEnabled: parseBool(options.ingredientRecEnabled, true),
        productRecEnabled: parseBool(options.productRecEnabled, true),
        productRecMinCitations: Number.isFinite(Number(options.productRecMinCitations))
          ? Number(options.productRecMinCitations)
          : 1,
        productRecMinEvidenceGrade: String(options.productRecMinEvidenceGrade || 'B').trim().toUpperCase() || 'B',
        productRecRepairOnlyWhenDegraded: parseBool(options.productRecRepairOnlyWhenDegraded, true),
        internalTestMode: parseBool(options.internalTestMode, false),
        ingredientKbArtifactPath: options.ingredientKbArtifactPath || undefined,
        productCatalogPath: options.productCatalogPath || undefined,
        skinMask,
      });

      if (!built || !built.card) {
        return {
          photo_modules_card: null,
          suppressed_reason: 'photo_modules_empty',
          metrics: built && built.metrics ? built.metrics : null,
        };
      }

      return {
        photo_modules_card: built.card,
        suppressed_reason: null,
        metrics: built.metrics && typeof built.metrics === 'object' ? built.metrics : null,
      };
    },
  });
}

module.exports = {
  runPhotoRegionSelectionSkill,
};

