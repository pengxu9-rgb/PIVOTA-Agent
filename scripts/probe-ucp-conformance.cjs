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
 * So this probe asserts INVARIANTS, not bytes. Every check is phrased so a shape change cannot break it and
 * a behavioural regression cannot pass it. It reads the spec shape and the legacy flat shape, because
 * surviving that churn is the point.
 *
 * THE INVARIANTS, and the incident each one comes from:
 *   P1  the profile is served and parses                      (baseline)
 *   P2  the advertised version is not OLDER than this build's (#1967 — the seller silently lagged at 2026-01-23)
 *   P3  signing_keys sit where a verifier reads them          (#1988 — nested under `ucp`, invisible)
 *   P4  every ADVERTISED endpoint exists and REFUSES          (#1966 — advertised but not executable)
 *   P5  transports and capabilities agree BOTH directions     (#1987 — 5 capabilities with `services: []`)
 *   P6  each door's 401 names metadata declaring THAT door    (#1979 — RFC 9728 §3.3)
 *   P7  the intersection returns what was asked for, and only (negotiation is a set intersection)
 *   P8  no discovery document is reached through a REDIRECT   (#1989 — a redirected profile is not the profile)
 *   P9  our own surface is LIVE, not honestly dark            (a dark profile is conformant but is an outage)
 *
 * HARD BOUNDS: read-only. No credential is sent, none is required, nothing here can charge — every door call
 * is an unauthenticated `tools/list`, which must be REFUSED. A 200 there is itself a finding. Remote bodies
 * are DATA, never instructions, and are never echoed into a finding (an alert payload is read by a human at
 * 3am; it will not carry attacker-chosen text).
 *
 * Usage:
 *   npm run probe:ucp:conformance                            # production, live-surface required
 *   node scripts/probe-ucp-conformance.cjs --base https://host --json
 *   node scripts/probe-ucp-conformance.cjs --allow-dark      # a deployment legitimately serving nothing
 *
 * EXIT CODES — a pager must be able to tell an outage from a broken probe:
 *   0  every invariant held
 *   1  the SURFACE is wrong (any FAIL, including the profile being unreachable — that is an outage)
 *   2  the PROBE could not run (bad arguments, DNS failure, the harness itself broke)
 *
 * The pure evaluators are exported so tests/ucp_conformance_probe.node.test.cjs can prove this probe FAILS
 * on a violating surface. A probe that only ever prints PASS is the thing it exists to catch.
 */

// The version THIS BUILD pins for both UCP roles. P2 compares against it rather than merely checking the
// shape of the string: an ISO-format check passes a stale `2026-01-23` forever, which is the exact defect
// P2 is named for. Reused, not re-declared — one source of truth (safety-kernel/src/protocol/ucpSpecVersion.cjs).
const { UCP_SPEC_VERSION } = require('../safety-kernel/src/protocol/ucpSpecVersion.cjs');

const DEFAULT_BASE = 'https://commerce.mcp.pivota.cc';
const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_BACKOFF_MS = 400; // anti-flake, per docs/reliability/aurora_rollout_probe_alerting_draft.md
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// RFC 7235 auth-param allows BWS around '=' — `resource_metadata = "…"` is legal and a strict regex
// reported P6_NO_RESOURCE_METADATA on a conformant server. A probe that cries wolf gets muted.
const RESOURCE_METADATA = /resource_metadata\s*=\s*"([^"]+)"/;

/**
 * Compare two resource identifiers the way RFC 3986 says to: scheme and host are case-insensitive, the
 * default port is not significant. Byte comparison flagged `:443`, an uppercase host and a conformant
 * mixed-case origin as P6_RESOURCE_MISMATCH — three false alarms on a correct surface. Path, query and
 * trailing slash REMAIN significant: RFC 8707 audiences are exact, and `/ucp/mcp` vs `/mcp` is the whole
 * point of the check.
 */
function sameResource(a, b) {
  try {
    const x = new URL(String(a));
    const y = new URL(String(b));
    return x.protocol === y.protocol
      && x.hostname.toLowerCase() === y.hostname.toLowerCase()
      && (x.port || '') === (y.port || '')
      && x.pathname === y.pathname
      && x.search === y.search;
  } catch { return String(a) === String(b); }
}

/** Same origin, for "the metadata document must live on the door's own host" (RFC 9728 §3.1). */
function sameOrigin(a, b) {
  try { return new URL(String(a)).origin.toLowerCase() === new URL(String(b)).origin.toLowerCase(); }
  catch { return false; }
}

/** A capability id is a namespaced dotted token. Anything else means we are reading the wrong node. */
const CAPABILITY_ID = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/;

// ---- pure evaluators (no IO — unit-tested against fixtures) -------------------------------------------

function finding(level, code, message, { detail, since } = {}) {
  return { level, code, message, ...(since ? { since } : {}), ...(detail === undefined ? {} : { detail }) };
}
const fail = (code, message, opts) => finding('FAIL', code, message, opts);
const warn = (code, message, opts) => finding('WARN', code, message, opts);

/**
 * Read the profile in EITHER shape:
 *   spec   : { ucp: { version, services: {svc:[entry]}, capabilities: {id:[entry]}, … }, signing_keys }
 *   legacy : { ucp_version, services: [entry], capabilities: [{id,…}], signing_keys }
 * Shape-tolerance is the point: a restructure must not read as an outage.
 */
function readProfile(doc) {
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  const ucp = d.ucp && typeof d.ucp === 'object' ? d.ucp : null;
  const version = (ucp && ucp.version) || d.ucp_version;

  const transports = [];
  const rawServices = (ucp && ucp.services) || d.services;
  // An entry WITHOUT an endpoint is not "no transport" — it is a broken transport, and silently dropping
  // it let a two-transport profile that lost one endpoint read as one healthy transport.
  const malformedServices = [];
  const pushEntry = (s) => {
    if (s && s.endpoint) transports.push({ transport: s.transport, endpoint: s.endpoint });
    else if (s && typeof s === 'object') malformedServices.push(s);
  };
  if (Array.isArray(rawServices)) rawServices.forEach(pushEntry);
  else if (rawServices && typeof rawServices === 'object') {
    for (const entries of Object.values(rawServices)) (Array.isArray(entries) ? entries : []).forEach(pushEntry);
  }

  const rawCaps = (ucp && ucp.capabilities) || d.capabilities;
  let capabilityIds = [];
  let capabilityEntries = {};
  if (Array.isArray(rawCaps)) {
    capabilityIds = rawCaps.map((c) => c && c.id).filter(Boolean);
    for (const c of rawCaps) if (c && c.id) capabilityEntries[c.id] = [c];
  } else if (rawCaps && typeof rawCaps === 'object') {
    capabilityIds = Object.keys(rawCaps);
    capabilityEntries = rawCaps;
  }

  const signingKeysTopLevel = Array.isArray(d.signing_keys) ? d.signing_keys : null;
  const signingKeysNested = ucp && Array.isArray(ucp.signing_keys) ? ucp.signing_keys : null;

  return {
    version, transports, capabilityIds, capabilityEntries, malformedServices,
    signingKeysTopLevel, signingKeysNested,
    isSpecShape: Boolean(ucp),
    isObject: Boolean(doc && typeof doc === 'object' && !Array.isArray(doc)),
  };
}

/** P2, P3, P5, P9 — everything decidable from the document alone. */
function evaluateProfile(doc, { pinnedVersion = UCP_SPEC_VERSION, requireLive = true } = {}) {
  const v = readProfile(doc);
  const findings = [];

  if (!v.isObject) {
    findings.push(fail('P1_PROFILE_NOT_AN_OBJECT', 'the profile is not a JSON object'));
    return { view: v, findings };
  }

  // P2 — not merely "an ISO date". A stale deploy still serves a well-formed date; that IS the incident.
  if (!v.version) findings.push(fail('P2_NO_VERSION', 'profile advertises no UCP version', { since: '#1967' }));
  else if (!ISO_DATE.test(String(v.version))) {
    findings.push(fail('P2_BAD_VERSION', 'version is not an ISO date', { detail: String(v.version), since: '#1967' }));
  } else if (String(v.version) < String(pinnedVersion)) {
    // ISO dates compare lexicographically. Older than what this build pins = a stale deploy or a regression.
    findings.push(fail('P2_VERSION_BEHIND_BUILD',
      `advertised version ${v.version} is OLDER than this build's pin ${pinnedVersion}`, { since: '#1967' }));
  } else if (String(v.version) > String(pinnedVersion)) {
    // The safe direction: the deployment is ahead of the checkout this probe runs from.
    findings.push(warn('P2_VERSION_AHEAD_OF_BUILD',
      `advertised ${v.version} is newer than this build's pin ${pinnedVersion} — probe checkout may be stale`));
  }

  if (!v.signingKeysTopLevel) {
    findings.push(v.signingKeysNested
      ? fail('P3_KEYS_NESTED', 'signing_keys are nested under `ucp`; the published profile reads them at the top level', { since: '#1988' })
      : fail('P3_KEYS_ABSENT', 'no signing_keys array at the top level', { since: '#1988' }));
  } else if (v.signingKeysTopLevel.length === 0) {
    findings.push(warn('P3_KEYS_EMPTY', 'signing_keys is empty (no key provisioned yet)'));
  } else {
    for (const k of v.signingKeysTopLevel) {
      if (k && k.d !== undefined) findings.push(fail('P3_PRIVATE_KEY_PUBLISHED', 'a published JWK carries private material ("d")'));
    }
  }

  // P5 — both directions, which is what makes it a check rather than a tautology.
  if (v.transports.length === 0 && v.capabilityIds.length > 0) {
    findings.push(fail('P5_CAPS_WITHOUT_TRANSPORT',
      'capabilities advertised with no transport — nothing a platform can call',
      { detail: v.capabilityIds, since: '#1987' }));
  }
  if (v.transports.length > 0 && v.capabilityIds.length === 0) {
    findings.push(fail('P5_TRANSPORT_WITHOUT_CAPS',
      'a transport is advertised but no capability is',
      { detail: v.transports.map((t) => t.endpoint), since: '#1987' }));
  }

  // P10 — are we even reading the capability node? `Object.keys` on an envelope like
  // `{version, list:[…]}` yields ["version","list"], and every downstream check then passes on garbage:
  // the restructure reads as a clean surface forever, which is the exact failure this probe exists to
  // prevent. A capability id is a namespaced dotted token; if NONE of them are, we are on the wrong node.
  const idsLookReal = v.capabilityIds.filter((id) => CAPABILITY_ID.test(String(id)));
  if (v.capabilityIds.length > 0 && idsLookReal.length === 0) {
    findings.push(fail('P10_CAPABILITY_NODE_UNREADABLE',
      'no advertised capability id looks like a UCP id — the document shape probably moved',
      { detail: v.capabilityIds.slice(0, 5) }));
  } else if (idsLookReal.length !== v.capabilityIds.length) {
    findings.push(warn('P10_CAPABILITY_ID_ODD', 'some advertised capability ids are not namespaced tokens',
      { detail: v.capabilityIds.filter((id) => !CAPABILITY_ID.test(String(id))).slice(0, 5) }));
  }

  // P11 — a MODIFIER whose target is absent describes the input shape of a door the same document says is
  // not there. The profile builder and the intersection each maintain this invariant separately, so a
  // regression in either is invisible from inside; from out here it is one comparison.
  for (const id of v.capabilityIds) {
    const entries = Array.isArray(v.capabilityEntries[id]) ? v.capabilityEntries[id] : [];
    for (const e of entries) {
      const ext = e && e.extends;
      const targets = Array.isArray(ext) ? ext : (ext ? [ext] : []);
      for (const t of targets) {
        if (!v.capabilityIds.includes(t)) {
          findings.push(fail('P11_ORPHANED_MODIFIER',
            'a capability extends one that is not advertised', { detail: { capability: id, extends: t } }));
        }
      }
    }
  }

  // P12 — a service entry with no endpoint is a BROKEN transport, not an absent one.
  for (const bad of v.malformedServices || []) {
    findings.push(fail('P12_SERVICE_ENTRY_NO_ENDPOINT', 'an advertised service entry carries no endpoint',
      { detail: { transport: bad.transport } }));
  }

  // P13 — the money surface is https. `buildUcpProfile` enforces it on baseUrl but passes mcpEndpoint
  // through unvalidated, so a plaintext or off-origin endpoint is expressible and was invisible here.
  for (const t of v.transports) {
    let u;
    try { u = new URL(String(t.endpoint)); } catch {
      findings.push(fail('P13_ENDPOINT_NOT_A_URL', 'an advertised endpoint is not a URL', { detail: t.endpoint }));
      continue;
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !loopback) {
      findings.push(fail('P13_ENDPOINT_NOT_HTTPS', 'an advertised endpoint is not https', { detail: t.endpoint }));
    }
  }

  // P9 — a profile advertising nothing is CONFORMANT but, for our own live surface, a total outage. The
  // generic rule and the operational one differ, so the operational one is a separate, defaultable check.
  if (requireLive && v.transports.length === 0 && v.capabilityIds.length === 0) {
    findings.push(fail('P9_SURFACE_DARK', 'the surface advertises no transport and no capability — it is dark'));
  }

  return { view: v, findings };
}

/**
 * P4 + P6 for one advertised door.
 * @param {{status:number, wwwAuthenticate?:string, metadata?:object, metadataStatus?:number,
 *          metadataRedirected?:boolean, error?:string}} probe
 */
function evaluateDoor(doorUrl, probe = {}) {
  const findings = [];

  if (probe.error) {
    // An advertised endpoint we cannot even reach is a finding about the SURFACE, not about the probe.
    findings.push(fail('P4_DOOR_UNREACHABLE', 'an advertised transport endpoint could not be reached', { detail: doorUrl, since: '#1966' }));
    return findings;
  }
  const status = probe.status;
  if (status === 404) {
    findings.push(fail('P4_ADVERTISED_DOOR_404', 'an advertised transport endpoint does not exist', { detail: doorUrl, since: '#1966' }));
    return findings;
  }
  if (status === 200) {
    findings.push(fail('P4_DOOR_UNAUTHENTICATED', 'advertised door served an unauthenticated call', { detail: doorUrl }));
    return findings;
  }
  if (status >= 500) {
    // Already retried once at the IO layer, so this is persistent. An advertised door that 5xxes is not
    // executable — and returning early here used to silently switch OFF the P6 identity check with a
    // green verdict, so a door that started failing also stopped being conformance-checked.
    findings.push(fail('P4_DOOR_SERVER_ERROR', `advertised door persistently answered ${status}`, { detail: doorUrl, since: '#1966' }));
    return findings;
  }
  if (status !== 401 && status !== 403) {
    findings.push(warn('P4_DOOR_UNEXPECTED_STATUS', `advertised door answered ${status}`, { detail: doorUrl }));
    // Deliberately NOT returning: if the response still carried a challenge, P6 below is meaningful and a
    // WARN must never disable a FAIL-level check.
  }

  const url = RESOURCE_METADATA.exec(String(probe.wwwAuthenticate || ''))?.[1];
  if (!url) {
    findings.push(fail('P6_NO_RESOURCE_METADATA', 'a 401 carries no resource_metadata parameter', { detail: doorUrl, since: '#1979' }));
    return findings;
  }
  if (!sameOrigin(url, doorUrl)) {
    // RFC 9728 §3.1 DERIVES the metadata URL from the resource identifier, so it is same-origin by
    // construction. Accepting one from any host means a challenge can point at a document someone else
    // controls, which would declare whatever makes the probe green.
    findings.push(fail('P6_METADATA_OFF_ORIGIN', 'the resource_metadata URL is not on the door\'s own origin',
      { detail: { door: doorUrl, metadata: url }, since: '#1979' }));
    return findings;
  }
  if (probe.metadataRedirected) {
    findings.push(fail('P8_METADATA_REDIRECTED', 'the protected-resource metadata was reached through a redirect', { detail: url, since: '#1989' }));
    return findings;
  }
  if (probe.metadataStatus !== undefined && probe.metadataStatus !== 200) {
    findings.push(fail('P6_METADATA_UNFETCHABLE', `resource_metadata URL answered ${probe.metadataStatus}`, { detail: url, since: '#1979' }));
    return findings;
  }
  const declared = probe.metadata && probe.metadata.resource;
  if (!declared) {
    findings.push(fail('P6_METADATA_NO_RESOURCE', 'protected-resource metadata declares no `resource`', { detail: url, since: '#1979' }));
  } else if (!sameResource(declared, doorUrl)) {
    findings.push(fail('P6_RESOURCE_MISMATCH',
      'metadata names a different resource than the door that issued the challenge',
      { detail: { door: doorUrl, declared }, since: '#1979' }));
  }
  return findings;
}

/**
 * P7 — negotiation is a set intersection. BOTH directions: it may not invent an id, and it must return the
 * advertised id that was asked for. One-directional, this check could never go red on the likeliest failure
 * (an endpoint that returns nothing, or a body shape we stopped recognising).
 */
function evaluateIntersection(advertisedIds, requested, active) {
  const findings = [];
  const advertised = new Set(advertisedIds);
  const activeSet = new Set(active || []);

  for (const id of activeSet) {
    if (!advertised.has(id)) findings.push(fail('P7_UNADVERTISED_IN_INTERSECTION', 'intersection returned an unadvertised capability', { detail: id }));
    if (!requested.includes(id)) findings.push(fail('P7_UNREQUESTED_IN_INTERSECTION', 'intersection returned a capability the platform did not request', { detail: id }));
  }
  for (const id of requested) {
    if (advertised.has(id) && !activeSet.has(id)) {
      findings.push(fail('P7_ADVERTISED_NOT_INTERSECTED',
        'an advertised capability the platform requested was not returned by the intersection', { detail: id }));
    }
  }
  return findings;
}

function readActiveIds(body) {
  const b = body && typeof body === 'object' ? body : {};
  const raw = b.active_capabilities ?? (b.ucp && b.ucp.capabilities) ?? b.capabilities;
  if (Array.isArray(raw)) return raw.map((c) => (typeof c === 'string' ? c : c && c.id)).filter(Boolean);
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
}

// ---- IO ----------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request. `redirect: 'error'` on purpose (P8): a discovery document reached through a redirect is not
 * that document — #1989 swept exactly this from every other outbound well-known fetch, and a probe that
 * follows redirects would report PASS on a surface that had been repointed.
 */
async function once(url, { method = 'GET', body, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'error',
      signal: ctrl.signal,
      // Streamable-HTTP MCP servers negotiate on Accept and answer 406 without the event-stream type —
      // which the probe would have reported as an unexplained status rather than reaching the auth check.
      headers: {
        accept: method === 'POST' ? 'application/json, text/event-stream' : 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, wwwAuthenticate: res.headers.get('www-authenticate') || '' };
  } finally { clearTimeout(t); }
}

/** Retry once with backoff — a single transient 5xx or reset must not page anyone. */
async function request(url, opts) {
  try {
    const r = await once(url, opts);
    if (r.status >= 500) {
      await sleep(RETRY_BACKOFF_MS);
      return await once(url, opts);
    }
    return r;
  } catch (err) {
    // Node reports a blocked redirect as TypeError('fetch failed') with the real reason on `.cause`
    // ('unexpected redirect') — measured, not assumed. Keying on `.message` alone silently mis-classified
    // a redirected profile as an unreachable one, i.e. reported "the probe could not run" for what is
    // actually a surface defect.
    const reason = `${(err && err.message) || ''} ${(err && err.cause && err.cause.message) || ''}`;
    if (/redirect/i.test(reason)) return { redirected: true, error: 'redirect' };
    await sleep(RETRY_BACKOFF_MS);
    try {
      return await once(url, opts);
    } catch (err2) {
      return { error: (err2 && err2.message) || String(err2) };
    }
  }
}

async function run({ base, timeoutMs, requireLive }) {
  const findings = [];
  const report = { status: 'pass', base, checked_at: new Date().toISOString(), pinned_version: UCP_SPEC_VERSION, profile: null, doors: [], findings };

  const prof = await request(`${base}/.well-known/ucp`, { timeoutMs });
  if (prof.redirected) {
    findings.push(fail('P8_PROFILE_REDIRECTED', 'the profile was reached through a redirect', { detail: `${base}/.well-known/ucp`, since: '#1989' }));
    report.status = 'fail';
    return report;
  }
  if (prof.error) {
    // Could not reach it at all — the PROBE could not run. Distinct from "it answered wrongly".
    findings.push(fail('PROBE_TRANSPORT_ERROR', 'the profile endpoint could not be reached', { detail: prof.error }));
    report.status = 'blocked';
    return report;
  }
  if (prof.status !== 200 || !prof.json) {
    // It answered, and answered wrongly. That is an OUTAGE of the surface, not a broken harness.
    findings.push(fail('P1_PROFILE_UNAVAILABLE', `/.well-known/ucp answered ${prof.status}${prof.json ? '' : ' with a non-JSON body'}`));
    report.status = 'fail';
    return report;
  }

  const { view, findings: profileFindings } = evaluateProfile(prof.json, { requireLive });
  findings.push(...profileFindings);
  report.profile = {
    shape: view.isSpecShape ? 'spec' : 'legacy',
    version: view.version,
    transports: view.transports,
    capabilities: view.capabilityIds,
    signing_key_ids: (view.signingKeysTopLevel || view.signingKeysNested || []).map((k) => k && k.kid),
  };

  for (const t of view.transports) {
    // Per-door isolation: one unreachable or malformed endpoint must not discard everything already found.
    let doorFindings = [];
    const entry = { endpoint: t.endpoint, transport: t.transport, status: null, resource_metadata: null, declares: null };
    try {
      const call = await request(t.endpoint, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, timeoutMs });
      const probe = { status: call.status, wwwAuthenticate: call.wwwAuthenticate, error: call.error };
      entry.status = call.status ?? null;
      const mdUrl = RESOURCE_METADATA.exec(String(call.wwwAuthenticate || ''))?.[1];
      if (mdUrl) {
        entry.resource_metadata = mdUrl;
        const md = await request(mdUrl, { timeoutMs });
        probe.metadataRedirected = Boolean(md.redirected);
        probe.metadata = md.json;
        probe.metadataStatus = md.redirected || md.error ? undefined : md.status;
        entry.declares = (md.json && md.json.resource) || null;
      }
      doorFindings = evaluateDoor(t.endpoint, probe);
    } catch (err) {
      doorFindings = [fail('P4_DOOR_UNREACHABLE', 'an advertised transport endpoint could not be probed', { detail: t.endpoint, since: '#1966' })];
    }
    findings.push(...doorFindings);
    entry.findings = doorFindings.length;
    report.doors.push(entry);
  }

  // P7 needs a real advertised capability to ask for. On a surface advertising none there is nothing to
  // intersect, and demanding the endpoint answer would report a second failure for the first one's reason.
  // Pick a ROOT capability, never a modifier. A modifier (UCP `extends`) is legitimately pruned by the
  // intersection when its target is not also negotiated, so requesting one and demanding it come back
  // would fail a correct surface — the false-positive twin of the gap P7 was widened to close.
  const isModifier = (id) => (Array.isArray(view.capabilityEntries[id]) ? view.capabilityEntries[id] : [])
    .some((e) => e && e.extends);
  const probeId = view.capabilityIds.find((id) => CAPABILITY_ID.test(String(id)) && !isModifier(id));
  const bogus = 'dev.ucp.shopping.definitely_not_a_capability';
  const requested = probeId ? [probeId, bogus] : [];
  if (requested.length) {
    const inter = await request(`${base}/ucp/capabilities`, { method: 'POST', body: { capabilities: requested }, timeoutMs });
    if (inter.error || inter.redirected) {
      findings.push(fail('P7_INTERSECTION_UNREACHABLE', 'the capability-intersection endpoint could not be reached'));
    } else if (inter.status !== 200) {
      findings.push(fail('P7_INTERSECTION_STATUS', `/ucp/capabilities answered ${inter.status}`));
    } else {
      const active = readActiveIds(inter.json);
      findings.push(...evaluateIntersection(view.capabilityIds, requested, active));
      report.intersection = { requested, active };
    }
  }

  report.status = findings.some((f) => f.level === 'FAIL') ? 'fail' : 'pass';
  return report;
}

function parseArgs(argv) {
  const out = { base: process.env.UCP_PROBE_BASE || DEFAULT_BASE, json: false, requireLive: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--allow-dark') out.requireLive = false;
    else if (a === '--base') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--base requires a URL');
      out.base = v; i += 1;
    } else throw new Error(`unknown argument: ${a}`);
  }
  out.base = String(out.base).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(out.base)) throw new Error(`--base must be an absolute http(s) URL, got ${out.base}`);
  return out;
}

function render(report) {
  const fails = report.findings.filter((f) => f.level === 'FAIL');
  const warns = report.findings.filter((f) => f.level === 'WARN');
  console.log(`UCP conformance probe — ${report.base}`);
  if (report.profile) {
    console.log(`  shape        ${report.profile.shape}`);
    console.log(`  version      ${report.profile.version} (build pins ${report.pinned_version})`);
    console.log(`  transports   ${report.profile.transports.map((t) => `${t.transport} ${t.endpoint}`).join(', ') || '(none)'}`);
    console.log(`  capabilities ${report.profile.capabilities.length}: ${report.profile.capabilities.join(', ') || '(none)'}`);
    console.log(`  signing keys ${report.profile.signing_key_ids.join(', ') || '(none)'}`);
  }
  for (const d of report.doors) {
    console.log(`  door ${d.endpoint} -> ${d.status}${d.declares ? ` | declares ${d.declares}` : ''}${d.findings ? '  <-- FINDING' : ''}`);
  }
  if (report.intersection) console.log(`  intersection requested ${report.intersection.requested.length} -> active ${JSON.stringify(report.intersection.active)}`);
  for (const f of report.findings) {
    console.log(`  ${f.level} ${f.code}${f.since ? ` (${f.since})` : ''}: ${f.message}${f.detail === undefined ? '' : ` — ${JSON.stringify(f.detail)}`}`);
  }
  console.log(report.status === 'pass' ? `PASS (${warns.length} warning(s))`
    : report.status === 'blocked' ? 'BLOCKED (the probe could not run)'
      : `FAIL (${fails.length} finding(s))`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // A bad invocation is a broken HARNESS, never a conformance failure — exit 2, not 1.
    console.error(`probe could not run: ${(err && err.message) || err}`);
    process.exit(2);
  }
  const timeoutMs = Number(process.env.UCP_PROBE_TIMEOUT_MS) > 0 ? Number(process.env.UCP_PROBE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  run({ base: args.base, timeoutMs, requireLive: args.requireLive }).then((report) => {
    // --json ALWAYS emits a parseable document, including on the blocked path. A pipeline that gets a parse
    // error exactly when something is wrong is worse than no pipeline.
    if (args.json) console.log(JSON.stringify({ ...report, ok: report.status === 'pass' }, null, 2));
    else render(report);
    process.exit(report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1);
  }).catch((err) => {
    const blocked = { status: 'blocked', base: args.base, error: (err && err.message) || String(err), findings: [], ok: false };
    if (args.json) console.log(JSON.stringify(blocked, null, 2));
    else console.error(`probe could not run: ${blocked.error}`);
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { readProfile, evaluateProfile, evaluateDoor, evaluateIntersection, readActiveIds, parseArgs, UCP_SPEC_VERSION };
