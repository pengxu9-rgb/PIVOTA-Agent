const { runSkill } = require('./contracts');

function normalizeQcStatus(rawStatus) {
  const token = String(rawStatus || '').trim().toLowerCase();
  if (!token) return 'unknown';
  if (token === 'passed' || token === 'pass' || token === 'ok' || token === 'success' || token === 'succeeded') {
    return 'passed';
  }
  if (token === 'degraded' || token === 'warn' || token === 'warning' || token === 'low') return 'degraded';
  if (token === 'fail' || token === 'failed' || token === 'reject' || token === 'rejected' || token === 'bad') return 'failed';
  return 'unknown';
}

function classifyQualityGrade(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 'unknown';
  if (list.some((row) => row && row.qc_status === 'failed')) return 'fail';
  if (list.some((row) => row && row.qc_status === 'degraded')) return 'degraded';
  if (list.some((row) => row && row.qc_status === 'passed')) return 'pass';
  return 'unknown';
}

function qualityScoreFromGrade(grade) {
  const token = String(grade || '').trim().toLowerCase();
  if (token === 'pass') return 1;
  if (token === 'degraded') return 0.62;
  if (token === 'fail') return 0.2;
  return 0.4;
}

function normalizePhotoRows({ photos, photoId, slotId, qcStatus } = {}) {
  if (Array.isArray(photos) && photos.length) {
    return photos
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const id = String(row.photo_id || '').trim();
        const slot = String(row.slot_id || '').trim();
        const qc = normalizeQcStatus(row.qc_status);
        if (!id && !slot) return null;
        return {
          photo_id: id || null,
          slot_id: slot || null,
          qc_status: qc,
        };
      })
      .filter(Boolean);
  }

  if (!photoId && !slotId && !qcStatus) return [];
  return [
    {
      photo_id: photoId ? String(photoId).trim() : null,
      slot_id: slotId ? String(slotId).trim() : null,
      qc_status: normalizeQcStatus(qcStatus),
    },
  ];
}

async function runPhotoCaptureQualitySkill({
  requestContext,
  logger,
  photos,
  photoId,
  slotId,
  qcStatus,
  userRequestedPhoto = false,
} = {}) {
  return runSkill({
    skillName: 'photo_capture_quality',
    stage: 'photo_capture_quality',
    provider: 'qc_status',
    requestContext,
    logger,
    run: async () => {
      const rows = normalizePhotoRows({ photos, photoId, slotId, qcStatus });
      const grade = classifyQualityGrade(rows);
      const qualityFlags = [];
      if (!rows.length) qualityFlags.push('no_photo_submitted');
      if (rows.some((row) => row && row.qc_status === 'unknown')) qualityFlags.push('qc_unknown');
      if (rows.some((row) => row && row.qc_status === 'failed')) qualityFlags.push('photo_failed_qc');
      if (rows.some((row) => row && row.qc_status === 'degraded')) qualityFlags.push('photo_degraded_qc');

      const passed = rows.filter((row) => row && row.qc_status === 'passed');
      const degraded = rows.filter((row) => row && row.qc_status === 'degraded');
      const failed = rows.filter((row) => row && row.qc_status === 'failed');

      return {
        photo_refs: rows,
        quality_grade: grade,
        quality_score: qualityScoreFromGrade(grade),
        quality_flags: qualityFlags,
        accepted_photos: [...passed, ...degraded],
        failed_photos: failed,
        user_requested_photo: Boolean(userRequestedPhoto),
        degrade_to: grade === 'fail' ? 'text_only' : 'none',
      };
    },
  });
}

module.exports = {
  normalizeQcStatus,
  runPhotoCaptureQualitySkill,
};

