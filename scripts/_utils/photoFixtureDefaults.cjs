'use strict';

const path = require('node:path');

const DEFAULT_FIXTURE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PASS_PHOTO_PATH = path.join(DEFAULT_FIXTURE_ROOT, 'tests', 'fixtures', 'photo', 'real_face_probe.jpg');
const DEFAULT_DEGRADED_PHOTO_PATH = path.join(DEFAULT_FIXTURE_ROOT, 'tests', 'fixtures', 'photo', 'degraded_face_boundary.png');
const DEFAULT_PASS_PHOTO_URL =
  'https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg';
const DEFAULT_PASS_PHOTO_LABEL = 'real_face_repo_probe';
const DEFAULT_FAIL_FIXTURE_MODE = 'forced_qc_failed_or_missing_photo';
const DEFAULT_FIXTURE_POLICY = 'trusted_repo_face_fixture_plus_explicit_fail_boundary';

module.exports = {
  DEFAULT_FIXTURE_ROOT,
  DEFAULT_PASS_PHOTO_PATH,
  DEFAULT_DEGRADED_PHOTO_PATH,
  DEFAULT_PASS_PHOTO_URL,
  DEFAULT_PASS_PHOTO_LABEL,
  DEFAULT_FAIL_FIXTURE_MODE,
  DEFAULT_FIXTURE_POLICY,
};
