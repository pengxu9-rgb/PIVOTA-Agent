#!/usr/bin/env bash

# Trusted photo-analysis probe defaults.
# Mainline pass acceptance should use a realistic face photo fixture.
# Low-quality / fail coverage should use explicit forced-qc or missing-photo
# branches instead of tiny placeholder images.

_AURORA_PHOTO_FIXTURE_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

AURORA_PHOTO_PASS_FIXTURE_PATH_DEFAULT="${AURORA_PHOTO_PASS_FIXTURE_PATH_DEFAULT:-${_AURORA_PHOTO_FIXTURE_ROOT_DEFAULT}/tests/fixtures/photo/real_face_probe.jpg}"
AURORA_PHOTO_DEGRADED_FIXTURE_PATH_DEFAULT="${AURORA_PHOTO_DEGRADED_FIXTURE_PATH_DEFAULT:-${_AURORA_PHOTO_FIXTURE_ROOT_DEFAULT}/tests/fixtures/photo/degraded_face_boundary.png}"
AURORA_PHOTO_PASS_FIXTURE_URL_FALLBACK_DEFAULT="${AURORA_PHOTO_PASS_FIXTURE_URL_FALLBACK_DEFAULT:-https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg}"
AURORA_PHOTO_PASS_FIXTURE_LABEL_DEFAULT="${AURORA_PHOTO_PASS_FIXTURE_LABEL_DEFAULT:-real_face_repo_probe}"
AURORA_PHOTO_FAIL_FIXTURE_MODE_DEFAULT="${AURORA_PHOTO_FAIL_FIXTURE_MODE_DEFAULT:-forced_qc_failed_or_missing_photo}"
AURORA_PHOTO_FIXTURE_POLICY_DEFAULT="${AURORA_PHOTO_FIXTURE_POLICY_DEFAULT:-trusted_repo_face_fixture_plus_explicit_fail_boundary}"

aurora_photo_default_pass_path() {
  printf '%s' "$AURORA_PHOTO_PASS_FIXTURE_PATH_DEFAULT"
}

aurora_photo_default_degraded_path() {
  printf '%s' "$AURORA_PHOTO_DEGRADED_FIXTURE_PATH_DEFAULT"
}

aurora_photo_default_pass_url() {
  printf '%s' "$AURORA_PHOTO_PASS_FIXTURE_URL_FALLBACK_DEFAULT"
}

aurora_photo_default_pass_label() {
  printf '%s' "$AURORA_PHOTO_PASS_FIXTURE_LABEL_DEFAULT"
}

aurora_photo_default_fail_mode() {
  printf '%s' "$AURORA_PHOTO_FAIL_FIXTURE_MODE_DEFAULT"
}

aurora_photo_fixture_policy() {
  printf '%s' "$AURORA_PHOTO_FIXTURE_POLICY_DEFAULT"
}
