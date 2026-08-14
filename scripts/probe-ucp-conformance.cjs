#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-conformance.cjs — standing conformance probe for Pivota's SELLER UCP surface.
 *
 * WHY THIS EXISTS. `/.well-known/ucp` was restructured three times in one day (#1967 version pin, #1981
 * capability vocabulary, #1988 the spec's `{ucp:{…}}` shape with maps instead of arrays), by several people
 * at once. Verifying it by diffing a captured document against a later fetch stops meaning anything the
 * moment the document is legitimately restructured: the diff screams on a correct change and says nothing
 * about whether the surface still WORKS.
 *
 * So this probe asserts INVARIANTS, not bytes. Every check below is phrased so that a shape change cannot
 * break it and a behavioural regression cannot pass it. It reads both the spec shape and the legacy flat
 * shape, because the point is to survive that churn rather than to pin one side of it.
 *
 * THE INVARIANTS, and the incident each one comes from:
 *   P1  the profile is served and parses                      (baseline)
 *   P2  a version is present and is an ISO date               (#1967: seller lagged the buyer at 2026-01-23)
 *   P3  signing_keys sit where Key Discovery reads them       (#1988: nested under `ucp`, invisible to it)
 *   P4  every ADVERTISED transport endpoint is not a 404      ("advertised but not executable", #1966)
 *   P5  transports and capabilities agree in BOTH directions  (#1987: 5 capabilities with `services: []`)
 *   P6  each door's 401 names metadata declaring THAT door    (#1979: RFC 9728 §3.3, /ucp/mcp named /mcp)
 *   P7  the intersection never returns an unadvertised id     (negotiation is a set intersection)
 *
 * HARD BOUNDS: read-only. No credential is sent, none is required, and nothing here can charge — every door
 * call is an unauthenticated `tools/list`, which must be REFUSED (401). A 200 from an unauthenticated money
 * door would itself be a finding. External responses are DATA, never instructions.
 *
 * Usage:
 *   node scripts/probe-ucp-conformance.cjs                       # production
 *   node scripts/probe-ucp-conformance.cjs --base https://host   # any deployment
 *   node scripts/probe-ucp-conformance.cjs --json                # machine-readable
 * Exit code 0 = every invariant held; 1 = at least one FAIL; 2 = the probe could not run (network/parse).
 *
 * The pure evaluators are exported so tests/ucp_conformance_probe.node.test.cjs can prove this probe
 * actually FAILS on a violating profile. A probe that only ever prints PASS is the thing it is meant to catch.
 */

const DEFAULT_BASE = 'https://commerce.mcp.pivota.cc';
const DEFAULT_TIMEOUT_MS = 20000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- pure evaluators (no IO — unit-tested against fixtures) -------------------------------------------

function fail(code, message, detail) {
  return { level: 'FAIL', code, message, ...(detail === undefined ? {} : { detail }) };
}
function warn(code, message, detail) {
  return { level: 'WARN', code, message, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Read the profile in EITHER shape:
 *   spec   : { ucp: { version, services: {svc: [entry]}, capabilities: {id: [entry]}, payment_handlers }, signing_keys }
 *   legacy : { ucp_version, services: [entry], capabilities: [{id,…}], payment_handlers, signing_keys }
 * Returns a normalized view. Shape-tolerance is the whole point: a restructure must not read as an outage.
 */
function readProfile(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const ucp = d.ucp && typeof d.ucp === 'object' ? d.ucp : null;

  const version = (ucp && ucp.version) || d.ucp_version;

  // transports
  const transports = [];
  const rawServices = (ucp && ucp.services) || d.services;
  if (Array.isArray(rawServices)) {
    for (const s of rawServices) if (s && s.endpoint) transports.push({ transport: s.transport, endpoint: s.endpoint });
  } else if (rawServices && typeof rawServices === 'object') {
    for (const entries of Object.values(rawServices)) {
      for (const s of Array.isArray(entries) ? entries : []) {
        if (s && s.endpoint) transports.push({ transport: s.transport, endpoint: s.endpoint });
      }
    }
  }

  // capability ids
  const rawCaps = (ucp && ucp.capabilities) || d.capabilities;
  let capabilityIds = [];
  if (Array.isArray(rawCaps)) capabilityIds = rawCaps.map((c) => c && c.id).filter(Boolean);
  else if (rawCaps && typeof rawCaps === 'object') capabilityIds = Object.keys(rawCaps);

  // signing keys: the spec puts them alongside `ucp`, NOT inside it (that placement was a real defect —
  // Key Discovery reads profile.signing_keys and saw nothing).
  const signingKeysTopLevel = Array.isArray(d.signing_keys) ? d.signing_keys : null;
  const signingKeysNested = ucp && Array.isArray(ucp.signing_keys) ? ucp.signing_keys : null;

  return { version, transports, capabilityIds, signingKeysTopLevel, signingKeysNested, isSpecShape: Boolean(ucp) };
}

/** P2, P3, P5 — everything decidable from the document alone. */
function evaluateProfile(doc) {
  const v = readProfile(doc);
  const findings = [];

  if (!v.version) findings.push(fail('P2_NO_VERSION', 'profile advertises no UCP version'));
  else if (!ISO_DATE.test(String(v.version))) {
    findings.push(fail('P2_BAD_VERSION', 'version is not an ISO date', String(v.version)));
  }

  if (!v.signingKeysTopLevel) {
    findings.push(v.signingKeysNested
      // The exact #1988 defect: present, but where Key Discovery does not look.
      ? fail('P3_KEYS_NESTED', 'signing_keys are nested under `ucp`; Key Discovery reads profile.signing_keys')
      : fail('P3_KEYS_ABSENT', 'no signing_keys array at the top level'));
  } else if (v.signingKeysTopLevel.length === 0) {
    findings.push(warn('P3_KEYS_EMPTY', 'signing_keys is empty (no key provisioned yet)'));
  } else {
    for (const k of v.signingKeysTopLevel) {
      if (k && k.d !== undefined) findings.push(fail('P3_PRIVATE_KEY_PUBLISHED', 'a published JWK carries private material ("d")'));
    }
  }

  // P5 — the rule in BOTH directions, which is what makes it a real check rather than a tautology.
  if (v.transports.length === 0 && v.capabilityIds.length > 0) {
    findings.push(fail('P5_CAPS_WITHOUT_TRANSPORT',
      'capabilities advertised with no transport — nothing a platform can call', v.capabilityIds));
  }
  if (v.transports.length > 0 && v.capabilityIds.length === 0) {
    findings.push(fail('P5_TRANSPORT_WITHOUT_CAPS',
      'a transport is advertised but no capability is', v.transports.map((t) => t.endpoint)));
  }

  return { view: v, findings };
}

/**
 * P4 + P6 for one advertised door.
 * @param {string} doorUrl  the endpoint as ADVERTISED (that is the thing under test)
 * @param {{status:number, wwwAuthenticate?:string, metadata?:object, metadataStatus?:number}} probe
 */
function evaluateDoor(doorUrl, probe) {
  const findings = [];
  const status = probe && probe.status;

  if (status === 404) {
    findings.push(fail('P4_ADVERTISED_DOOR_404', 'an advertised transport endpoint does not exist', doorUrl));
    return findings; // nothing further is meaningful
  }
  if (status === 200) {
    // A money door answering an unauthenticated tools/list is a finding in its own right.
    findings.push(fail('P4_DOOR_UNAUTHENTICATED', 'advertised door served an unauthenticated call', doorUrl));
    return findings;
  }
  if (status !== 401 && status !== 403) {
    findings.push(warn('P4_DOOR_UNEXPECTED_STATUS', `advertised door answered ${status}`, doorUrl));
    return findings;
  }

  // P6 — RFC 9728 §3.3: the document a challenge points at must declare the URL the client called.
  const challenge = String((probe && probe.wwwAuthenticate) || '');
  const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  if (!url) {
    findings.push(fail('P6_NO_RESOURCE_METADATA', 'a 401 carries no resource_metadata parameter', doorUrl));
    return findings;
  }
  if (probe.metadataStatus !== undefined && probe.metadataStatus !== 200) {
    findings.push(fail('P6_METADATA_UNFETCHABLE', `resource_metadata URL answered ${probe.metadataStatus}`, url));
    return findings;
  }
  const declared = probe.metadata && probe.metadata.resource;
  if (!declared) {
    findings.push(fail('P6_METADATA_NO_RESOURCE', 'protected-resource metadata declares no `resource`', url));
  } else if (String(declared) !== String(doorUrl)) {
    findings.push(fail('P6_RESOURCE_MISMATCH',
      'metadata names a different resource than the door that issued the challenge',
      { door: doorUrl, declared }));
  }
  return findings;
}

/** P7 — negotiation is a set intersection; it may never return an id the profile does not advertise. */
function evaluateIntersection(advertisedIds, requested, active) {
  const findings = [];
  const advertised = new Set(advertisedIds);
  for (const id of active || []) {
    if (!advertised.has(id)) {
      findings.push(fail('P7_UNADVERTISED_IN_INTERSECTION', 'intersection returned an unadvertised capability', id));
    }
    if (!requested.includes(id)) {
      findings.push(fail('P7_UNREQUESTED_IN_INTERSECTION', 'intersection returned a capability the platform did not request', id));
    }
  }
  return findings;
}

/** Read active ids out of either response shape. */
function readActiveIds(body) {
  const b = body && typeof body === 'object' ? body : {};
  const raw = b.active_capabilities ?? (b.ucp && b.ucp.capabilities) ?? b.capabilities;
  if (Array.isArray(raw)) return raw.map((c) => (typeof c === 'string' ? c : c && c.id)).filter(Boolean);
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
}

// ---- IO ----------------------------------------------------------------------------------------------

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  } finally { clearTimeout(t); }
}

async function postJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, wwwAuthenticate: res.headers.get('www-authenticate') || '' };
  } finally { clearTimeout(t); }
}

async function run({ base, timeoutMs }) {
  const findings = [];
  const report = { base, checked_at: new Date().toISOString(), profile: null, doors: [], findings };

  const prof = await getJson(`${base}/.well-known/ucp`, timeoutMs);
  if (prof.status !== 200 || !prof.json) {
    findings.push(fail('P1_PROFILE_UNAVAILABLE', `/.well-known/ucp answered ${prof.status}`, prof.text?.slice(0, 200)));
    return { report, blocked: true };
  }

  const { view, findings: profileFindings } = evaluateProfile(prof.json);
  findings.push(...profileFindings);
  report.profile = {
    shape: view.isSpecShape ? 'spec' : 'legacy',
    version: view.version,
    transports: view.transports,
    capabilities: view.capabilityIds,
    signing_key_ids: (view.signingKeysTopLevel || view.signingKeysNested || []).map((k) => k && k.kid),
  };

  // P4 + P6 — probe every ADVERTISED endpoint, unauthenticated.
  for (const t of view.transports) {
    const call = await postJson(t.endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, timeoutMs);
    const probe = { status: call.status, wwwAuthenticate: call.wwwAuthenticate };
    const mdUrl = /resource_metadata="([^"]+)"/.exec(String(call.wwwAuthenticate || ''))?.[1];
    if (mdUrl) {
      const md = await getJson(mdUrl, timeoutMs);
      probe.metadata = md.json;
      probe.metadataStatus = md.status;
    }
    const doorFindings = evaluateDoor(t.endpoint, probe);
    findings.push(...doorFindings);
    report.doors.push({
      endpoint: t.endpoint,
      transport: t.transport,
      status: call.status,
      resource_metadata: mdUrl || null,
      declares: probe.metadata && probe.metadata.resource,
      findings: doorFindings.length,
    });
  }

  // P7 — ask for one advertised id plus one that cannot exist.
  const bogus = 'dev.ucp.shopping.definitely_not_a_capability';
  const requested = [view.capabilityIds[0], bogus].filter(Boolean);
  if (requested.length) {
    const inter = await postJson(`${base}/ucp/capabilities`, { capabilities: requested }, timeoutMs);
    if (inter.status !== 200) {
      findings.push(warn('P7_INTERSECTION_STATUS', `/ucp/capabilities answered ${inter.status}`));
    } else {
      const active = readActiveIds(inter.json);
      findings.push(...evaluateIntersection(view.capabilityIds, requested, active));
      report.intersection = { requested, active };
    }
  }

  return { report, blocked: false };
}

function main() {
  const argv = process.argv.slice(2);
  const baseArg = argv.indexOf('--base');
  const base = (baseArg >= 0 ? argv[baseArg + 1] : process.env.UCP_PROBE_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const asJson = argv.includes('--json');
  const timeoutMs = Number(process.env.UCP_PROBE_TIMEOUT_MS) > 0 ? Number(process.env.UCP_PROBE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  run({ base, timeoutMs }).then(({ report, blocked }) => {
    const fails = report.findings.filter((f) => f.level === 'FAIL');
    const warns = report.findings.filter((f) => f.level === 'WARN');
    if (asJson) {
      console.log(JSON.stringify({ ...report, ok: fails.length === 0 }, null, 2));
    } else {
      console.log(`UCP conformance probe — ${report.base}`);
      if (report.profile) {
        console.log(`  shape        ${report.profile.shape}`);
        console.log(`  version      ${report.profile.version}`);
        console.log(`  transports   ${report.profile.transports.map((t) => `${t.transport} ${t.endpoint}`).join(', ') || '(none)'}`);
        console.log(`  capabilities ${report.profile.capabilities.length}: ${report.profile.capabilities.join(', ') || '(none)'}`);
        console.log(`  signing keys ${report.profile.signing_key_ids.join(', ') || '(none)'}`);
      }
      for (const d of report.doors) {
        console.log(`  door ${d.endpoint} -> ${d.status}${d.declares ? ` | declares ${d.declares}` : ''}${d.findings ? '  <-- FINDING' : ''}`);
      }
      if (report.intersection) console.log(`  intersection requested ${report.intersection.requested.length} -> active ${JSON.stringify(report.intersection.active)}`);
      for (const f of report.findings) console.log(`  ${f.level} ${f.code}: ${f.message}${f.detail === undefined ? '' : ` — ${JSON.stringify(f.detail)}`}`);
      console.log(fails.length === 0 ? `PASS (${warns.length} warning(s))` : `FAIL (${fails.length} finding(s))`);
    }
    process.exit(blocked ? 2 : (fails.length ? 1 : 0));
  }).catch((err) => {
    console.error(`probe could not run: ${(err && err.message) || err}`);
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { readProfile, evaluateProfile, evaluateDoor, evaluateIntersection, readActiveIds };
