#!/usr/bin/env node
'use strict';

const { createPublicWebEvidenceNavigator } = require('../src/services/publicWebEvidenceNavigator');

const armed = String(process.env.PUBLIC_WEB_EVIDENCE_BROWSER_ARMED || '').trim().toLowerCase() === 'true';
if (!armed) {
  console.log(JSON.stringify({ public_web_evidence_browser: { ok: true, code: 'worker_disarmed', facts_written: 0, projections_written: 0 } }));
  process.exit(0);
}
let targets;
try { targets = JSON.parse(process.env.PUBLIC_WEB_EVIDENCE_TARGETS || '[]'); } catch { console.error(JSON.stringify({ public_web_evidence_browser: { ok: false, code: 'invalid_targets' } })); process.exit(1); }
createPublicWebEvidenceNavigator({ playwright: require('playwright') }).discover({ targets })
  .then((manifest) => console.log(JSON.stringify({ public_web_evidence_browser: { ok: true, manifest } })))
  .catch(() => { console.error(JSON.stringify({ public_web_evidence_browser: { ok: false, code: 'worker_unhandled_error' } })); process.exitCode = 1; });
